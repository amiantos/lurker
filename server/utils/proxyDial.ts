// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// One connected, tunnelled, PLAINTEXT socket to an IRC server, via a SOCKS5 or
// HTTP CONNECT proxy (#303).
//
// TLS is deliberately the caller's job. Both callers — the app's own transport
// and the engine's upstream — already know how to wrap a socket, and they know
// different things about SNI, `rejectUnauthorized` and the client certificate.
// Handing back a plain socket keeps each of those rules in exactly one place.
//
// ⚠⚠ THE RULE THIS FILE EXISTS TO KEEP: the destination host is never resolved
// here. It crosses the wire as a NAME and the proxy resolves it. Resolve it
// locally and a Tor user's DNS lookups name every server they talk to, `.onion`
// stops working entirely, and the feature becomes theatre. `socks` gets this
// right on its own; the HTTP half below is ours, and the one line that would
// break it (a "normalise the host" convenience) would look harmless.
//
// The SOCKS5 half is `socks` (PROXY_PLAN.md §0): it already does remote
// resolution, the variable-length bound-address read, split-read buffering,
// auth negotiation and the deadline. What is ours is the translation and, above
// all, turning its failures into something a user can act on. The HTTP CONNECT
// half is ours entirely — no library, and it is where the remaining traps live.

import net from 'node:net';
import { SocksClient } from 'socks';
import type { ProxyConfig } from '../../shared/proxy.js';
import { describeProxy } from '../../shared/proxy.js';

/** Stable codes, so a caller can branch without matching on prose. */
export const PROXY_ERROR = {
  /** The proxy itself could not be reached (refused, no route, DNS). */
  UNREACHABLE: 'PROXY_UNREACHABLE',
  /** The proxy wants credentials, or rejected the ones given. */
  AUTH: 'PROXY_AUTH',
  /** The proxy was reached and refused to open the tunnel. */
  REFUSED: 'PROXY_REFUSED',
  /** Nothing completed inside the dial budget. */
  TIMEOUT: 'PROXY_TIMEOUT',
  /** The peer is not speaking the protocol we asked for. */
  PROTOCOL: 'PROXY_PROTOCOL',
} as const;

export type ProxyErrorCode = (typeof PROXY_ERROR)[keyof typeof PROXY_ERROR];

export class ProxyDialError extends Error {
  constructor(
    readonly code: ProxyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProxyDialError';
  }
}

export interface ProxyDialOptions {
  /** Source address for the app→proxy hop — the only hop we have a local
   *  address for, and still our egress interface. */
  localAddress?: string;
  /** Covers the WHOLE thing: TCP to the proxy plus the greet/auth/connect
   *  exchange. The caller passes its existing dial budget; this does not add
   *  to it.
   *
   *  ⚠ There is deliberately no abort signal. `socks` takes none, so only half
   *  the surface could honour one, and a caller that gives up mid-dial has to
   *  handle the socket arriving late anyway — both callers do (see
   *  ProxyTransport.dialAbandoned and EngineUpstream's abandoned check). An
   *  abandoned tunnel is destroyed when the dial settles; until then it costs
   *  one fd for the remainder of this budget. */
  deadlineMs: number;
}

// `socks` reports a rejection as an Error whose message ends in the reply code's
// symbolic name (`... - HostUnreachable`, socksclient.js:638). That is the one
// brittle seam in taking the dependency, so it is isolated to this table and
// pinned by a test per code: a `socks` upgrade that reworded them fails there
// rather than in a user's system buffer.
const SOCKS5_REPLY_PROSE: Record<string, { code: ProxyErrorCode; text: string }> = {
  Failure: { code: PROXY_ERROR.REFUSED, text: 'the proxy reported a general failure' },
  NotAllowed: {
    code: PROXY_ERROR.REFUSED,
    text: "the proxy's rules do not allow a connection to that address",
  },
  NetworkUnreachable: { code: PROXY_ERROR.REFUSED, text: 'the proxy has no route to that network' },
  HostUnreachable: { code: PROXY_ERROR.REFUSED, text: 'the proxy could not reach that host' },
  ConnectionRefused: {
    code: PROXY_ERROR.REFUSED,
    text: 'the connection was refused by the server the proxy dialled',
  },
  TTLExpired: { code: PROXY_ERROR.REFUSED, text: 'the connection expired inside the proxy' },
  CommandNotSupported: {
    code: PROXY_ERROR.PROTOCOL,
    text: 'the proxy does not support outbound connections',
  },
  AddressNotSupported: {
    code: PROXY_ERROR.PROTOCOL,
    text: 'the proxy rejected the address type',
  },
};

