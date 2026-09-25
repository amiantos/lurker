// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import type { Request } from 'express';

// The filter + page-size params the highlights and activity feeds share: the
// from:/in:/on: + free-text filter (`nick` / `target` / `networkId` / `q`) the
// search modal parses, and a capped `limit`. Cursors differ per feed and are
// each route's own business.

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

export function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

// `nick` may arrive once (?nick=a) or repeated (?nick=a&nick=b → string[]).
// Normalize to a non-empty list so the feed can OR-match a friend's alts.
export function strArray(v: unknown): string[] | undefined {
  const arr = Array.isArray(v) ? v : v != null ? [v] : [];
  const out = arr.filter((x): x is string => typeof x === 'string' && !!x);
  return out.length ? out : undefined;
}

export function positiveInt(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export function feedFilters(req: Request) {
  return {
    query: str(req.query.q),
    nicks: strArray(req.query.nick),
    target: str(req.query.target),
    networkId: positiveInt(req.query.networkId),
  };
}

export function feedLimit(req: Request): number {
  const n = positiveInt(req.query.limit);
  return n ? Math.min(n, MAX_LIMIT) : DEFAULT_LIMIT;
}
