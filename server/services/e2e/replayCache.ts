// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Replay protection — the seen-msgid LRU that closes a documented gap in the
// reference (issue #382 protocol note 1). AEAD prevents forgery, not replay:
// an on-path party (or the IRC server) can re-inject a captured `+RPE2E01`
// chunk within the ±ts-tolerance window and the receiver would decrypt and
// render it a second time. We track each chunk's identity — (context, sender,
// msgid, part) — for the length of the replay window and reject a repeat.
//
// Bounded: entries expire after `ttlMs` (slightly past the ts window) and the
// map is capped, evicting expired-then-oldest. `now` (epoch ms) is injectable.

export class ReplayCache {
  private seen = new Map<string, number>(); // key → expiry (epoch ms)
  private readonly maxEntries: number;
  private readonly now: () => number;

  // Generous default so a busy tenant's within-window traffic doesn't evict
  // another tenant's still-live entry under realistic load (the cap is a
  // backstop; window expiry does the real eviction).
  constructor(maxEntries = 100_000, now: () => number = Date.now) {
    this.maxEntries = maxEntries;
    this.now = now;
  }

  /**
   * Record `key` as seen for `ttlMs`. Returns `true` if it is fresh (first
   * sighting) or `false` if it is a live replay of an entry seen within the
   * window.
   */
  observe(key: string, ttlMs: number): boolean {
    const now = this.now();
    const expiry = this.seen.get(key);
    if (expiry !== undefined && expiry > now) return false; // live replay
    // Delete-then-set so a refreshed (expired) key moves to the end — keeping
    // Map insertion order aligned with expiry order under a constant ttl.
    if (expiry !== undefined) this.seen.delete(key);
    this.seen.set(key, now + ttlMs);
    this.evict(now);
    return true;
  }

  private evict(now: number): void {
    // Insertion order ≈ expiry order, so the expired entries are at the front;
    // stop at the first live one rather than scanning the whole map.
    for (const [k, exp] of this.seen) {
      if (exp > now) break;
      this.seen.delete(k);
    }
    // Backstop cap: drop oldest (soonest-to-expire) until back under the cap.
    while (this.seen.size > this.maxEntries) {
      const oldest = this.seen.keys().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
  }
}
