// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Fetching a channel's ban, exception, invite-exception or quiet list for the
// channel modal and the get_mode_list verb (#727).
//
// The query goes out through the reply router with a ModeListCollector as its
// asker, the same slot an attached IRC client takes. So the router hands it
// exactly the lines that answer it (the entries, the end, and an error naming
// the channel), and those lines render nowhere: the server buffer shows only
// the user's replies, and the bouncer relays only a client's own. A `/mode
// #chan +b` the user types is the user's, and still prints.
//
// Numerics (the letter is fixed by the numeric, except 728, which names it):
//   367 <me> <chan> <mask> [<setter> [<ts>]]            bans           end 368
//   348 <me> <chan> <mask> [<setter> [<ts>]]            exceptions     end 349
//   346 <me> <chan> <mask> [<setter> [<ts>]]            invite-exc.    end 347
//   728 <me> <chan> <letter> <mask> [<setter> [<ts>]]   quiets         end 729
// A 367 can arrive with only the mask, or mask and setter (weechat tests all
// three shapes). A non-op asking for +e or +I gets 482 instead of a list
// (irssi servers-redirect.c), which ends the query like any other error.
//
// ⚠ Known limit, from how the router works: an error naming the channel goes
// to the oldest query on the wire that could take it, and MODE *changes*,
// KICK and TOPIC aren't tracked (a change that changes nothing gets no reply,
// so there is nothing to end one on). So a 482 for an untracked command sent
// just before this query — the modal's own `MODE #c +b mask` — is taken as
// this list's refusal, and the user's error row for it is lost. The modal
// therefore patches an open list from live MODE ±b rather than refetching
// right after a change.

import type { ReplyClient } from './replyRouter.js';
import { unixSecondsToIso } from '../utils/unixTime.js';

export interface ModeListEntry {
  mask: string;
  /** Who set it, as the server gives it: a nick or a full `nick!user@host`. */
  setBy: string | null;
  /** When (ISO), or null when the server didn't say. */
  setAt: string | null;
}

export type ModeListResult =
  | { ok: true; entries: ModeListEntry[] }
  | {
      ok: false;
      // 'refused': the server answered with an error numeric (482, 403, …).
      // 'no-reply': nothing came before the router's timeout, or the socket went.
      // The others are decided before anything is sent.
      error:
        | 'refused'
        | 'no-reply'
        | 'not-connected'
        | 'not-a-channel'
        | 'not-a-list-mode'
        | 'unsupported-list-mode';
      numeric?: string;
      text?: string;
    };

export class ModeListCollector implements ReplyClient {
  private readonly entries: ModeListEntry[] = [];
  private readonly seen = new Set<string>();
  private done = false;

  constructor(
    private readonly numerics: { item: string; end: string },
    private readonly finish: (result: ModeListResult) => void,
  ) {}

  /** Every line the router says is this query's, in order (ReplyClient.onReply). */
  onReply(command: string, params: readonly string[]): void {
    if (this.done) return;
    if (command === this.numerics.item) {
      const at = command === '728' ? 3 : 2;
      const mask = params[at];
      if (!mask) return;
      // Some servers send a non-op the same scrubbed mask twice (irssi
      // mode-lists.c). Masks match case-insensitively.
      const key = mask.toLowerCase();
      if (this.seen.has(key)) return;
      this.seen.add(key);
      this.entries.push({
        mask,
        setBy: params[at + 1] || null,
        setAt: unixSecondsToIso(params[at + 2]),
      });
      return;
    }
    if (command === this.numerics.end) {
      this.settle({ ok: true, entries: this.entries });
      return;
    }
    // Anything else the router gives this query is an error that ended it: the
    // one naming the channel (482, 403, 442), or one naming MODE (461, 421).
    // After an error a server may still send the end numeric; `done` drops it.
    this.settle({ ok: false, error: 'refused', numeric: command, text: params.at(-1) });
  }

  // Only a client's `MODE #chan` is ever answered from cache.
  replyFromCache(): void {}

  // The query ended with no reply: it timed out, or the socket went.
  replyAborted(): void {
    this.settle({ ok: false, error: 'no-reply' });
  }

  private settle(result: ModeListResult): void {
    if (this.done) return;
    this.done = true;
    this.finish(result);
  }
}
