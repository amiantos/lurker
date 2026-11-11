// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { Router } from 'express';
import type { Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { callVerb } from '../services/verbRegistry.js';
// Registers the verb surface (idempotent — server.ts does the same import).
// Without it, a test that mounts only this router would find no verbs.
import '../services/verbs/index.js';

// GET /api/search — message search as a stateless REST read (#676).
//
// This is the same search_messages verb the WS `search` command and the MCP
// server call; the route adds nothing but transport. It exists because a WS
// verb is welded to the socket hub, while a URL is a request that can be
// abandoned: the statement runs off the event loop, in the search process
// (services/searchRunner.ts), and a superseded search-as-you-type request is
// dropped from its queue, or stopped mid-walk, the moment the client aborts it
// (there is no WS cancel frame — a stale WS search runs until the time limit
// and the reply is discarded). Also over the socket: result pages stop
// competing with the live IRC event stream for the socket's backpressure
// budget, and the response contract matches the highlights/bookmarks feeds
// (`{items, nextBefore}`) instead of making clients synthesize a cursor from
// `hasMore` plus the last row's id.
//
// The WS `search` command remains for compatibility but is deprecated — see
// docs/MIGRATION_SEARCH_REST.md.

const router = Router();
router.use(requireAuth);

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

// `nick` may arrive once (?nick=a) or repeated (?nick=a&nick=b → string[]).
// Normalized to a list so the feed OR-matches a friend's alts, same as
// /api/highlights.
function strArray(v: unknown): string[] | undefined {
  const arr = Array.isArray(v) ? v : v != null ? [v] : [];
  const out = arr.filter((x): x is string => typeof x === 'string' && !!x);
  return out.length ? out : undefined;
}

router.get('/', async (req: Request, res: Response) => {
  // A search-as-you-type client aborts superseded requests; if this one is
  // already gone, don't spend the query on it. This check is the cancellation
  // half of the REST argument — it has no WS equivalent.
  if (req.destroyed) return;
  // And if it goes while the search waits or runs, the search stops with it.
  const gone = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) gone.abort();
  });

  const rawLimit = Number(req.query.limit);
  const rawBefore = Number(req.query.before);
  const rawNetworkId = Number(req.query.networkId);

  let result: { messages: Array<{ id: number }>; hasMore: boolean };
  try {
    result = (await callVerb(
      'search_messages',
      { userId: req.user!.id, scope: 'read', transport: 'rest', signal: gone.signal },
      {
        query: str(req.query.q),
        networkId: Number.isFinite(rawNetworkId) && rawNetworkId > 0 ? rawNetworkId : undefined,
        target: str(req.query.target),
        nicks: strArray(req.query.nick),
        before: Number.isFinite(rawBefore) && rawBefore > 0 ? rawBefore : undefined,
        // The verb clamps to its own 1–100 range; only shield it from NaN.
        limit: Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : undefined,
      },
    )) as { messages: Array<{ id: number }>; hasMore: boolean };
  } catch (err) {
    const code = (err as { code?: string }).code;
    // Nobody is listening.
    if (code === 'search_aborted') return;
    if (code === 'search_timeout') {
      res.status(503).json({ error: 'search took too long' });
      return;
    }
    if (code === 'unknown_network') {
      res.status(404).json({ error: 'unknown network' });
      return;
    }
    if (code === 'invalid_input') {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
    throw err;
  }

  // Feed cursor contract (matches /api/highlights and /api/bookmarks): the id
  // of the page's oldest row when more matches exist, else null.
  const items = result.messages;
  const nextBefore = result.hasMore && items.length ? items[items.length - 1].id : null;
  res.json({ items, nextBefore });
});

export default router;
