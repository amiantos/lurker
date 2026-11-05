// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// IRCv3 replies (client-tags/reply, #993): the shape a reply's context rides a
// message row in, shared by the server (which resolves it) and the client
// (which draws the line above the reply).

// The line types a reply can answer and a thread can start from — the ones
// that are stored as lines someone said. Everything that finds a parent or a
// thread root by msgid filters on this, so they agree about what a root is.
export const REPLY_LINE_TYPES: readonly string[] = ['message', 'action', 'notice'];
export const REPLY_LINE_TYPES_SQL = `(${REPLY_LINE_TYPES.map((t) => `'${t}'`).join(', ')})`;

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
  // The answered line was deleted (#1013): `text` is empty, and the quote says
  // "message deleted" rather than "unavailable" — the line is still there to
  // jump to. Absent otherwise.
  redacted?: true;
}

// The answered line as a client quotes it: when it came through a marked relay
// bot, as the person inside the envelope, with the bot and the `[source]` kept
// for the label the timeline shows on that line (#996). `self` then says whether
// that person is the user (their nick on the line's network), not the bot.
export interface QuotedLine extends ReplyParent {
  relayBot?: string;
  relaySource?: string | null;
}

// On a message row that is a reply. `parent` is null when no line we hold
// carries that msgid: retention took it, it predates our history, it was a
// reaction (a TAGMSG, never stored as a line), or its author was ignored.
export interface ReplyContext {
  msgid: string;
  parent: ReplyParent | null;
  // The msgid at the top of the reply's thread (#1225): the parent's own root,
  // or the parent itself when it has none. What a thread opens on. Absent only
  // on a row stored before roots were tracked.
  root?: string;
}

// Replies in the thread a line started, for the chip under it (#1225):
// how many, and when the newest arrived. Only on a line with replies.
export interface ThreadStats {
  replies: number;
  lastReplyTime: string;
}

// Most replies one `thread` read ships, and most a client holds live: past it
// the NEWEST replies stay and `truncated` says so.
export const THREAD_MAX_REPLIES = 1000;

// A thread the user is in, as `threads-changed` lists it: with its own unread
// count, kept by the server (thread_follows).
export interface FollowedThread {
  networkId: number;
  bufferId: number;
  target: string;
  rootMsgid: string;
  // The line that started it, excerpted like a reply's quote; null when the
  // server doesn't hold it (or it's from someone ignored).
  root: Omit<ReplyParent, 'self'> | null;
  // Replies from others the user hasn't seen in the thread, and whether any
  // of them is a highlight.
  unread: number;
  highlighted: boolean;
  lastReplyId: number;
  lastReplyTime: string;
}

// One of a buffer's threads, as the `threads` verb lists them.
export interface BufferThread {
  rootMsgid: string;
  root: ReplyParent | null;
  replies: number;
  lastReplyId: number;
  lastReplyTime: string;
}

// The msgid a line replies to, from its tags. `+reply` is the ratified name;
// `+draft/reply` is what older clients still send.
export function replyMsgidFromTags(tags: Record<string, string> | undefined): string | undefined {
  return tags?.['+reply'] || tags?.['+draft/reply'] || undefined;
}

// A composer draft's reply: the stored line it answers, and whether the Reply
// put `nick: ` into the draft's text (cancelling takes back only an address it
// put there). It rides the draft across devices, and an up-arrow history entry
// keeps the one it was sent with. This is what a client sends; the server sends
// back a DraftReply, with the line resolved as a reply's quote is.
export interface DraftReplyRef {
  messageId: number;
  addressed: boolean;
}

export interface DraftReply extends DraftReplyRef {
  parent: ReplyParent;
}

// A client's `reply` field: undefined when it sent none (a client that doesn't
// know about replies — the stored reply stays as it is), null to clear it or
// when it's malformed, else the ref.
export function parseDraftReplyRef(raw: unknown): DraftReplyRef | null | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const messageId = Number(r.messageId);
  if (!Number.isInteger(messageId) || messageId <= 0) return null;
  return { messageId, addressed: r.addressed === true };
}

// What goes either side of a quoted line's nick, by the line's type — the way
// IRC writes the line: `<alice> text`, `* bob waves`, `-ChanServ- text`. Shared
// by the reply quote the timeline draws and the Quote action's plain-text line.
export function quoteMarks(type: string | null | undefined): [string, string] {
  if (type === 'action') return ['* ', ''];
  if (type === 'notice') return ['-', '-'];
  return ['<', '>'];
}