/** Node's connect-time failures, which reach us through `socks` too. */
function osErrorProse(err: NodeJS.ErrnoException): { code: ProxyErrorCode; text: string } | null {
  switch (err.code) {
    case 'ECONNREFUSED':
      return { code: PROXY_ERROR.UNREACHABLE, text: 'nothing is listening there' };
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return {
        code: PROXY_ERROR.UNREACHABLE,
        text: "the proxy's own address could not be resolved",
      };
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return { code: PROXY_ERROR.UNREACHABLE, text: 'there is no route to it' };
    case 'ETIMEDOUT':
      return { code: PROXY_ERROR.TIMEOUT, text: 'it did not answer' };
    case 'ECONNRESET':
    case 'EPIPE':
      return { code: PROXY_ERROR.PROTOCOL, text: 'it closed the connection' };
    default:
      return null;
  }
}

function socksProse(err: unknown): { code: ProxyErrorCode; text: string } {
  const message = err instanceof Error ? err.message : String(err);
  const os = osErrorProse((err ?? {}) as NodeJS.ErrnoException);
  if (os) return os;
  // ⚠ `socks` does not re-throw the OS error. Its handler is
  // `closeSocket(err.message)` (socksclient.js:362), which flattens the failure
  // to TEXT and drops `.code` — so a refused proxy arrives as an Error reading
  // "connect ECONNREFUSED 127.0.0.1:1080" with no code to branch on. Without
  // this, every unreachable proxy fell through to the generic "did not answer
  // as a SOCKS5 proxy", which points the user at the wrong thing entirely.
  const embedded = /\b(E[A-Z]{2,})\b/.exec(message);
  if (embedded) {
    const byText = osErrorProse({ code: embedded[1] } as NodeJS.ErrnoException);
    if (byText) return byText;
  }
  for (const [name, prose] of Object.entries(SOCKS5_REPLY_PROSE)) {
    // Anchored on the ` - Name` suffix `socks` appends, not a bare substring:
    // "ConnectionRefused" would otherwise also match inside other text.
    if (message.endsWith(` - ${name}`)) return prose;
  }
  if (/authentication/i.test(message)) {
    return { code: PROXY_ERROR.AUTH, text: 'it rejected the username and password' };
  }
  if (/no accepted auth|unknown auth/i.test(message)) {
    return {
      code: PROXY_ERROR.AUTH,
      text: 'it wants an authentication method Lurker cannot provide (only username/password is supported)',
    };
  }
  if (/timed out/i.test(message)) return { code: PROXY_ERROR.TIMEOUT, text: 'it did not answer' };
  if (/socket closed|closed/i.test(message)) {
    return { code: PROXY_ERROR.PROTOCOL, text: 'it closed the connection mid-handshake' };
  }
  return { code: PROXY_ERROR.PROTOCOL, text: 'it did not answer as a SOCKS5 proxy' };
}

// Anything that could break out of an HTTP request line or header. SOCKS5 is
// length-prefixed and immune, but this module is one exported function and the
// caller does not pick which half runs.
// oxlint(no-control-regex) is disabled deliberately: matching control
// characters is the whole point — they are what breaks a request line.
// eslint-disable-next-line no-control-regex
const UNSAFE_IN_REQUEST = /[\s\u0000-\u001f\u007f]/;

/** Open a tunnel to `dest` through `proxy`. Resolves with a connected plaintext
 *  socket; rejects with a ProxyDialError and never with a bare library error. */
export async function dialThroughProxy(
  proxy: ProxyConfig,
  dest: { host: string; port: number },
  opts: ProxyDialOptions,
): Promise<net.Socket> {
  // ⚠ Checked HERE, at the point of use, not left to whoever built the config.
  // `validateProxy` already rejects these in the proxy's own fields, but
  // `dest.host` is the NETWORK's host — and that is only checked for being
  // non-empty (routes/networks.ts), so a CR/LF in it reaches the CONNECT
  // request line and injects into it. Self-inflicted on a personal instance;
  // not so on one where the proxy belongs to the admin. This function is
  // exported, so it defends itself rather than trusting its callers.
  if (UNSAFE_IN_REQUEST.test(dest.host)) {
    throw new ProxyDialError(
      PROXY_ERROR.PROTOCOL,
      `"${dest.host}" is not a usable server address to ask a proxy for`,
    );
  }
  if (
    UNSAFE_IN_REQUEST.test(proxy.username ?? '') ||
    UNSAFE_IN_REQUEST.test(proxy.password ?? '')
  ) {
    throw new ProxyDialError(PROXY_ERROR.AUTH, 'the proxy credentials contain unusable characters');
  }
  return proxy.type === 'socks5'
    ? dialSocks5(proxy, dest, opts)
    : dialHttpConnect(proxy, dest, opts);
}

