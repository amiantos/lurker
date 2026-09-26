// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// IRCv3 replies (client-tags/reply, #993): the shape a reply's context rides a
// message row in, shared by the server (which resolves it) and the client
// (which draws the line above the reply).

// How much of the answered line's text rides along. The client shows one
// clipped line of it, so anything past a screen's width is wire weight.
export const REPLY_EXCERPT_MAX = 300;

// The line a reply answers, as found by its msgid in the reply's own buffer.
export interface ReplyParent {
  id: number;
  nick: string;
  type: string;
  // At most REPLY_EXCERPT_MAX characters, formatting codes intact.
  text: string;
  // For the client's ignore check: a line from someone ignored since shows as
  // unavailable rather than quoting them.
  userhost: string | null;
  // One of the user's own lines — a reply to it from someone else is a
  // highlight, which a client re-evaluating highlight rules must keep.
  self: boolean;
}

// On a message row that is a reply. `parent` is null when no line we hold
// carries that msgid: retention took it, it predates our history, it was a
// reaction (a TAGMSG, never stored as a line), or its author was ignored.
export interface ReplyContext {
  msgid: string;
  parent: ReplyParent | null;
}

// The msgid a line replies to, from its tags. `+reply` is the ratified name;
// `+draft/reply` is what older clients still send.
export function replyMsgidFromTags(tags: Record<string, string> | undefined): string | undefined {
  return tags?.['+reply'] || tags?.['+draft/reply'] || undefined;
}
