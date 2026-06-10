// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Cross-connection outbound IRC (re)connect throttle. See issue #236.
//
// On a process (re)start the cell auto-connects every user's autoconnect
// networks in one synchronous burst (ircManager.initAll → startNetwork → a
// tight loop of conn.connect()). At cell density many of those land on the same
// IRC network (e.g. Libera) from one IP in the same tick — a burst of dozens of
// registrations that trips the server's registration-flood / per-IP throttle.
// That is bad-netizen behaviour, risks K-lines, and (because a connection that
// is refused before it registers gets NO auto-reconnect from irc-framework)
// can leave our own users silently disconnected until the next restart.
// irc-framework's per-connection backoff smooths ONE flapping link, not the
// herd, so this scheduler sits ABOVE the connections and spaces the cold-start
// / bulk-resume launches out.
//
// Model: a rate limiter, not a concurrency pool. We never await a connect's
// completion (the socket establishes asynchronously and may never register), so
// a true in-flight cap would leak slots. Instead we enforce a MINIMUM SPACING
// between successive launches — per destination host (the axis the remote
// throttles) plus a gentler global floor (so a 100-network cell doesn't fire
// 100 TLS handshakes in one tick and spike CPU on a small node). Each per-host
// wait gets random jitter so a synchronised herd de-synchronises.
//
// Defaults are effectively a no-op for a single-user standalone: the first
// launch to any given host fires immediately, and the global floor only spaces
// distinct hosts a few hundred ms apart. Only the 2nd+ launch to the SAME host
// within the window actually waits — which is exactly the cell-density case
// this protects.
//
// In-process and stateless across restarts by design: a restart is precisely
// when the throttle matters, so re-running cold-start from an empty scheduler
// is correct. No persistence, no worker threads.

export interface ConnectSchedulerOptions {
  // Minimum spacing between two launches to the SAME destination host.
  perHostMs?: number;
  // Random extra wait in [0, jitterMs) added to each per-host gate, so a herd
  // that arrived together doesn't reconverge on the same launch instants.
  jitterMs?: number;
  // Minimum spacing between ANY two launches regardless of host — caps the
  // TLS-handshake burst a small node sees on a fleet-wide cold start.
  globalMs?: number;
  // Bypass entirely: every task runs inline, synchronously, on schedule().
  disabled?: boolean;
  // Injectable clock + timer hooks (tests drive these deterministically).
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
  // Injectable jitter source in [0, 1) (tests pin it; production uses random).
  random?: () => number;
}

interface Task {
  hostKey: string;
  run: () => void;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function envFlag(name: string): boolean {
  return /^(1|true|yes|on)$/i.test((process.env[name] || '').trim());
}

export class ConnectScheduler {
  private readonly perHostMs: number;
  private readonly jitterMs: number;
  private readonly globalMs: number;
  private readonly disabled: boolean;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void;
  private readonly random: () => number;

