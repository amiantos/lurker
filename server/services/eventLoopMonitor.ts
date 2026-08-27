// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Event-loop stall detector. Watches how far behind schedule the loop runs; the
// lateness is the time the loop spent blocked in synchronous work (a heavy
// snapshot on slow storage, a big JSON.stringify, etc.). While the loop is
// blocked it services NO socket I/O, so a long enough stall stops us answering
// IRC server PINGs and trips irc-framework's ping/socket timeout on every live
// connection at once — the "loading the web UI reconnects all networks" failure
// mode. This surfaces those stalls so one can be correlated with a disconnect
// burst.
//
// Measurement uses Node's native `monitorEventLoopDelay` (a libuv/C++ delay
// histogram) rather than a JS `setInterval` drift: a JS timer is itself delayed
// by the very block it's trying to measure, so it UNDER-reports the worst stalls
// (exactly the ones that trip the ping timeouts). The native histogram records
// the true delta. We poll `.max` on a coarse interval purely to emit a
// timestamped per-window log line — the histogram alone gives no such stream.
//
// Console-only by design: the stall path is exactly when SQLite is busy, so it
// must never write to the DB (systemLog). Operators read it via `docker logs`.
// Cheap: the histogram samples in native code; the poll is one read per second.

import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';
import { envInt } from '../utils/envInt.js';

let timer: ReturnType<typeof setInterval> | null = null;
let histogram: IntervalHistogram | null = null;

function envFlag(name: string): boolean {
  return /^(1|true|yes|on)$/i.test((process.env[name] || '').trim());
}

// intervalMs: how often we poll the histogram for its window max. warnMs:
// minimum stall (max delay seen in a window) worth logging — below this is
// normal scheduler jitter, not a stall. context: what to append to the line —
// which subsystem's work is in flight — so the next report says where the time
// went, not just how long. Sampled at the poll, i.e. just AFTER the stall it
// reports (the stall itself is synchronous, so nothing can sample during it);
// a null/empty answer appends nothing, and a throw is swallowed — the monitor
// must never be the thing that fails on the stall path.
export function startEventLoopMonitor(
  opts: { intervalMs?: number; warnMs?: number; context?: () => string | null } = {},
): void {
  if (envFlag('LURKER_EVENT_LOOP_MONITOR_DISABLED')) return;
  if (timer) return;
  // Floor the poll interval so a misconfigured 0/tiny value can't turn into a
  // setInterval(0) hot loop; 100ms is plenty fine-grained for reporting the
  // multi-hundred-ms+ stalls we care about.
  const intervalMs = Math.max(
    100,
    opts.intervalMs ?? envInt('LURKER_EVENT_LOOP_MONITOR_INTERVAL_MS', 1000),
  );
  const warnMs = opts.warnMs ?? envInt('LURKER_EVENT_LOOP_MONITOR_WARN_MS', 500);
  histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  const h = histogram;
  timer = setInterval(() => {
    // `.max` is the largest delay (nanoseconds) observed since the last reset —
    // i.e. the worst stall in this window. Reset so the next window starts clean.
    const maxMs = Math.round(h.max / 1e6);
    h.reset();
    if (maxMs >= warnMs) {
      let context = '';
      if (opts.context) {
        try {
          const c = opts.context();
          if (c) context = `; ${c}`;
        } catch (_) {
          /* never let a describe() break the monitor */
        }
      }
      console.warn(
        `[event-loop] stalled ~${maxMs}ms — synchronous work blocked socket I/O ` +
          `(a stall past ~120s trips IRC ping timeouts; watch for a reconnect burst near this line)` +
          context,
      );
    }
  }, intervalMs);
  timer.unref();
}

export function stopEventLoopMonitor(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (histogram) {
    histogram.disable();
    histogram = null;
  }
}
