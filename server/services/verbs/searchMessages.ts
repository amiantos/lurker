// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { registerVerb } from '../verbRegistry.js';
import { searchMessages } from '../../db/messages.js';
import { decorateMessage } from '../wsHub.js';

/** Authenticated caller context passed to every verb handler. */
interface VerbContext {
  userId: number;
  scope: string;
}

registerVerb({
  name: 'search_messages',
  description:
    "Full-text search across the caller's message history. Returns matches newest-first; paginate by passing the lowest id as `before`.",
  scope: 'read',
  input: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'Free-text query. Multiple whitespace-separated terms are ANDed together. Optional when at least one structured filter (networkId/target/nick) is provided — filter-only searches return matches without an FTS pass.',
      },
      networkId: {
        type: 'integer',
        description:
          'Optional. Restrict the search to a single network. Omit to search every network the caller owns.',
      },
      target: {
        type: 'string',
        description: 'Optional. Restrict to a single buffer target (channel name or peer nick).',
      },
      nick: {
        type: 'string',
        description: 'Optional. Restrict to messages from a specific nick.',
      },
      limit: {
        type: 'integer',
        description: 'How many matches to return. Default 50, max 100.',
        minimum: 1,
        maximum: 100,
      },
      before: {
        type: 'integer',
        description: 'Optional. Return only matches with id < before, for backward pagination.',
      },
    },
    additionalProperties: false,
  },
  handler(ctx: VerbContext, input: Record<string, unknown>) {
    const limit = Math.min(Math.max(Number(input.limit) || 50, 1), 100);
    // Fetch one extra row to know whether more matches exist without a second
    // FTS scan. The bare `results.length === limit` heuristic the WS code
    // used for years produces a false-positive when the total match count is
    // exactly `limit`; recent_messages was fixed the same way during the
    // Phase 2 extraction.
    const rows = searchMessages(ctx.userId, {
      query: typeof input.query === 'string' ? input.query : '',
      networkId: input.networkId ? Number(input.networkId) : undefined,
      target: typeof input.target === 'string' && input.target ? input.target : undefined,
      nick: typeof input.nick === 'string' && input.nick ? input.nick : undefined,
      before: input.before ? Number(input.before) : undefined,
      limit: limit + 1,
    });
    const hasMore = rows.length > limit;
    const messages = (hasMore ? rows.slice(0, limit) : rows).map((e) =>
      decorateMessage(ctx.userId, e),
    );
    return { messages, hasMore };
  },
});
