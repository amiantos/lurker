// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { defineStore } from 'pinia';
import { bufferKey } from './buffers.js';

// IRCv3 replies (#993): the reply being composed, per buffer. The Reply action
// on a line sets it, the status bar shows it ("↩ alice …  ×"), and the next
// line sent from that buffer's composer carries its `replyTo`. Kept per buffer
// — switching away and back finds it still pending, as a draft is.
//
// Local to this tab: a half-composed reply is a gesture, not state another
// device needs. The server re-checks everything about the line (the buffer, the
// msgid, the network's support) and sends a plain line when it can't reply.

export interface PendingReply {
  // The stored line being answered — what `replyTo` names on the wire.
  messageId: number;
  nick: string;
  type: string;
  text: string;
  // The Reply put `nick: ` into the draft (it doesn't when the draft already
  // opens with it). Only then does cancelling take it back out — an address the
  // user typed is theirs.
  addressed?: boolean;
}

export const useRepliesStore = defineStore('replies', {
  state: () => ({
    // By buffer key (networks.activeKey's form).
    pending: {} as Record<string, PendingReply>,
  }),
  getters: {
    forKey:
      (state) =>
      (key: string | null | undefined): PendingReply | null =>
        (key && state.pending[key]) || null,
  },
  actions: {
    start(key: string, reply: PendingReply) {
      // Reply again on a line by the same author: the address in the draft is
      // still the one the first Reply put there. Stored as our own copy — the
      // caller's object is theirs, and markAddressed must not reach into it.
      const prev = this.pending[key];
      const addressed = !!reply.addressed || (!!prev?.addressed && prev.nick === reply.nick);
      this.pending[key] = { ...reply, addressed };
    },
    // The composer put `nick: ` in the draft for this buffer's pending reply.
    markAddressed(key: string, nick: string) {
      const reply = this.pending[key];
      if (reply && reply.nick === nick) this.pending[key] = { ...reply, addressed: true };
    },
    cancel(key: string | null | undefined) {
      if (key) delete this.pending[key];
    },
    // Lifecycle hooks (lib/bufferLifecycle.ts): a closed buffer's reply goes
    // with it — reopened later, it must not still be "replying to" an old line
    // — and a renamed buffer's follows it.
    dropBuffer(networkId: number | string | null, target: string) {
      delete this.pending[bufferKey(networkId, target)];
    },
    rekeyBuffer(networkId: number | string | null, from: string, to: string) {
      const fromKey = bufferKey(networkId, from);
      const reply = this.pending[fromKey];
      if (!reply) return;
      delete this.pending[fromKey];
      this.pending[bufferKey(networkId, to)] = reply;
    },
  },
});
