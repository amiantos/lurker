// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Per-peer rate limiter for RPE2E handshake traffic (a port of repartee's
// handshake.rs RateLimiter, deferred from the crypto-core PR to the manager
// layer where it belongs). Two limits:
//   - outgoing: a minimum 30s gap between KEYREQs to the same peer, so we don't
//     flood passive/offline nicks.
//   - incoming: max 3 KEYREQs per peer per 60s; exceeding that drops the peer
//     into a 5-minute backoff during which every further KEYREQ is rejected
//     WITHOUT any crypto work — cheap to reject a signature flood before the
//     expensive Ed25519 verify runs.
//
// `now` (epoch ms) is injectable so tests can drive the clock without sleeping.

const OUTGOING_GAP_MS = 30_000;
const INCOMING_WINDOW_MS = 60_000;
const INCOMING_MAX_PER_WINDOW = 3;
const INCOMING_BACKOFF_MS = 5 * 60_000;

interface IncomingBucket {
  /** Epoch-ms of recent KEYREQs (sliding 60s window). */
  recent: number[];
  /** When set, the peer is in backoff — reject all until this time. */
  backoffUntil: number | null;
}

export class RateLimiter {
  private lastSent = new Map<string, number>();
  private incoming = new Map<string, IncomingBucket>();
  private readonly now: () => number;
  private readonly maxKeys: number;

  // `maxKeys` caps each map so an attacker churning nicks can't allocate
  // unbounded buckets (the incoming bucket is created BEFORE signature
  // verification). Maps preserve insertion order, so eviction drops the oldest.
  constructor(now: () => number = Date.now, maxKeys = 50_000) {
    this.now = now;
    this.maxKeys = maxKeys;
  }

  private cap(map: Map<string, unknown>): void {
    while (map.size > this.maxKeys) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }

  /** True if sending a KEYREQ to `key` is allowed now; records the attempt. */
  allowOutgoing(key: string): boolean {
    const now = this.now();
    const ts = this.lastSent.get(key);
    if (ts !== undefined && now - ts < OUTGOING_GAP_MS) return false;
    this.lastSent.set(key, now);
    this.cap(this.lastSent);
    return true;
  }

  /** True if we should respond to an incoming KEYREQ from `key`. */
  allowIncoming(key: string): boolean {
    const now = this.now();
    let bucket = this.incoming.get(key);
    if (!bucket) {
      bucket = { recent: [], backoffUntil: null };
      this.incoming.set(key, bucket);
      this.cap(this.incoming);
    }
    if (bucket.backoffUntil !== null) {
      if (now < bucket.backoffUntil) return false;
      bucket.backoffUntil = null;
      bucket.recent = [];
    }
    // Evict entries older than the sliding window.
    bucket.recent = bucket.recent.filter((t) => now - t <= INCOMING_WINDOW_MS);
    if (bucket.recent.length >= INCOMING_MAX_PER_WINDOW) {
      bucket.backoffUntil = now + INCOMING_BACKOFF_MS;
      return false;
    }
    bucket.recent.push(now);
    return true;
  }
}