  private readonly queue: Task[] = [];
  // Earliest timestamp a launch to this host is allowed (last launch + gate).
  private readonly hostNextAt = new Map<string, number>();
  // Earliest timestamp ANY launch is allowed (last launch + global floor).
  private globalNextAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: ConnectSchedulerOptions = {}) {
    this.perHostMs = opts.perHostMs ?? 0;
    this.jitterMs = opts.jitterMs ?? 0;
    this.globalMs = opts.globalMs ?? 0;
    this.disabled = opts.disabled ?? false;
    this.now = opts.now ?? (() => Date.now());
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h));
    this.random = opts.random ?? (() => Math.random());
  }

  // Build the singleton from env. Gentle defaults: 2s per-host base + up to 2s
  // jitter (so 2–4s between same-host connects), 150ms global floor.
  static fromEnv(): ConnectScheduler {
    return new ConnectScheduler({
      perHostMs: envInt('LURKER_CONNECT_THROTTLE_PER_HOST_MS', 2000),
      jitterMs: envInt('LURKER_CONNECT_THROTTLE_JITTER_MS', 2000),
      globalMs: envInt('LURKER_CONNECT_THROTTLE_GLOBAL_MS', 150),
      disabled: envFlag('LURKER_CONNECT_THROTTLE_DISABLED'),
    });
  }

  // Enqueue a connect launch keyed by destination host. The task itself owns
  // any revalidation (the connection may be torn down before its slot comes up)
  // — the scheduler only governs WHEN it runs, never WHETHER it still should.
  schedule(host: string, run: () => void): void {
    if (this.disabled) {
      run();
      return;
    }
    const hostKey = (host || '').trim().toLowerCase();
    const pendingForHost = this.queue.reduce((n, t) => (t.hostKey === hostKey ? n + 1 : n), 0);
    this.queue.push({ hostKey, run });
    if (pendingForHost > 0) {
      // At least one connect to this host is already waiting, so this one gets
      // spaced out behind it — surface the herd size so an operator can see the
      // throttle working on a dense restart ("staggering N connects to Libera").
      console.log(
        `[connect-scheduler] staggering outbound connects to ${hostKey || '(unknown)'} — ` +
          `${pendingForHost + 1} queued`,
      );
    }
    this.schedulePump();
  }

  pendingCount(): number {
    return this.queue.length;
  }

  // Drop everything pending and cancel the timer. Called on shutdown (queued
  // launches would otherwise fire against torn-down connections) and by tests.
  reset(): void {
    this.queue.length = 0;
    this.hostNextAt.clear();
    this.globalNextAt = 0;
    if (this.timer != null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }

  // (Re)arm the single pump timer for the soonest moment any queued task can
  // launch. Always recomputes from scratch (clearing any pending timer) so a
  // newly-scheduled connect to a fresh host isn't stranded behind an unrelated
  // host's far-future gate — e.g. a resume that lands mid-drain of an earlier
  // batch. The clear/re-arm cost is one timer swap per schedule(), negligible.
  private schedulePump(): void {
    if (this.timer != null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    if (this.queue.length === 0) return;
    const now = this.now();
    let soonest = Infinity;
    for (const task of this.queue) {
      const at = Math.max(this.globalNextAt, this.hostNextAt.get(task.hostKey) ?? 0);
      if (at < soonest) soonest = at;
      if (soonest <= now) break;
    }
    const delay = Math.max(0, soonest - now);
    this.timer = this.setTimer(() => this.pump(), delay);
  }

  private pump(): void {
    this.timer = null;
    if (this.queue.length === 0) return;
    const now = this.now();
    // Pick the FIFO-earliest task whose host AND the global floor are ready.
    // Scanning in arrival order keeps same-host launches in order and is fair
    // across users (one user's 20 networks don't jump ahead of another's).
    let pickIdx = -1;
    for (let i = 0; i < this.queue.length; i++) {
      const at = Math.max(this.globalNextAt, this.hostNextAt.get(this.queue[i].hostKey) ?? 0);
      if (at <= now) {
        pickIdx = i;
        break;
      }
    }
    if (pickIdx >= 0) {
      const [task] = this.queue.splice(pickIdx, 1);
      this.launch(task, now);
    }
    // Re-arm for the next eligible task (a launch just pushed both gates
    // forward, so the next pump naturally honours the global floor).
    this.schedulePump();
  }

  private launch(task: Task, now: number): void {
    const jitter = this.jitterMs > 0 ? Math.floor(this.random() * this.jitterMs) : 0;
    this.hostNextAt.set(task.hostKey, now + this.perHostMs + jitter);
    this.globalNextAt = now + this.globalMs;
    try {
      task.run();
    } catch (err) {
      console.error('[connect-scheduler] launch task threw', err);
    }
  }
}

// Process-wide singleton used by ircManager. Tests construct their own
// instances with injected clocks/config rather than poking this one.
const connectScheduler = ConnectScheduler.fromEnv();
export default connectScheduler;
