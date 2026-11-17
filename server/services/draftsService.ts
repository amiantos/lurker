// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { EventEmitter } from 'events';
import { upsertDraft, clearDraft, listForUser, getDraftForBuffer } from '../db/drafts.js';
import type { DraftReplyRef } from '../../shared/replies.js';

// Per-buffer drafts are last-write-wins by updated_at — no merging, no CRDT.
// The conflict surface is tiny in practice (you don't actively type into the
// same buffer on two devices simultaneously), so this service just upserts and
// emits a `change` for wsHub to fan out to every other tab of the same user.
//
// A draft with nothing in it is a delete: the row is sparse on disk, and clients
// expect "no draft" rather than "draft with empty string" so the pencil chip
// can drive itself off `hasDraft` without extra trim checks. Nothing means no
// text AND no reply: a Reply with nothing typed yet (on your own line, in a DM,
// where it inserts no address) is a draft all the same, and follows you to
// another device like one.
//
// `reply` (see upsertDraft): undefined leaves the stored one, null clears it —
// except that emptying the text with no reply key clears the whole draft, as a
// send does: that's how a client that knows nothing of replies clears one. The
// change announces the reply as it was stored and resolved, which is not always
// what was sent: one that doesn't resolve is dropped, and then the sender is
// told as well, or it would go on showing a reply the draft no longer has.
//
// `set` and `clear` answer whether the write named a buffer the user has. False
// is nothing stored and nothing announced.
class DraftsService extends EventEmitter {
  set(
    userId: number,
    networkId: number,
    target: string,
    body: unknown,
    reply: DraftReplyRef | null | undefined,
    originWs: unknown = null,
  ): boolean {
    const text = typeof body === 'string' ? body : '';
    if (text.length === 0 && !reply) return this.clear(userId, networkId, target, originWs);
    const bufferId = upsertDraft(userId, networkId, target, text, reply);
    if (bufferId === undefined) return false; // unknown buffer — nothing stored, nothing to announce
    if (reply === null) {
      // Nothing to read back: the text as sent, no reply.
      this.emit('change', {
        userId,
        networkId,
        target,
        bufferId,
        body: text,
        reply: null,
        originWs,
      });
      return true;
    }
    const stored = getDraftForBuffer(userId, bufferId);
    // A reply sent and not kept: the sender still shows it, so it's told too.
    const dropped = !!reply && !stored?.reply;
    if (!stored?.body && !stored?.reply) {
      // Only a reply, and it didn't hold.
      this.clear(userId, networkId, target, dropped ? null : originWs);
      return true;
    }
    this.emit('change', {
      userId,
      networkId,
      target,
      bufferId,
      body: stored.body,
      reply: stored.reply,
      originWs: dropped ? null : originWs,
    });
    return true;
  }

  clear(userId: number, networkId: number, target: string, originWs: unknown = null): boolean {
    const bufferId = clearDraft(userId, networkId, target);
    if (bufferId === undefined) return false;
    this.emit('change', { userId, networkId, target, bufferId, body: '', reply: null, originWs });
    return true;
  }

  snapshotForUser(userId: number): unknown[] {
    return listForUser(userId);
  }
}

const draftsService = new DraftsService();
export default draftsService;
