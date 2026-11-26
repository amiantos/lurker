// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// IRC target case-folding, per the server-declared ISUPPORT CASEMAPPING (#707).
//
// Four values exist in the wild. The folds:
//
//   ascii           A-Z → a-z, nothing else
//   rfc1459         ascii plus [ \ ] ^ → { | } ~  (the RFC 2812 default)
//   rfc1459-strict  ascii plus [ \ ]   → { | }    (no ^/~ pairing)
//   rfc7613         full Unicode (Ergo and friends)
//
// ⚠ The ^/~ DIRECTION is the trap. RFC 2812's prose says "{}|^ are the lower
// case equivalents of []\~" — i.e. ~ is uppercase and folds to ^. Every ircd
// tolower table (and irc-framework, whose upper-ASCII bound for rfc1459 is 94
// '^') does the OPPOSITE: the lowercase run is a-z{|}~, 32 above A-Z[\]^, so
// ^ folds DOWN to ~. We match the implementations, not the prose — they are
// what the servers we fold against actually run. Lurker's issue #707 quotes
// the prose direction; this comment is the correction.
//
// rfc7613 folds with JS toLowerCase() — the same rule as the legacy/undeclared
// fold below, not PRECIS. Real PRECIS enforcement lives server-side (the
// network rejects names it considers confusable); our fold only has to agree
// with itself, and toLowerCase() is the closest approximation that keeps
// existing target_folded rows (all built with toLowerCase) stable.

/** The CASEMAPPING values we understand, normalized. */
export type Casemapping = 'ascii' | 'rfc1459' | 'rfc1459-strict' | 'rfc7613';

/**
 * Parse a raw ISUPPORT CASEMAPPING token. Returns undefined for anything
 * unrecognized (including absent) — an unknown mapping is NOT stored, so the
 * network keeps the legacy fold rather than adopting a rule we can't
 * implement. 'strict-rfc1459' is irc-framework's spelling of the ISUPPORT
 * draft's 'rfc1459-strict'; both appear in the wild.
 */
export function normalizeCasemapping(raw: unknown): Casemapping | undefined {
  if (typeof raw !== 'string') return undefined;
  switch (raw.trim().toLowerCase()) {
    case 'ascii':
      return 'ascii';
    case 'rfc1459':
      return 'rfc1459';
    case 'rfc1459-strict':
    case 'strict-rfc1459':
      return 'rfc1459-strict';
    case 'rfc7613':
    case 'utf8':
      return 'rfc7613';
    default:
      return undefined;
  }
}

// Fold-to-lowercase upper bounds, per the bound-based scheme above:
// everything in [65, bound] is uppercase and folds +32.
const UPPER_BOUND: Record<Casemapping, number> = {
  ascii: 90, // 'Z'
  'rfc1459-strict': 93, // ']'
  rfc1459: 94, // '^'
  rfc7613: 0, // handled as toLowerCase(), never bound-folded
};

/**
 * Fold a target to lowercase under `mapping`. null/undefined (no mapping
 * declared or stored) and rfc7613 use the legacy rule — Unicode
 * toLowerCase(), which is what every pre-#707 target_folded row was built
 * with, so an undeclared network's registry never churns.
 */
export function foldTargetWith(mapping: Casemapping | null | undefined, target: string): string {
  if (mapping == null || mapping === 'rfc7613') return target.toLowerCase();
  const bound = UPPER_BOUND[mapping];
  let out = '';
  for (let i = 0; i < target.length; i++) {
    const c = target.charCodeAt(i);
    out += c >= 65 && c <= bound ? String.fromCharCode(c + 32) : target[i];
  }
  return out;
}
