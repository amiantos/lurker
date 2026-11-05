// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Message redaction (#1013): which of the lines we hold were deleted, keyed by
// message id, the way reactions and bookmarks are kept — a row that arrives is
// authoritative for itself (its `redaction`, or none), and a `message-redacted`
// frame marks one live. Rows in the buffers store are never patched; MessageList
// and the history rows ask here when they draw a line.

import { defineStore } from 'pinia';
import { useReactionsStore } from './reactions.js';
import type { Redaction } from '../../../shared/redaction.js';

export interface RedactedFrame {
  networkId: number;
  bufferId: number;
  target: string;
  messageId: number;
  by: string;
  reason?: string;
  self: boolean;
  time: string;
}

export const useRedactionsStore = defineStore('redactions', {
  state: () => ({
    byMessage: new Map<number, Redaction>(),
  }),
  getters: {
    // The deletion on a line, from the frame that marked it live or the row it
    // came in on. The row's own field is the fallback, so a line loaded after
    // its deletion needs no entry here.
    get:
      (state) =>
      (message: { id?: number | string | null; redaction?: Redaction } | null | undefined) => {
        if (!message || message.id == null) return undefined;
        const id = Number(message.id);
        return (Number.isFinite(id) ? state.byMessage.get(id) : undefined) ?? message.redaction;
      },
  },
  actions: {
    noteFromEvents(
      events: Array<{ id?: number | string | null; redaction?: Redaction }>,
      networkId: number | null | undefined,
    ) {
      if (!Array.isArray(events) || networkId == null) return;
      for (const e of events) {
        if (e?.id == null) continue;
        const id = Number(e.id);
        if (!Number.isFinite(id)) continue;
        if (e.redaction) this.byMessage.set(id, e.redaction);
        else this.byMessage.delete(id);
      }
    },

    applyFrame(frame: RedactedFrame) {
      const id = Number(frame.messageId);
      if (!Number.isFinite(id)) return;
      const redaction: Redaction = { by: frame.by, time: frame.time };
      if (frame.reason) redaction.reason = frame.reason;
      this.byMessage.set(id, redaction);
      // The server took the line's reactions down with it; so does the view.
      useReactionsStore().byMessage.delete(id);
    },
  },
});
