// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Client store for the DCC download manager (#270 phase 2). Mirrors the server's
// dcc_transfers rows and backs the Transfers view: the initial list comes from
// GET /api/dcc, then live state changes arrive over the WS as `dcc-transfer`
// frames (applyTransfer). Acting on a transfer (accept / reject / cancel) goes
// over POST and the authoritative row echoes back — both through the action's
// response and, redundantly, the live frame the server publishes on the change.
//
// DCC is OFF for almost everyone (a self-host opt-in + per-user grant; dark on
// hosted cells), so this store stays empty and the UI affordance stays hidden
// until a transfer actually exists. There's no boot fetch: the store loads
// lazily when the Transfers modal opens or `/dcc list` runs, and the live frame
// reveals the affordance the moment an offer lands.

import { defineStore } from 'pinia';
import { api } from '../api.js';

// Mirror of the server DccTransferState union (db/dccTransfers.ts). Two entry
// states (requested / pending_approval), an active receive path, and terminal
// states. Kept in sync by hand — the wire is plain JSON.
export type DccState =
  | 'requested'
  | 'pending_approval'
  | 'connecting'
  | 'receiving'
  | 'stalled'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'rejected'
  | 'cancelled';

// How a completed transfer verified against the filename CRC32 (server's
// DccCrcStatus). Only meaningful once `completed`.
export type DccCrcStatus = 'ok' | 'mismatch' | 'absent' | 'unverified';

// The subset of the server row the UI reads. The server ships the whole row;
// extra columns (peer_host/port, token, trigger_text, …) are ignored here.
export interface DccTransfer {
  id: number;
  network_id: number;
  peer_nick: string;
  filename: string;
  advertised_size: number;
  received_bytes: number;
  state: DccState;
  crc_status: DccCrcStatus | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

// States that can still change — a transfer in one of these is "active" (drives
// the affordance badge) and is the only thing /dcc cancel meaningfully targets.
export const ACTIVE_STATES: ReadonlySet<DccState> = new Set([
  'requested',
  'pending_approval',
  'connecting',
  'receiving',
  'stalled',
  'verifying',
]);

// Terminal states a transfer never legitimately leaves (a row id is one-shot).
// Used to drop a stale snapshot that would rewind a finished row — see
// applyTransfer.
const TERMINAL_STATES: ReadonlySet<DccState> = new Set([
  'completed',
  'failed',
  'rejected',
  'cancelled',
]);

// True while a transfer is non-terminal — i.e. `/dcc cancel` (or the modal's
// Cancel button) can still act on it. This INCLUDES a pending_approval offer:
// cancelling one declines it, same as reject. The modal surfaces Reject rather
// than Cancel for a pending offer (its pending_approval branch takes precedence
// over the isCancellable branch), but the predicate itself is just "not yet in a
// terminal state", so it's true for pending too.
export function isCancellable(t: DccTransfer): boolean {
  return ACTIVE_STATES.has(t.state);
}

// Download progress as a clamped 0–100 integer. Shared by the modal's progress
// bar and the /dcc list output so the two never diverge (and a bot that
// over-sends can't render >100%).
export function percentReceived(t: DccTransfer): number {
  if (!t.advertised_size || t.advertised_size <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((t.received_bytes / t.advertised_size) * 100)));
}

type DccAction = 'accept' | 'reject' | 'cancel';

// Dedupe concurrent loads (the `/dcc list` command and the modal's mount both
// fetch) so every awaiter shares one in-flight request and sees the same rows.
// Held module-local, not in state — same rationale as the toasts store's action
// handlers and the drafts store's timers (Pinia state stays serializable).
let inflightLoad: Promise<DccTransfer[]> | null = null;

