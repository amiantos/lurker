// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { defineStore } from 'pinia';
import { socketSend } from '../composables/useSocket.js';
import { bufferKey, useBuffersStore } from './buffers.js';
import type { BufferMessage } from './buffers.js';
import type { PendingReply } from './replies.js';
import type { ReplyContext } from '../../../shared/replies.js';
import { REPLY_LINE_TYPES } from '../../../shared/replies.js';
import { isDccChatTarget } from '../../../shared/channels.js';
import { setThreadViewBuffer } from '../lib/threadViewing.js';
import { useNetworksStore } from './networks.js';
import { useIgnoresStore } from './ignores.js';
import { threadTitle } from '../utils/replyText.js';

// Reply threads (IRCv3 replies, #993): a thread is the line that started it
// plus every reply naming it as root (`replyTo.root`), in one buffer.
//
// Two tracks, like favorites and bookmarks:
//   - `followed` is the server's list of threads the user is in (posted, or was
//     highlighted), shown under their channel in the sidebar. It arrives whole
//     in `threads-changed` — at connect and after every change — so unread
//     counts are the server's, never counted here.
//   - `view` is the thread on screen in the thread view: loaded whole with a
//     `thread` request when it opens, then kept current from the live `irc`
//     frames whose root is its root.

export interface FollowedThread {
  networkId: number;
  bufferId: number;
  target: string;
  rootMsgid: string;
  // The user's own name for it (thread-rename); null names it from its root.
  name: string | null;
  root: { id: number; nick: string; type: string; text: string; userhost?: string | null } | null;
  unread: number;
  highlighted: boolean;
  lastReplyId: number;
  lastReplyTime: string;
}

// A line as the thread view holds it: a buffer row with the reply fields the
// view reads spelled out.
export interface ThreadMessage extends BufferMessage {
  id: number;
  msgid?: string;
  text?: string;
  time?: string;
  replyTo?: ReplyContext;
  threadReplies?: number;
}

export interface ThreadView {
  networkId: number;
  target: string;
  bufferId: number;
  rootMsgid: string;
  // null until loaded, and after when we don't hold the first line.
  root: ThreadMessage | null;
  replies: ThreadMessage[];
  loading: boolean;
  truncated: boolean;
  token: number;
}

let nextToken = 1;

