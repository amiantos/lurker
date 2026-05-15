// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: Elastic-2.0

import { EventEmitter } from 'events';
import { upsertDraft, clearDraft, listForUser } from '../db/drafts.js';

// Per-buffer drafts are last-write-wins by updated_at — no merging, no CRDT.
// The conflict surface is tiny in practice (you don't actively type into the
// same buffer on two devices simultaneously), so this service just upserts and
// emits a `change` for wsHub to fan out to every other tab of the same user.
//
// Empty bodies are treated as a delete: the row is sparse on disk, and clients
// expect "no draft" rather than "draft with empty string" so the pencil chip
// can drive itself off `hasDraft` without extra trim checks.
class DraftsService extends EventEmitter {
  set(userId, networkId, target, body, originWs = null) {
    const text = typeof body === 'string' ? body : '';
    if (text.length === 0) {
      this.clear(userId, networkId, target, originWs);
      return;
    }
    upsertDraft(userId, networkId, target, text);
    this.emit('change', { userId, networkId, target, body: text, originWs });
  }

  clear(userId, networkId, target, originWs = null) {
    clearDraft(userId, networkId, target);
    this.emit('change', { userId, networkId, target, body: '', originWs });
  }

  snapshotForUser(userId) {
    return listForUser(userId);
  }
}

const draftsService = new DraftsService();
export default draftsService;
