// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { searchMessages } from '../db/messages.js';
import type { MessageEventWithNetwork } from '../db/messages.js';
import { listReactionsToUser } from '../db/reactions.js';
import type { ReactionFeedItem } from '../db/reactions.js';

// The activity feed: everything that happened TO the user, newest first —
// highlights (lines a highlight rule matched) and other people's reactions to
// the user's own lines. Replies to the user will join the highlights side: a
// reply is a message row, stamped at insert the way a highlight is.
//
// Merged at read time from the two places that already own the state, rather
// than kept in an activity table of its own. A table would be a second copy
// of facts messages / message_reactions hold, and every path that changes them
// — retention, unreact, ignores, network delete, import — would have to keep
// it in step. It earns its place only once an item has state of its OWN (read,
// dismissed); until then there's nothing for it to hold that isn't a copy.
//
// Paging: each source keeps its own cursor, and the two lists are merged the
// way merge sort merges — always taking the later of the two heads — so each
// source is consumed strictly in its own order. That's what makes a per-source
// cursor safe. Sorting the combined page by time instead could consume a
// source out of its id order (a line's server-time can disagree with its
// insert order), and the cursor would then skip what it jumped over, for good.

export type ActivityItem =
  | (MessageEventWithNetwork & { kind: 'highlight' })
  | (ReactionFeedItem & { kind: 'reaction' });

export interface ActivityCursor {
  // The highlights side: a message id (searchMessages' `before`).
  beforeMessage?: number;
  // The reactions side: a reaction id (listReactionsToUser's `before`).
  beforeReaction?: number;
}

export interface ActivityFilters {
  query?: string;
  nicks?: string[];
  target?: string;
  networkId?: number;
}

export function listActivity(
  userId: number,
  filters: ActivityFilters,
  cursor: ActivityCursor,
  limit: number,
): { items: ActivityItem[]; next: ActivityCursor | null } {
  const highlights = searchMessages(userId, {
    matched: true,
    ...filters,
    before: cursor.beforeMessage,
    limit,
  });
  const reactions = listReactionsToUser(userId, {
    ...filters,
    before: cursor.beforeReaction,
    limit,
  });

  const items: ActivityItem[] = [];
  const next: ActivityCursor = { ...cursor };
  let h = 0;
  let r = 0;
  while (items.length < limit && (h < highlights.length || r < reactions.length)) {
    const hi = highlights[h];
    const re = reactions[r];
    // Ties go to the highlight: the line came before anyone could react to it.
    if (hi && (!re || hi.time >= re.time)) {
      items.push({ ...hi, kind: 'highlight' });
      next.beforeMessage = hi.id;
      h += 1;
    } else {
      items.push({ ...re, kind: 'reaction' });
      next.beforeReaction = re.reactionId;
      r += 1;
    }
  }

  // More exists if either side has fetched rows this page didn't take, or
  // filled its fetch (there may be older rows past it).
  const more =
    h < highlights.length ||
    r < reactions.length ||
    highlights.length === limit ||
    reactions.length === limit;
  return { items, next: more ? next : null };
}
