// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import type { Request, Response } from 'express';
import { searchErrorResponse } from '../services/searchRunner.js';

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

// Aborted when the client stopped waiting for `res` (it closed before the
// response was finished): what a search still waiting or running for that
// request stops on (services/searchRunner.ts).
export function goneSignal(res: Response): AbortSignal {
  const gone = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) gone.abort();
  });
  return gone.signal;
}

// Answer a feed request whose search did not return rows. True if `err` was
// the search runner's and has been dealt with; false for anything else, which
// is the caller's to throw.
export function sendFeedError(res: Response, gone: AbortSignal, err: unknown): boolean {
  if ((err as { code?: string } | null)?.code === 'search_aborted') {
    // Its client went, or a newer request of theirs displaced it.
    if (!res.writableEnded && !gone.aborted) res.status(503).json({ error: 'search superseded' });
    return true;
  }
  const refused = searchErrorResponse(err);
  if (!refused) return false;
  res.status(refused.status).json({ error: refused.error });
  return true;
}