export const useDccStore = defineStore('dcc', {
  state: () => ({
    transfers: [] as DccTransfer[],
    loaded: false,
    loading: false,
    listError: '',
    // Whether the Transfers modal is open. Lives in the store (not a view-local
    // ref) so `/dcc list` can open it from MessageInput, mirroring the
    // composable-backed opens (useImageModal, useChannelListModal).
    panelOpen: false,
    // Per-transfer action in flight (disables that row's buttons).
    busy: {} as Record<number, boolean>,
    // Per-transfer last action error (cleared on the next attempt / success).
    actionError: {} as Record<number, string>,
  }),
  getters: {
    hasAny: (s): boolean => s.transfers.length > 0,
    // Unsolicited offers awaiting a decision — the urgent, you-must-act count
    // that warn-colors the affordance.
    pendingCount: (s): number => s.transfers.filter((t) => t.state === 'pending_approval').length,
  },
  actions: {
    // Fetch the user's transfers (newest first; the server already orders by id
    // DESC). Idempotent under concurrency via the shared in-flight promise.
    async load(): Promise<DccTransfer[]> {
      if (inflightLoad) return inflightLoad;
      this.loading = true;
      this.listError = '';
      inflightLoad = (async () => {
        try {
          const { transfers } = await api<{ transfers: DccTransfer[] }>('/api/dcc');
          this.transfers = (transfers || []).toSorted((a, b) => b.id - a.id);
          this.loaded = true;
          return this.transfers;
        } catch (e: any) {
          this.listError = e?.message || 'failed to load transfers';
          throw e;
        } finally {
          this.loading = false;
          inflightLoad = null;
        }
      })();
      return inflightLoad;
    },

    // Upsert a single row from a live `dcc-transfer` frame or an action response.
    // The id is immutable, so an existing row is replaced in place; a new one is
    // spliced in keeping the list id-DESC (a fresh offer has the largest id, so
    // this is usually a prepend).
    //
    // WS frames and POST action responses are independent, unordered channels, so
    // a stale snapshot can arrive after a newer one. Guard against the one case
    // that matters: a terminal row must never rewind to an active state (e.g. a
    // cancel/accept POST response carrying 'receiving' resolving after the live
    // 'cancelled'/'completed' frame already landed). Drop such a regression.
    applyTransfer(t: DccTransfer): void {
      if (!t || typeof t.id !== 'number') return;
      const idx = this.transfers.findIndex((x) => x.id === t.id);
      if (idx >= 0) {
        if (TERMINAL_STATES.has(this.transfers[idx].state) && !TERMINAL_STATES.has(t.state)) return;
        this.transfers[idx] = t;
        return;
      }
      const at = this.transfers.findIndex((x) => x.id < t.id);
      if (at === -1) this.transfers.push(t);
      else this.transfers.splice(at, 0, t);
    },

    async accept(id: number): Promise<DccTransfer> {
      return this.act(id, 'accept');
    },
    async reject(id: number): Promise<DccTransfer> {
      return this.act(id, 'reject');
    },
    async cancel(id: number): Promise<DccTransfer> {
      return this.act(id, 'cancel');
    },

    // Shared accept/reject/cancel path: POST /api/dcc/:id/<action>, apply the
    // returned authoritative row, and surface a per-row error on failure (a 409
    // when accepting on a disconnected network, a 404 for an unknown id).
    async act(id: number, action: DccAction): Promise<DccTransfer> {
      this.busy[id] = true;
      delete this.actionError[id];
      try {
        const { transfer } = await api<{ transfer: DccTransfer }>(`/api/dcc/${id}/${action}`, {
          method: 'POST',
        });
        if (transfer) this.applyTransfer(transfer);
        return transfer;
      } catch (e: any) {
        this.actionError[id] = e?.message || `${action} failed`;
        throw e;
      } finally {
        delete this.busy[id];
      }
    },

    // Open the Transfers modal and (re)load the list. Used by the sidebar button
    // and `/dcc list`. Load errors surface via listError in the modal.
    open(): void {
      this.panelOpen = true;
      this.load().catch(() => {
        /* surfaced via listError */
      });
    },
    close(): void {
      this.panelOpen = false;
    },
  },
});