export const useThreadsStore = defineStore('threads', {
  state: () => ({
    followed: [] as FollowedThread[],
    view: null as ThreadView | null,
  }),
  getters: {
    // A channel's followed threads, newest activity first (the server's order).
    forBuffer:
      (state) =>
      (bufferId: number | null | undefined): FollowedThread[] =>
        bufferId == null ? [] : state.followed.filter((t) => t.bufferId === bufferId),
    isFollowed:
      (state) =>
      (bufferId: number, rootMsgid: string): boolean =>
        state.followed.some((t) => t.bufferId === bufferId && t.rootMsgid === rootMsgid),
    // The server's unread count for a followed thread; null when not followed.
    unreadFor:
      (state) =>
      (bufferId: number, rootMsgid: string): number | null =>
        state.followed.find((t) => t.bufferId === bufferId && t.rootMsgid === rootMsgid)?.unread ??
        null,
    // What to call a thread — the sidebar row, the thread view's header: the
    // user's name for it, else its first line without the `nick: ` it opens
    // with (threadTitle), else "thread" when that line is gone or from
    // someone ignored.
    title(state) {
      return (bufferId: number, rootMsgid: string): string => {
        const followed = state.followed.find(
          (t) => t.bufferId === bufferId && t.rootMsgid === rootMsgid,
        );
        if (followed?.name) return followed.name;
        const v = state.view;
        const inView = v && v.bufferId === bufferId && v.rootMsgid === rootMsgid ? v : null;
        const root = followed?.root ?? inView?.root ?? null;
        const buf = useBuffersStore().byId(bufferId);
        if (!root || !buf || buf.networkId == null) return 'thread';
        const networkId = Number(buf.networkId);
        const nick = String(root.nick ?? '');
        const self = useNetworksStore().states[networkId]?.nick ?? '';
        const ignored =
          (root as { fromIgnored?: boolean }).fromIgnored ||
          (nick.toLowerCase() !== self.toLowerCase() &&
            useIgnoresStore().evaluate(networkId, {
              nick,
              userhost: (root.userhost as string | null | undefined) ?? null,
              target: buf.target,
              text: String(root.text ?? ''),
              type: String(root.type),
              isDm: buf.kind === 'dm',
            }).hide);
        if (ignored) return 'thread';
        return threadTitle(String(root.text ?? '')) || 'thread';
      };
    },
    // The buffer key whose thread is on screen, or null.
    viewKey: (state): string | null =>
      state.view ? bufferKey(state.view.networkId, state.view.target) : null,
  },
  actions: {
    applyFollowed(list: FollowedThread[]) {
      this.followed = Array.isArray(list) ? list : [];
    },

    // Open the thread view on (bufferId, rootMsgid): ask for it whole. Re-opening
    // the one already loaded keeps what's there and refreshes it underneath.
    open(bufferId: number, rootMsgid: string) {
      const buf = useBuffersStore().byId(bufferId);
      if (!buf || buf.networkId == null) return;
      const token = nextToken++;
      const same = this.view?.bufferId === bufferId && this.view.rootMsgid === rootMsgid;
      this.view = {
        networkId: Number(buf.networkId),
        target: buf.target,
        bufferId,
        rootMsgid,
        root: same ? this.view!.root : null,
        replies: same ? this.view!.replies : [],
        loading: !same,
        truncated: same ? this.view!.truncated : false,
        token,
      };
      setThreadViewBuffer(bufferKey(buf.networkId, buf.target));
      socketSend({ type: 'thread', bufferId, rootMsgid, token });
    },

    close() {
      this.view = null;
      setThreadViewBuffer(null);
    },

    // The `thread` answer. Dropped unless it answers the request on screen.
    applyThread(frame: {
      bufferId: number;
      rootMsgid: string;
      token?: number | null;
      root: ThreadMessage | null;
      replies: ThreadMessage[];
      truncated?: boolean;
    }) {
      const v = this.view;
      if (!v || v.bufferId !== frame.bufferId || v.rootMsgid !== frame.rootMsgid) return;
      if (frame.token != null && frame.token !== v.token) return;
      v.root = frame.root ?? null;
      // Live replies that landed between the request and this answer stay.
      const ids = new Set(frame.replies.map((r) => r.id));
      const late = v.replies.filter(
        (r) => !ids.has(r.id) && r.id > (frame.replies.at(-1)?.id ?? 0),
      );
      v.replies = [...frame.replies, ...late];
      v.truncated = !!frame.truncated;
      v.loading = false;
    },

    // A live line. Joins the thread on screen when its root is the view's; and
    // wherever its root line is loaded — in the channel, or as the view's own
    // first line — that line's reply count goes up.
    applyLive(event: ThreadMessage) {
      const root = event.replyTo?.root;
      if (!root || event.id == null || typeof event.bufferId !== 'number') return;
      const v = this.view;
      const inView = v && v.bufferId === event.bufferId && v.rootMsgid === root;
      if (inView) {
        if (v.replies.some((r) => r.id === event.id)) return; // a replay
        v.replies.push(event);
      }
      // Someone ignored doesn't count (the server's count leaves them out).
      if (event.fromIgnored) return;
      if (inView && v.root) v.root.threadReplies = (v.root.threadReplies ?? 0) + 1;
      // The line carrying that msgid is the root by definition — even one that
      // is itself a reply stored before threads were tracked, which the server
      // counts the same way (replyRootFor roots at it).
      const buf = useBuffersStore().byId(event.bufferId);
      const line = buf?.messages.find((m) => m.msgid === root) as ThreadMessage | undefined;
      if (line) line.threadReplies = (line.threadReplies ?? 0) + 1;
    },

    // The thread view has shown every reply it holds: move the server's read
    // pointer, if the thread is one we follow (only those have one).
    markViewRead() {
      const v = this.view;
      if (!v || v.loading || !this.isFollowed(v.bufferId, v.rootMsgid)) return;
      const last = v.replies.at(-1);
      const followed = this.followed.find(
        (t) => t.bufferId === v.bufferId && t.rootMsgid === v.rootMsgid,
      );
      if (!last || !followed || followed.unread === 0) return;
      socketSend({
        type: 'thread-read',
        bufferId: v.bufferId,
        rootMsgid: v.rootMsgid,
        messageId: last.id,
      });
    },

    // The user's own name for a thread; blank names it from its first line again.
    rename(bufferId: number, rootMsgid: string, name: string) {
      const t = this.followed.find((x) => x.bufferId === bufferId && x.rootMsgid === rootMsgid);
      if (t) t.name = name.trim() || null;
      socketSend({ type: 'thread-rename', bufferId, rootMsgid, name });
    },

    // × on a sidebar thread: off the list until we post or are highlighted there.
    unfollow(bufferId: number, rootMsgid: string) {
      this.followed = this.followed.filter(
        (t) => !(t.bufferId === bufferId && t.rootMsgid === rootMsgid),
      );
      socketSend({ type: 'thread-close', bufferId, rootMsgid });
    },

    // What a line sent from the thread view answers when no Reply is pending:
    // the thread's first line, or — when we don't hold it — its oldest reply we
    // do. As a PendingReply so the composer's send path takes it as-is.
    defaultReply(key: string | null | undefined): PendingReply | null {
      const v = this.view;
      if (!key || !v || this.viewKey !== key || isDccChatTarget(v.target)) return null;
      const line = v.root ?? v.replies[0];
      // The same bar a line's own `reply` has to clear (ThreadView.replyable):
      // never an encrypted line — the server sends no reply tags there, and a
      // plaintext line naming one would say what it answers.
      if (!line || !line.msgid || line.e2e || !REPLY_LINE_TYPES.includes(line.type)) return null;
      return {
        messageId: line.id,
        nick: String(line.nick ?? ''),
        type: line.type,
        text: String(line.text ?? ''),
      };
    },
  },
});