async function dialSocks5(
  proxy: ProxyConfig,
  dest: { host: string; port: number },
  opts: ProxyDialOptions,
): Promise<net.Socket> {
  try {
    const { socket } = await SocksClient.createConnection({
      command: 'connect',
      proxy: {
        host: proxy.host,
        port: proxy.port,
        type: 5,
        // `socks` only offers the username/password method when one of these is
        // set, which is what we want: a proxy that needs no auth must not be
        // told we can authenticate.
        ...(proxy.username ? { userId: proxy.username } : {}),
        ...(proxy.password ? { password: proxy.password } : {}),
      },
      // ⚠ VERBATIM. See the header. `socks` sends a name as ATYP 0x03 and only
      // uses 0x01/0x04 for something already an IP literal, so the resolution
      // happens at the proxy — but only for as long as nobody "helpfully"
      // normalises this line.
      destination: { host: dest.host, port: dest.port },
      timeout: opts.deadlineMs,
      ...(opts.localAddress
        ? {
            socket_options: {
              // host/port are restated only because `SocketConnectOpts` requires
              // them; `socks` overwrites both with the proxy's own before
              // connecting (socksclient.js:270), so these values are the ones
              // it would use anyway.
              host: proxy.host,
              port: proxy.port,
              localAddress: opts.localAddress,
              // Binding a source address fixes the family, or a dual-stack
              // proxy host whose lookup answers the other family first fails
              // with `bind EINVAL` — the same pairing every other dial in
              // Lurker makes.
              family: net.isIP(opts.localAddress) || undefined,
            },
          }
        : {}),
    });
    return socket;
  } catch (err) {
    const { code, text } = socksProse(err);
    throw new ProxyDialError(code, `the SOCKS5 proxy at ${describeProxy(proxy)}: ${text}`);
  }
}

// The largest header block we will read before giving up. A CONNECT response is
// a status line and a handful of headers; anything past this is not a proxy
// answering us, and reading without a bound lets a hostile peer grow the buffer
// forever.
const MAX_CONNECT_RESPONSE = 16 * 1024;

