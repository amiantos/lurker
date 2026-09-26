// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { parseIrcFormatting } from './nickColor.js';

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

// A character that can't continue a nick — MessageInput's NOT_NICK_CHAR, so
// `bob_: hi` is not addressing bob, and `bobł: hi` is not either.
const NOT_NICK_CHAR = '[^\\p{L}\\p{N}\\s_\\[\\]\\\\`^{|}-]';

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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
