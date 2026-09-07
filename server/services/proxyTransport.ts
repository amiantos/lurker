// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Dial path A: the app's own socket, through a proxy (#303).
//
// irc-framework's net transport builds its own socket, so this subclasses it and
// overrides `connect()` alone. Everything that makes a transport work —
// `writeLine`, the line framing in `onSocketData`, `disposeSocket`, `close`,
// `setEncoding`, and every event the Connection listens for — is inherited
// untouched.
//
// ⚠ irc-framework HAS a `socks` option, and it is deliberately unused. It is
// SOCKS5-only (`type: 5` is hardcoded), has no HTTP CONNECT, and silently drops
// `outgoing_addr` on its proxied branch — and it would give the engine nothing,
// since the engine dials in another process entirely. Going through
// `utils/proxyDial.ts` means one dial module, one set of error messages, and
// one place where the destination is kept as a NAME, shared by both dial paths.
//
// ⚠ Subclassing an unpublished internal is a real cost. It is paid deliberately
// (the alternative is reimplementing the framing) and covered by
// proxyTransport.test.ts, which pins the base-class members this relies on so an
// irc-framework bump breaks a test rather than someone's connection.

import net from 'node:net';
import tls from 'node:tls';
import NetTransport from 'irc-framework/src/transports/net.js';
import { dialThroughProxy, ProxyDialError } from '../utils/proxyDial.js';
import type { ProxyConfig } from '../../shared/proxy.js';

// irc-framework's own dial budget, matched so a proxied connection gives up on
// the same schedule as a direct one.
const DEFAULT_DIAL_TIMEOUT_MS = 150_000;

// The transport's own state enum, which is module-private in the source. Only
// CONNECTING is needed here — `_onSocketCreate` sets CONNECTED itself.
const SOCK_CONNECTING = 1;

export class ProxyTransport extends NetTransport {
  /** Set when close()/disposeSocket() arrives while a dial is still in flight.
   *  Without it an aborted connect would resolve into an orphan socket nobody
   *  owns: the base class's `close()` starts with `if (!this.socket) return`,
   *  and during a proxy dial there is no socket for it to find. */
  private dialAbandoned = false;

  override connect(): void {
    const options = this.options as {
      host: string;
      port: number;
      tls?: boolean;
      ssl?: boolean;
      encoding?: string;
      rejectUnauthorized?: boolean;
      outgoing_addr?: string;
      proxy?: ProxyConfig;
      client_certificate?: { certificate: string; private_key: string };
    };
    const proxy = options.proxy;
    if (!proxy) {
      // Nothing to do here — dial exactly as the base class would. Reachable if
      // a network's proxy is cleared without the Client being rebuilt.
      super.connect();
      return;
    }

    this.debugOut('connect() through a proxy');
    // The same reset the base class opens with. Skipping any of it leaves bytes
    // from the previous socket at the head of the new one's line buffer.
    this.disposeSocket();
    this.requested_disconnect = false;
    this.dialAbandoned = false;
    this.incoming_buffer = Buffer.from('');
    if (!options.encoding || !this.setEncoding(options.encoding)) this.setEncoding('utf8');
    this.state = SOCK_CONNECTING;

    const useTls = !!(options.tls || options.ssl);
    void dialThroughProxy(
      proxy,
      { host: options.host, port: options.port || 6667 },
      {
        localAddress: options.outgoing_addr,
        deadlineMs: DEFAULT_DIAL_TIMEOUT_MS,
      },
    )
      .then((tunnel) => {
        if (this.dialAbandoned) {
          tunnel.destroy();
          return;
        }
        // SNI only for a name — an IP literal is not a valid server name. Same
        // rule the base transport and the engine both apply.
        const servername = net.isIP(options.host) ? undefined : options.host;
        const socket: net.Socket = useTls
          ? tls.connect({
              socket: tunnel,
              servername,
              rejectUnauthorized: options.rejectUnauthorized,
              key: options.client_certificate?.private_key,
              cert: options.client_certificate?.certificate,
            })
          : tunnel;
        this.socket = socket;
        // ⚠ Synchronously, in this continuation. The tunnelled socket is paused
        // and resumes itself on a setImmediate (see proxyDial), which is late
        // enough for the listeners `_onSocketCreate` binds here — but only
        // because they are bound now rather than a tick later.
        this._onSocketCreate(this.options, socket);
      })
      .catch((err: unknown) => {
        if (this.dialAbandoned) return;
        // Through the base class's own error path, so a proxy failure closes
        // the connection exactly the way a refused TCP connect does: it records
        // `last_socket_error` and the 'close' handler reports it. Anything else
        // would leave the Client waiting for a socket that will never open.
        const wrapped =
          err instanceof ProxyDialError ? err : new Error(`proxy dial failed: ${String(err)}`);
        this.onSocketError(wrapped);
        this.state = 0;
        this.emit('close', wrapped);
      });
  }

  override close(force?: boolean): void {
    // Marked before delegating: the base class returns early when there is no
    // socket, which during a proxy dial is exactly the case that needs saying.
    this.dialAbandoned = true;
    super.close(force);
  }

  override disposeSocket(): void {
    this.dialAbandoned = true;
    super.disposeSocket();
  }
}

export default ProxyTransport;