async function dialHttpConnect(
  proxy: ProxyConfig,
  dest: { host: string; port: number },
  opts: ProxyDialOptions,
): Promise<net.Socket> {
  const where = `the HTTP proxy at ${describeProxy(proxy)}`;
  const socket = net.connect({
    host: proxy.host,
    port: proxy.port,
    ...(opts.localAddress
      ? { localAddress: opts.localAddress, family: net.isIP(opts.localAddress) || undefined }
      : {}),
  });

  return new Promise<net.Socket>((resolve, reject) => {
    let settled = false;
    let buf: Buffer = Buffer.alloc(0);

    const timer = setTimeout(() => {
      fail(new ProxyDialError(PROXY_ERROR.TIMEOUT, `${where}: it did not answer`));
    }, opts.deadlineMs);
    // The dial budget must not hold a process open on its own.
    timer.unref?.();

    const cleanup = () => {
      clearTimeout(timer);
      socket.removeListener('connect', onConnect);
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
    };

    function fail(err: ProxyDialError) {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(err);
    }

    /** Hand the socket over with any pipelined tunnel bytes intact.
     *
     *  ⚠⚠ Three things here are load-bearing, and each was a bug first.
     *
     *  1. `cleanup()` BEFORE the unshift. `unshift` re-emits 'data'
     *     synchronously; with onData still attached it re-reads the same header
     *     block, finds the same terminator and unshifts again — a synchronous
     *     loop that pins the event loop so hard nothing else runs, timers
     *     included. It presents as a hang with no stack and no timeout,
     *     because the timeout cannot fire either.
     *  2. `pause()` before the unshift. Our 'data' listener put the socket in
     *     flowing mode; removing it does not undo that, so anything arriving
     *     before the caller attaches its own listener is read and DISCARDED.
     *  3. `resume()` on a setImmediate, not now. The caller attaches its
     *     handlers in the continuation of this promise; resuming here would
     *     race them. This is exactly what `socks` does after 'established'
     *     (socksclient.js:258), so both protocols hand back a socket in the
     *     same state.
     *
     *  `unshift` rather than `emit('data', rest)` — which is what `socks` uses
     *  — because unshifted bytes sit in the read buffer, and `setEncoding()`
     *  called later by the caller converts them. An emitted Buffer would reach
     *  a caller that had asked for strings as a Buffer. */
    function done(rest: Buffer) {
      if (settled) return;
      settled = true;
      cleanup();
      socket.pause();
      if (rest.length) socket.unshift(rest);
      setImmediate(() => socket.resume());
      resolve(socket);
    }

    function onConnect() {
      // HTTP/1.0, as WeeChat sends: a tunnel has no use for `Host:` or
      // keep-alive semantics, and 1.0 is what every CONNECT proxy has spoken
      // since before either existed.
      //
      // ⚠ dest.host goes in verbatim — this line is the HTTP half of the rule
      // in the header.
      // ⚠ An IPv6 literal needs brackets or the request line is an unparseable
      // authority — `CONNECT 2001:db8::1:6697` — and the proxy answers with
      // something opaque. This is not "normalising the host" (the rule in the
      // header): the bytes still name exactly what we were given.
      const target = net.isIPv6(dest.host)
        ? `[${dest.host}]:${dest.port}`
        : `${dest.host}:${dest.port}`;
      const lines = [`CONNECT ${target} HTTP/1.0`];
      if (proxy.username) {
        const basic = Buffer.from(`${proxy.username}:${proxy.password || ''}`).toString('base64');
        lines.push(`Proxy-Authorization: Basic ${basic}`);
      }
      socket.write(lines.join('\r\n') + '\r\n\r\n');
    }

    function onData(chunk: Buffer) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      // ⚠ Read until the header block ENDS, not until "some bytes arrived".
      // WeeChat does a single recv and checks byte 9 (core-network.c:454),
      // which fails whenever the status line is split across segments — the
      // one thing in its implementation not to copy.
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) {
        if (buf.length > MAX_CONNECT_RESPONSE) {
          fail(
            new ProxyDialError(
              PROXY_ERROR.PROTOCOL,
              `${where}: it did not answer as an HTTP proxy`,
            ),
          );
        }
        return;
      }
      const head = buf.subarray(0, end).toString('latin1');
      // ⚠⚠ Everything past the blank line belongs to the TUNNEL: a proxy may
      // deliver the ircd's first line in the same TCP segment as its own 200.
      // Push it back, or a `NOTICE AUTH` — or the `001` — is silently eaten,
      // and it reproduces only against real proxies.
      const rest = buf.subarray(end + 4);

      const status = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(head);
      if (!status) {
        fail(
          new ProxyDialError(PROXY_ERROR.PROTOCOL, `${where}: it did not answer as an HTTP proxy`),
        );
        return;
      }
      const code = Number(status[1]);
      if (code === 407) {
        fail(
          new ProxyDialError(
            PROXY_ERROR.AUTH,
            proxy.username
              ? `${where}: it rejected the username and password`
              : `${where}: it requires a username and password`,
          ),
        );
        return;
      }
      if (code < 200 || code > 299) {
        // The reason phrase is the proxy's own words about why, and it is
        // routinely the most useful thing on screen ("Forbidden",
        // "Host not found"). Bounded, because it is remote text.
        const reason = head.split('\r\n')[0].slice(0, 200);
        fail(new ProxyDialError(PROXY_ERROR.REFUSED, `${where} refused the connection: ${reason}`));
        return;
      }
      done(rest);
    }

    function onError(err: NodeJS.ErrnoException) {
      const os = osErrorProse(err);
      fail(
        new ProxyDialError(
          os?.code ?? PROXY_ERROR.UNREACHABLE,
          `${where}: ${os?.text ?? err.message}`,
        ),
      );
    }

    function onClose() {
      fail(
        new ProxyDialError(
          PROXY_ERROR.PROTOCOL,
          `${where}: it closed the connection mid-handshake`,
        ),
      );
    }

    socket.once('connect', onConnect);
    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
  });
}
