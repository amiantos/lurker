// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// irc-framework's ping timeout, made to ask before it closes (#1074).
//
// The library arms a timer for `ping_timeout` seconds on connect and re-arms it
// on every line read; when it fires, it QUITs. After a long synchronous stall
// that timer is wrong about the link. libuv runs expired timers BEFORE it polls
// sockets, so when the loop comes back the timeout fires while the server's
// lines from the stall still sit unread in the socket. Deferring the check by a
// setImmediate doesn't help either: after a stall in the poll or check phase
// the immediate also runs before the read. In #1070 a two-minute stall closed
// and redialed all 17 of a user's networks, every one of them healthy.
//
// So the timeout sends a PING and waits one reply window before it QUITs. Any
// line read in that window re-arms the full timeout. That holds whatever the
// stall's shape. A lateness test alone (did the timer fire well past its
// deadline?) misses a stall that ends just after the deadline, and any probe
// after a long stall is answered at once by the lines already waiting. The
// cost is the window: a server that really went silent closes that much later.
//
// A window whose own timer fired late was stalled through too, so its silence
// proves nothing either: it probes again, up to MAX_PROBES, then QUITs, so a
// dead server on a loop that keeps stalling still gets closed.
//
// Installed per Client, over the library's own method: irc-framework calls
// `client.startPingTimeoutTimer()` on 'socket connected' and
// `client.resetPingTimeoutTimer()` for every line it dispatches, through the
// instance, so an own property replaces both. The timers go through
// `client.connection.setTimeout`, like the library's, so a closing connection
// clears them with the rest. stallAwarePingTimeout.test.ts drives a real
// Client, so it fails if the library stops calling through the instance.

import { performance } from 'node:perf_hooks';
import type { Client as IrcClient } from 'irc-framework';

/** How late a probe window's timer must fire to count as stalled through:
 *  well past scheduler jitter. */
export const STALL_LATE_MS = 500;
/** Probes per silence: the first, plus a re-probe for each window that was
 *  stalled through. */
export const MAX_PROBES = 3;
export const STALL_PROBE_TOKEN = 'lurker-stall-probe';

export interface StallAwarePingOptions {
  /** How long a probe PING has to get a line back. Read per probe. */
  probeMs(): number;
  /** A probe is on its way. `lateMs`: how far past its deadline the timer
   *  fired, which says how long the loop was stalled at the end. */
  onProbe?(lateMs: number): void;
  /** A line arrived while a probe was out. */
  onAlive?(): void;
}

// The library internals this relies on; the typings shim covers only the
// public surface.
interface PingInternals {
  options: { ping_timeout: number };
  connection: {
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(timer: unknown): void;
    end(data: string, hadError: boolean): void;
  };
  rawString(...args: string[]): string;
  ping(message?: string): void;
  startPingTimeoutTimer(): void;
  resetPingTimeoutTimer(): void;
}

export function installStallAwarePingTimeout(
  ircClient: IrcClient,
  opts: StallAwarePingOptions,
): void {
  const client = ircClient as unknown as PingInternals;
  client.startPingTimeoutTimer = function startPingTimeoutTimer() {
    const timeoutMs = client.options.ping_timeout * 1000;
    if (!(timeoutMs > 0)) return;
    let timer: unknown = null;
    let deadline = 0;
    let probes = 0;

    const arm = (ms: number) => {
      client.connection.clearTimeout(timer);
      deadline = performance.now() + ms;
      timer = client.connection.setTimeout(fire, ms);
    };

    function fire() {
      const lateMs = Math.max(0, Math.round(performance.now() - deadline));
      if (probes === 0 || (probes < MAX_PROBES && lateMs >= STALL_LATE_MS)) {
        probes++;
        opts.onProbe?.(lateMs);
        try {
          client.ping(STALL_PROBE_TOKEN);
        } catch (_) {
          /* a write that can't go is the close below, one window later */
        }
        arm(opts.probeMs());
        return;
      }
      // What the library's own timeout does (client.js startPingTimeoutTimer).
      const seconds = String(client.options.ping_timeout);
      (client as unknown as IrcClient).emit('ping timeout');
      client.connection.end(client.rawString('QUIT', `Ping timeout (${seconds} seconds)`), true);
    }

    client.resetPingTimeoutTimer = () => {
      if (probes > 0) {
        probes = 0;
        opts.onAlive?.();
      }
      arm(timeoutMs);
    };
    client.resetPingTimeoutTimer();
  };
}
