// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Event-loop stall detector. A single unref'd 1s timer measures how late it
// fires relative to its scheduled interval; the lateness is the time the loop
// spent blocked in synchronous work (a heavy snapshot on slow storage, a big
// JSON.stringify, etc.). While the loop is blocked it services NO socket I/O,
// so a long enough stall stops us answering IRC server PINGs and trips
// irc-framework's ping/socket timeout on every live connection at once — the
// "loading the web UI reconnects all networks" failure mode. This makes those
// stalls visible so a stall can be correlated with a disconnect burst.
//
// Console-only by design: the stall path is exactly when SQLite is busy, so it
// must never write to the DB (systemLog) itself. Operators read it via
// `docker logs`. Cheap: one comparison per second, silent unless a stall is
// seen.

let timer: ReturnType<typeof setInterval> | null = null;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function envFlag(name: string): boolean {
  return /^(1|true|yes|on)$/i.test((process.env[name] || '').trim());
}

// intervalMs: how often we sample. warnMs: minimum lateness (over the interval)
// worth logging — below this is normal scheduler jitter, not a stall.
export function startEventLoopMonitor(opts: { intervalMs?: number; warnMs?: number } = {}): void {
  if (envFlag('LURKER_EVENT_LOOP_MONITOR_DISABLED')) return;
  if (timer) return;
  const intervalMs = opts.intervalMs ?? envInt('LURKER_EVENT_LOOP_MONITOR_INTERVAL_MS', 1000);
  const warnMs = opts.warnMs ?? envInt('LURKER_EVENT_LOOP_MONITOR_WARN_MS', 500);
  let last = Date.now();
  timer = setInterval(() => {
    const now = Date.now();
    // Drift = actual elapsed minus scheduled elapsed = time the loop was blocked
    // and couldn't run this callback on schedule.
    const drift = now - last - intervalMs;
    last = now;
    if (drift >= warnMs) {
      console.warn(
        `[event-loop] stalled ~${drift}ms — synchronous work blocked socket I/O ` +
          `(a stall past ~120s trips IRC ping timeouts; watch for a reconnect burst near this line)`,
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
}
