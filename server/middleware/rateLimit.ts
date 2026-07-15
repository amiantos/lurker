// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Rate limiting for the public auth surface (#568). Until this landed, Lurker had
// no HTTP throttling anywhere — the login endpoints (and the public, unauthenticated
// password->long-lived-token mint at POST /api/auth/login/token) accepted password
// guesses as fast as an attacker could open sockets. Two cooperating limiters, both
// keyed per client IP, in-memory, single-process:
//
//   - FailureThrottle — counts *failed* credential attempts. After N failures in a
//     window, further attempts are refused with 429 + Retry-After for a backoff
//     window, BEFORE any scrypt work runs. A successful auth clears the slate, so a
//     legitimate user who fat-fingers a password a few times is never locked out for
//     long, and a correct login is never throttled. This is the brute-force guard;
//     it generalizes the IRC bouncer's per-IP `authFailures` throttle
//     (services/bouncer.ts) — the one auth path that was already protected — to the
//     HTTP login path serving the same credentials.
//   - RequestThrottle — a coarse per-IP request cap across the whole auth surface
//     (options, invite probing, setup, auth-methods, ...), so the cheaper probe
//     endpoints can't be hammered for enumeration or flood.
//
// Behavior on trip is backoff, not lockout: a 429 with Retry-After that auto-clears
// once the window frees. A hard lockout is a self-DoS vector (an attacker can lock a
// real user out by failing on their behalf); backoff avoids that while still making
// online brute force impractical.
//
// Storage is in-memory per process — fine for a single-process cell and the
// single-process control-plane. A restart resets it, which is acceptable: an attacker
// who can force restarts has bigger levers. Both maps are capped so a spray of
// one-off failures from many distinct addresses can't grow them without bound.

import type { NextFunction, Request, Response } from 'express';
import { isNodeMode } from '../utils/edition.js';

// The header the control-plane injects carrying the true client IP. On hosted, every
// request reaches the cell through the CP proxy, which derives the real client IP
// from Cloudflare's CF-Connecting-IP at the edge and forwards exactly one trusted
// value here. We read it ONLY in node mode; in standalone an inbound copy would be
// caller-spoofable, so we never trust it there.
export const CLIENT_IP_HEADER = 'x-lurker-client-ip';

let warnedMissingClientIp = false;

function firstHeaderValue(v: string | string[] | undefined): string {
  const raw = Array.isArray(v) ? v[0] : v;
  return (raw ?? '').split(',')[0].trim();
}

// Resolve the per-client key for rate limiting, or null when we can't determine a
// trustworthy one. Returning null makes every caller fail OPEN — we NEVER collapse
// all clients onto one shared key, which would let a handful of bad attempts lock out
// the whole instance at once. That "bans everyone or nobody" footgun is exactly what
// #568 warns about behind a proxy.
export function clientIp(req: Request): string | null {
  if (isNodeMode()) {
    const fwd = firstHeaderValue(req.headers[CLIENT_IP_HEADER]);
    if (fwd) return fwd;
    // Missing in node mode means a CP/edge misconfiguration, not a direct client.
    // Warn once and fail open rather than throttle every tenant on one shared key.
    if (!warnedMissingClientIp) {
      warnedMissingClientIp = true;
      console.warn(
        `[lurker] node mode but no ${CLIENT_IP_HEADER} header on auth requests — ` +
          `auth rate limiting is disabled until the proxy sets it`,
      );
    }
    return null;
  }
  // Standalone: the socket peer is the client (or the operator's own reverse proxy).
  // Honor X-Forwarded-For's first hop only when the operator explicitly opts in via
  // LURKER_TRUST_PROXY — an internet-exposed instance must not trust a spoofable
  // header by default, or an attacker just rotates a fake XFF to dodge the limit.
  if (process.env.LURKER_TRUST_PROXY === 'true') {
    const xff = firstHeaderValue(req.headers['x-forwarded-for']);
    if (xff) return xff;
  }
  return req.socket.remoteAddress ?? null;
}

// ---------------------------------------------------------------------------
// Failure throttle — counts failed credential attempts per key.
// ---------------------------------------------------------------------------

export interface FailureThrottleConfig {
  /** Sliding window over which failures accumulate toward the trip threshold. */
  windowMs: number;
  /** Failures within the window that trip the backoff. */
  maxFailures: number;
  /** How long a tripped key stays blocked (the Retry-After horizon). */
  backoffMs: number;
  /** Cap on tracked keys so distinct-IP sprays can't grow the map unbounded. */
  maxKeys?: number;
}

interface FailureEntry {
  /** Epoch-ms of recent failures inside the sliding window. */
  fails: number[];
  /** Epoch-ms until which the key is blocked; 0 when not blocked. */
  blockedUntil: number;
}

export class FailureThrottle {
  private entries = new Map<string, FailureEntry>();
  private readonly now: () => number;
  private readonly maxKeys: number;

  // `now` is injectable so tests can drive the clock without sleeping (mirrors
  // services/e2e/rateLimiter.ts).
  constructor(
    private readonly cfg: FailureThrottleConfig,
    now: () => number = Date.now,
  ) {
    this.now = now;
    this.maxKeys = cfg.maxKeys ?? 10_000;
  }

  /**
   * Seconds the caller must wait if `key` is currently blocked, else null (allowed).
   * A key whose block has elapsed is cleared here, so the next attempt starts fresh.
   */
  retryAfter(key: string): number | null {
    const entry = this.entries.get(key);
    if (!entry || entry.blockedUntil === 0) return null;
    const now = this.now();
    if (now >= entry.blockedUntil) {
      this.entries.delete(key);
      return null;
    }
    return Math.ceil((entry.blockedUntil - now) / 1000);
  }

