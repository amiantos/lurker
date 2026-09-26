// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { parseIrcFormatting } from './nickColor.js';
import { escapeRegex } from '../../../shared/textMatch.js';

// Text helpers for IRCv3 replies (#993), shared by the reply line above a
// message (MessageList) and the pending-reply segment (StatusBar).

// The answered line as one line of plain text: formatting codes dropped, line
// breaks folded to spaces. Callers clip it to width with CSS.
export function replyExcerpt(text: string): string {
  return parseIrcFormatting(text)
    .map((run) => run.text)
    .join('')
    .replace(/\s*\n+\s*/g, ' ')
    .trim();
}

// A character that cannot continue a nick, which is what "punctuation after
// the nick" has to mean when telling `nick: hi` from a line that just opens
// with a word: not a letter or digit (Unicode — `\w` is ASCII-only, so `bobł`
// would read as bob + a mark), not whitespace, and not one of the RFC 2812 nick
// specials `[]\`_^{|}-` — or `bob_: hi` would count as addressing bob, and bob_
// is every ghost's nick. The one definition: the composer's address matching
// (MessageInput) and the reply display's (stripReplyAddress) must agree on it.
export const NOT_NICK_CHAR = '[^\\p{L}\\p{N}\\s_\\[\\]\\\\`^{|}-]';

// A reply's text without the `nick: ` it opens with when it names the author it
// answers — how halloy and goguma send one, and how our composer does, so a
// client without replies still sees who it's for. The reply line above already
// names them. Only a nick followed by punctuation counts: a reply to `will`
// saying "will you come?" keeps its first word. Never strips to nothing.
export function stripReplyAddress(text: string, nick: string): string {
  if (!nick) return text;
  const re = new RegExp(`^${escapeRegex(nick)}${NOT_NICK_CHAR}+\\s+`, 'iu');
  const stripped = text.replace(re, '');
  return stripped || text;
}
