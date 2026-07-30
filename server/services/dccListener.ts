// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// DCC listening-socket allocator (#270 phase 2). Active outgoing DCC — a SEND
// offer, a CHAT offer, or the reverse leg of a passive receive — needs Lurker to
// accept ONE inbound TCP connection on a port a peer can reach, then hand the
// socket off to the sender/chat/receiver engine. This module owns that: it binds
// a one-shot server on a free port from the operator-configured range
// (LURKER_DCC_LISTEN_PORT_MIN.._MAX, which must be firewall-open + Docker-
// published), resolves with the first accepted socket, and auto-closes on a
// timeout so an unanswered offer can't pin a port open forever.
//
// The range doubles as the concurrency cap: no free port means no new offer.
// Deliberately IRC-free and DB-free — the caller advertises the port and owns
// the transfer/session row; this just produces a socket or a clean failure.

import net from 'net';

import { dccListenBindHost, dccListenPortRange } from './dccConfig.js';

// Ports currently bound by a live listener. A port is reserved the instant its
// server starts listening and released when the listener closes, so two
// concurrent offers never collide on one port.
const inUse = new Set<number>();

/** Currently-open listener count — exposed for the concurrency guard + tests. */
export function activeDccListenerCount(): number {
  return inUse.size;
}

// Tests reset between cases; production never calls this.
export function resetDccListeners(): void {
  inUse.clear();
}

export interface DccListenHandle {
  /** The bound port — advertise this to the peer. */
  port: number;
  /** Resolves with the first inbound socket (server closed to further conns at
   *  that point), or rejects on timeout / bind failure / close(). */
  accepted: Promise<net.Socket>;
  /** Tear down: stop listening, release the port, and reject `accepted` if still
   *  pending. Idempotent — safe to call after the socket was already handed off. */
  close(): void;
}

export interface DccListenOptions {
  /** Auto-close + reject if no peer connects within this window. */
  timeoutMs?: number;
  /** When set, only accept a connection whose remote address matches this host
   *  (the peer we made the offer to, learned from its ident/host or a passive
   *  reply). A mismatch is dropped and we keep waiting — hardening against a
   *  third party racing to grab an advertised port. Null disables the check. */
  expectPeerHost?: string | null;
}

// Collapse IPv4-mapped IPv6 (::ffff:1.2.3.4) so a dual-stack listener's reported
// remote address compares equal to a plain-IPv4 expectation.
function normalizeAddr(addr: string | undefined): string {
  if (!addr) return '';
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(addr);
  return m ? m[1] : addr;
}

/**
 * Bind a one-shot DCC listener on a free port from the configured range.
 * Rejects immediately when no range is configured or every port is in use.
 * The returned handle's `port` is ready to advertise the moment this resolves.
 */
export function openDccListener(opts: DccListenOptions = {}): Promise<DccListenHandle> {
  const range = dccListenPortRange();
  if (!range) {
    return Promise.reject(new Error('DCC active listening is not configured'));
  }
  const bind = dccListenBindHost();
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const expect = opts.expectPeerHost ? normalizeAddr(opts.expectPeerHost) : null;

  // Candidate ports: the whole range minus what's already bound, tried from a
  // rotating start so concurrent offers don't all probe the same low port first.
  const free: number[] = [];
  for (let p = range.min; p <= range.max; p++) if (!inUse.has(p)) free.push(p);
  if (free.length === 0) {
    return Promise.reject(new Error('no free DCC port (all listeners in use)'));
  }
  const start = free.length > 1 ? free[0] + (Date.now() % free.length) : free[0];
  const ordered = free.slice(free.indexOf(Math.min(start, free[free.length - 1])));
  const candidates = ordered.length ? ordered.concat(free) : free;

  return new Promise<DccListenHandle>((resolveHandle, rejectHandle) => {
    let idx = 0;

    const tryNext = (): void => {
      // Skip ports another listener grabbed while we were probing.
      while (idx < candidates.length && inUse.has(candidates[idx])) idx++;
      if (idx >= candidates.length) {
        rejectHandle(new Error('no free DCC port could be bound'));
        return;
      }
      const port = candidates[idx++];
      const server = net.createServer();
      let settled = false; // the `accepted` promise's fate
      let acceptResolve!: (s: net.Socket) => void;
      let acceptReject!: (e: Error) => void;
      const accepted = new Promise<net.Socket>((res, rej) => {
        acceptResolve = res;
        acceptReject = rej;
      });
      // A pending promise with no catcher would log an unhandled rejection if
      // close() fires before anyone awaits; swallow it — close() is the signal.
      accepted.catch(() => {});

      let timer: ReturnType<typeof setTimeout> | null = null;
      const release = (): void => {
        inUse.delete(port);
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      };

      const handle: DccListenHandle = {
        port,
        accepted,
        close: () => {
          if (!settled) {
            settled = true;
            acceptReject(new Error('DCC listener closed'));
          }
          release();
          try {
            server.close();
          } catch {
            /* already closing */
          }
        },
      };

      server.on('error', (err: NodeJS.ErrnoException) => {
        // EADDRINUSE: the OS holds this port (another process / TIME_WAIT) even
        // though our set didn't. Try the next candidate rather than failing.
        release();
        try {
          server.close();
        } catch {
          /* ignore */
        }
        if (err.code === 'EADDRINUSE' && idx < candidates.length) {
          tryNext();
        } else if (!settled) {
          settled = true;
          acceptReject(err);
          rejectHandle(err);
        }
      });

      server.on('connection', (sock: net.Socket) => {
        if (settled) {
          sock.destroy();
          return;
        }
        if (expect && normalizeAddr(sock.remoteAddress) !== expect) {
          // Not the peer we offered to — drop it and keep waiting for the right
          // one (until the timeout). One-shot semantics still hold: we only
          // *resolve* once, for a matching peer.
          sock.destroy();
          return;
        }
        settled = true;
        release();
        // One connection only: stop accepting further dials on this port.
        try {
          server.close();
        } catch {
          /* ignore */
        }
        acceptResolve(sock);
      });

      server.listen(port, bind, () => {
        inUse.add(port);
        timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          acceptReject(new Error('DCC offer timed out — peer never connected'));
          release();
          try {
            server.close();
          } catch {
            /* ignore */
          }
        }, timeoutMs);
        timer.unref?.();
        resolveHandle(handle);
      });
    };

    tryNext();
  });
}