  /** Record a failed attempt; trips the backoff once the threshold is reached. */
  recordFailure(key: string): void {
    const now = this.now();
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { fails: [], blockedUntil: 0 };
      this.entries.set(key, entry);
      this.cap();
    }
    entry.fails = entry.fails.filter((t) => now - t < this.cfg.windowMs);
    entry.fails.push(now);
    if (entry.fails.length >= this.cfg.maxFailures) {
      entry.blockedUntil = now + this.cfg.backoffMs;
      entry.fails = [];
    }
  }

  /** A successful auth clears the key's failure history entirely. */
  reset(key: string): void {
    this.entries.delete(key);
  }

  private cap(): void {
    if (this.entries.size <= this.maxKeys) return;
    // First sweep entries that are neither blocked nor holding live failures.
    const now = this.now();
    for (const [k, e] of this.entries) {
      const stale = e.fails.length === 0 || now - e.fails[e.fails.length - 1] >= this.cfg.windowMs;
      if (e.blockedUntil === 0 && stale) this.entries.delete(k);
    }
    // If still over (an all-active flood), evict oldest — Maps keep insertion order.
    while (this.entries.size > this.maxKeys) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /** Test hook. Production never calls this. */
  clear(): void {
    this.entries.clear();
  }
}

// ---------------------------------------------------------------------------
// Request throttle — coarse per-key request cap (sliding window).
// ---------------------------------------------------------------------------

export interface RequestThrottleConfig {
  windowMs: number;
  maxRequests: number;
  maxKeys?: number;
}

export class RequestThrottle {
  private hits = new Map<string, number[]>();
  private readonly now: () => number;
  private readonly maxKeys: number;

  constructor(
    private readonly cfg: RequestThrottleConfig,
    now: () => number = Date.now,
  ) {
    this.now = now;
    this.maxKeys = cfg.maxKeys ?? 10_000;
  }

  /** True if a request from `key` is allowed now; records it. Retry-After in `retry`. */
  allow(key: string): { ok: true } | { ok: false; retryAfter: number } {
    const now = this.now();
    let recent = this.hits.get(key);
    if (!recent) {
      recent = [];
      this.hits.set(key, recent);
      this.cap();
    }
    const cutoff = now - this.cfg.windowMs;
    recent = recent.filter((t) => t > cutoff);
    this.hits.set(key, recent);
    if (recent.length >= this.cfg.maxRequests) {
      // Retry-After = time until the oldest in-window hit ages out.
      const retryAfter = Math.max(1, Math.ceil((recent[0] + this.cfg.windowMs - now) / 1000));
      return { ok: false, retryAfter };
    }
    recent.push(now);
    return { ok: true };
  }

  private cap(): void {
    if (this.hits.size <= this.maxKeys) return;
    const cutoff = this.now() - this.cfg.windowMs;
    for (const [k, ts] of this.hits) {
      if (ts.length === 0 || ts[ts.length - 1] <= cutoff) this.hits.delete(k);
    }
    while (this.hits.size > this.maxKeys) {
      const oldest = this.hits.keys().next().value;
      if (oldest === undefined) break;
      this.hits.delete(oldest);
    }
  }

  clear(): void {
    this.hits.clear();
  }
}

// ---------------------------------------------------------------------------
// Express middleware.
// ---------------------------------------------------------------------------

/**
 * Guard a credential-verifying route (password / passkey / token login, password
 * change). Pre-checks the failure throttle and, if the key is in backoff, returns
 * 429 + Retry-After BEFORE the handler runs any scrypt work. Otherwise it hooks the
 * response: a 401 counts as a failed attempt, a 2xx clears the slate. Counting off
 * the final status means we never have to instrument every failure branch inside the
 * handler, and 400s (malformed input, not a credential guess) correctly don't count.
 *
 * Fails open when the client key can't be trusted (see clientIp).
 */
export function guardCredentialAttempt(throttle: FailureThrottle) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = clientIp(req);
    if (key === null) {
      next();
      return;
    }
    const retry = throttle.retryAfter(key);
    if (retry !== null) {
      res.set('Retry-After', String(retry));
      res.status(429).json({ error: 'too many attempts — try again later' });
      return;
    }
    res.on('finish', () => {
      if (res.statusCode === 401) throttle.recordFailure(key);
      else if (res.statusCode >= 200 && res.statusCode < 300) throttle.reset(key);
    });
    next();
  };
}

/** Coarse per-IP request cap for a whole router. Fails open on an untrusted key. */
export function limitRequests(throttle: RequestThrottle) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = clientIp(req);
    if (key === null) {
      next();
      return;
    }
    const verdict = throttle.allow(key);
    if (!verdict.ok) {
      res.set('Retry-After', String(verdict.retryAfter));
      res.status(429).json({ error: 'too many requests — slow down' });
      return;
    }
    next();
  };
}

// ---------------------------------------------------------------------------
// The wired-up limiters for the auth surface.
// ---------------------------------------------------------------------------

// Mirror the IRC bouncer's tuning (10 failures / 15 min) for the credential guard,
// with a 15-minute backoff once tripped.
export const LOGIN_FAILURE_MAX = 10;

export const loginFailureThrottle = new FailureThrottle({
  windowMs: 15 * 60_000,
  maxFailures: LOGIN_FAILURE_MAX,
  backoffMs: 15 * 60_000,
});

// A generous blanket over the whole auth router — real UI flows fire only a handful
// of requests, so 60/min/IP is invisible to users but caps enumeration/flood.
export const authRequestThrottle = new RequestThrottle({
  windowMs: 60_000,
  maxRequests: 60,
});

/** Reset all auth-surface limiters. Test hook (integration tests reuse one process). */
export function resetAuthRateLimits(): void {
  loginFailureThrottle.clear();
  authRequestThrottle.clear();
}
