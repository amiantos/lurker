// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// irc-framework's ping timeout, made to tell a dead link from a stalled event
// loop (#1074).
//
// The library arms a timer for `ping_timeout` seconds on connect and re-arms it
// on every line read; when it fires, it QUITs. After a long synchronous stall
// that timer is wrong about the link. libuv runs expired timers BEFORE it polls
// sockets, so when the loop comes back the timeout fires while the server's
// lines from the stall are still sitting unread in the socket. Deferring the
// check by a setImmediate doesn't help either (the immediate ran before the
// read in the probe that settled this). In #1070 a two-minute stall closed and
// redialed all 17 of a user's networks, every one of them healthy.
//
// So the timer measures itself. A timer that fires more than STALL_LATE_MS past
// its deadline was held up by the loop — the same test the engine link's
// heartbeat uses (engineLink.ts) — and its silence is ours, not the server's.
// Then it sends a PING and waits one reply window: any line read in that window
// re-arms the full timeout, and only a window that passes in silence QUITs.
// A timer that fires on time QUITs at once, as the library's does.
//
// Installed per Client, over the library's own method: irc-framework calls
// `client.startPingTimeoutTimer()` on 'socket connected' and
// `client.resetPingTimeoutTimer()` for every line it dispatches, through the
// instance, so an own property replaces both. The timers go through
// `client.connection.setTimeout`, like the library's, so a closing connection
// clears them with the rest. stallAwarePingTimeout.test.ts pins those members.

import { performance } from 'node:perf_hooks';
import type { Client as IrcClient } from 'irc-framework';

/** How late a timer must fire to count as held up by the loop: the event-loop
 *  monitor's line between scheduler jitter and a stall (eventLoopMonitor.ts). */
export const STALL_LATE_MS = 500;

export interface StallAwarePingOptions {
  /** How long the probe PING has to get a line back. */
  probeMs: number;
  /** The timer fired `lateMs` past its deadline; a probe is on its way. */
  onSuspect?(lateMs: number): void;
  /** A line arrived while a probe was out: the link is alive. */
  onAlive?(): void;
}

// The library members this relies on, untyped in the shim.
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

export const STALL_PROBE_TOKEN = 'lurker-stall-probe';

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
    let probing = false;

    const arm = (ms: number) => {
      client.connection.clearTimeout(timer);
      deadline = performance.now() + ms;
      timer = client.connection.setTimeout(fire, ms);
    };

    function fire() {
      const lateMs = performance.now() - deadline;
      if (lateMs >= STALL_LATE_MS) {
        // Probing again if the probe's own window was stalled through: its
        // silence is no more the server's than the first one was.
        probing = true;
        opts.onSuspect?.(Math.round(lateMs));
        try {
          client.ping(STALL_PROBE_TOKEN);
        } catch (_) {
          /* a write that can't go is the close below, one window later */
        }
        arm(opts.probeMs);
        return;
      }
      // What the library's own timeout does (client.js startPingTimeoutTimer).
      const seconds = String(client.options.ping_timeout);
      (client as unknown as IrcClient).emit('ping timeout');
      client.connection.end(client.rawString('QUIT', `Ping timeout (${seconds} seconds)`), true);
    }

    client.resetPingTimeoutTimer = () => {
      if (probing) {
        probing = false;
        opts.onAlive?.();
      }
      arm(timeoutMs);
    };
    client.resetPingTimeoutTimer();
  };
}
