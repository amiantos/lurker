// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The two per-message stamps decided at insert time, factored out of
// ircConnection so they can be unit-tested without standing up a live IRC
// connection: the highlight match (matched_rule_id) and the ignore verdict
// (from_ignored, plus NOHIGHLIGHT's suppression of the highlight).

import { matchEvent, type CompiledRule } from './highlightEngine.js';
import { evaluateIgnores, type CompiledIgnoreRule } from './ignoreMatch.js';
import { COUNTABLE_TYPES } from '../db/messages.js';

type CompiledIgnore = CompiledIgnoreRule[];

export interface StampEvent {
  type: string;
  nick?: string | null;
  userhost?: string | null;
  target: string;
  text?: string | null;
  self?: boolean;
  // IRCv3 reply (#993): the line answers one of the owner's own — a highlight
  // with no rule behind it.
  replyToSelf?: boolean;
}

// Returns the matched_rule_id (null when no highlight, or when a NOHIGHLIGHT rule
// suppresses it), reply_to_self (the event's own flag, under the same NOHIGHLIGHT
// suppression) and from_ignored (true when a hide rule matches). A NOHIGHLIGHT
// rule deliberately leaves from_ignored false — the message stays visible and
// counted, it just never highlights.
export function decideStamp(
  event: StampEvent,
  highlightCompiled: CompiledRule[],
  ignoreCompiled: CompiledIgnore,
  isDm: boolean,
  now?: number,
): { matchedRuleId: number | null; replyToSelf: boolean; fromIgnored: boolean } {
  let matchedRuleId: number | null = null;
  let replyToSelf = !!event.replyToSelf && !event.self;
  const { matched, ruleId } = matchEvent(event, highlightCompiled);
  if (matched) matchedRuleId = ruleId;

  let fromIgnored = false;
  // from_ignored only feeds the countable-type queries (unread/highlight counts,
  // search) — and hiding of joins/parts/etc. is done client-side via the live
  // evaluate(), not from this stamp. So only evaluate ignores for the chat types
  // that actually read the column; this keeps high-churn JOIN/PART/QUIT/NICK off
  // the per-event ignore path entirely. Self/nick-less rows have no sender.
  if (ignoreCompiled.length && event.nick && !event.self && COUNTABLE_TYPES.has(event.type)) {
    const verdict = evaluateIgnores(
      ignoreCompiled,
      {
        nick: event.nick,
        userhost: event.userhost ?? null,
        target: event.target,
        text: event.text || '',
        type: event.type,
        isDm,
      },
      now,
    );
    if (verdict.nohilight) {
      matchedRuleId = null;
      replyToSelf = false;
    }
    fromIgnored = verdict.hide;
  }

  return { matchedRuleId, replyToSelf, fromIgnored };
}
