// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Client store for the DCC download manager (#270 phase 2), for sending
// (#1086), and for the XDCC queue (#1085). Mirrors the server's dcc_transfers
// rows and backs the DCC window: the initial list comes from
// GET /api/dcc, then live state changes arrive over the WS as `dcc-transfer`
// frames (applyTransfer). Acting on a transfer (accept / reject / cancel) goes
// over POST and the authoritative row echoes back — both through the action's
// response and, redundantly, the live frame the server publishes on the change.
//
// DCC is OFF for almost everyone (a self-host opt-in + per-user grant; dark on
// hosted cells), so the UI affordance stays hidden until the account has a
// transfer or a file. On an instance that runs DCC, both lists load with every
// snapshot (resync), so the affordance is there from the start whenever there
// is something in it; live frames keep it current.

import { defineStore } from 'pinia';
import { api } from '../api.js';
import { uploadInChunks } from '../lib/chunkedUpload.js';
import { formatBytes } from '../utils/formatBytes.js';
import { useConfigStore } from './config.js';
import { useToastsStore } from './toasts.js';
import { useBuffersStore } from './buffers.js';

export { describePacks } from '../../../shared/xdcc.js';

// Mirror of the server DccTransferState union (db/dccTransfers.ts). Two entry
// states (requested / pending_approval), an active receive path, a send's
// offered / sending (#1086), and terminal states. Kept in sync by hand — the
// wire is plain JSON.
export type DccState =
  | 'queued'
  | 'requested'
  | 'pending_approval'
  | 'connecting'
  | 'receiving'
  | 'stalled'
  | 'verifying'
  | 'offered'
  | 'sending'
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
  /** Null once the network was deleted: the row and its file stay (#1125). */
  network_id: number | null;
  peer_nick: string;
  /** A file received, or one of ours sent (#1086). For a send,
   *  received_bytes is what the peer has confirmed. */
  direction: 'recv' | 'send';
  filename: string;
  advertised_size: number;
  received_bytes: number;
  state: DccState;
  crc_status: DccCrcStatus | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  /** 1 for a transfer over TLS, KVIrc's SSEND (#1157). */
  secure?: number;
  /** When the user deleted the received file from the server (#1125). */
  file_deleted_at?: string | null;
  /** Non-null while this row owns a file on the server. Used only as that
   *  signal: the path itself is never shown. */
  destination_path?: string | null;
  /** The kept file a completed receive produced, or the one a send sends,
   *  while it is kept (#1133). */
  file_id?: number | null;
  /** The XDCC pack, on a row the queue owns or a typed `xdcc send #N` made
   *  (#1085). */
  pack?: number | null;
  /** Its place in the bot's queue; the lowest queued goes next. */
  queue_seq?: number | null;
  /** 2 on the queue's one automatic retry. */
  attempt?: number;
  /** When the bot first answered the request: it has us in its own queue. */
  bot_acked_at?: string | null;
}

/** A file the account keeps on the server (#1133): a completed receive, or
 *  one uploaded to send (#1086). */
export interface DccFile {
  id: number;
  name: string;
  size: number;
  origin: 'received' | 'uploaded';
  created_at: string;
  /** The transfer that received it, and from whom on which network. */
  transfer_id: number | null;
  peer_nick: string | null;
  network_id: number | null;
  /** How a received file checked out (#1082); null for an upload. */
  crc_status: DccCrcStatus | null;
}

/** Who the DCC window is picking a file for: `/dcc send <nick>` with no file
 *  (#1086). */
export interface DccSendPick {
  networkId: number;
  nick: string;
  passive: boolean;
  /** Over TLS, KVIrc's SSEND (#1157). Absent means plain. */
  secure?: boolean;
}

/** What GET /api/dcc/config says this account may do. */
export interface DccAccountConfig {
  chat: boolean;
  receive: boolean;
  send: boolean;
  /** Whether an offer can be active; without it a file send goes passive. */
  canListen?: boolean;
  /** What the account's DCC files may take, null for no limit (#1125). */
  limitBytes?: number | null;
}

// The file `/dcc send <nick> <file>` means (#1086): one named exactly that,
// the newest if several are (two receives of one name are two files), else
// the id /dcc files shows, with or without its `#`.
export function findDccFile(files: readonly DccFile[], ref: string): DccFile | null {
  const named = files.filter((f) => f.name === ref).toSorted((a, b) => b.id - a.id);
  if (named.length) return named[0];
  const m = /^#?(\d+)$/.exec(ref);
  return m ? (files.find((f) => f.id === Number(m[1])) ?? null) : null;
}

// Where a kept file downloads from (#1133).
export function keptFileUrl(id: number): string {
  return `/api/dcc/files/${id}/file`;
}

// States that can still change — a transfer in one of these is "active" (drives
// the affordance badge) and is the only thing /dcc cancel meaningfully targets.
export const ACTIVE_STATES: ReadonlySet<DccState> = new Set([
  'queued',
  'requested',
  'pending_approval',
  'connecting',
  'receiving',
  'stalled',
  'verifying',
  'offered',
  'sending',
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

// Whether a finished transfer holds part of a download (#1133): bytes on disk
// that are its own, not a kept file, as the server decides it. A path with
// nothing received is only a reservation. Clearing one from the list deletes
// the bytes, so it takes the user's say-so.
export function holdsPartial(t: DccTransfer): boolean {
  return hasFile(t) && t.file_id == null && t.received_bytes > 0;
}

// Whether a finished transfer left a file on the server to download or delete
// (#1125): a completed one, or a partial from one that failed or was cancelled.
// A row stops owning its file when the user deletes it, or when a newer
// transfer takes over the path (a resume continuing its partial).
export function hasFile(t: DccTransfer): boolean {
  return !ACTIVE_STATES.has(t.state) && !!t.destination_path;
}

// A row in flight: anything active but an offer still waiting for an answer.
export function inFlight(t: DccTransfer): boolean {
  return ACTIVE_STATES.has(t.state) && t.state !== 'pending_approval';
}

// A queued pack that ended without its file, which Retry can ask for again
// (#1085).
export function retryable(t: DccTransfer): boolean {
  return (
    t.pack != null && t.direction === 'recv' && (t.state === 'failed' || t.state === 'stalled')
  );
}

// Whether two nicks on a network are one peer: the same DM, as the buffers
// store's findDm resolves each (the house rule for matching a nick), and as
// findDm folds them when either has no DM open.
export function samePeer(networkId: number | null, a: string, b: string): boolean {
  if (a === b) return true;
  if (networkId != null) {
    const buffers = useBuffersStore();
    const da = buffers.findDm(networkId, a);
    const db = buffers.findDm(networkId, b);
    if (da && db) return da === db;
  }
  return a.toLowerCase() === b.toLowerCase();
}

// Bytes per second over recent progress frames, and the time left at that
// rate, in seconds. Null until two frames have come in.
export interface DccRate {
  bps: number;
  etaSeconds: number | null;
}

// "1h 4m", "5m", "40s".
export function formatEta(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  if (s >= 60) return `${Math.floor(s / 60)}m`;
  return `${s}s`;
}

// Where a completed transfer's file downloads from (#1079). The modal's link
// and `/dcc download` both use it.
export function dccFileUrl(id: number): string {
  return `/api/dcc/${id}/file`;
}

// Why GET /api/dcc/:id/file refused, by status. The download is checked with a
// HEAD, which carries no body, so the server's reason has to be restated here.
const DOWNLOAD_REFUSALS: Record<number, string> = {
  // Downloads need only the instance switch, never a grant.
  403: 'DCC is turned off on this server',
  404: 'transfer not found',
  409: 'transfer is not complete',
  410: 'file is no longer on the server',
};

type DccAction = 'accept' | 'reject' | 'cancel';

// Dedupe concurrent loads (the `/dcc list` command and the modal's mount both
// fetch) so every awaiter shares one in-flight request and sees the same rows.
// Held module-local, not in state — same rationale as the toasts store's action
// handlers and the drafts store's timers (Pinia state stays serializable).
let inflightLoad: Promise<DccTransfer[]> | null = null;
// Transfer frames that land while the list loads, applied again on top of it:
// the response may predate them (a completion arriving as a reconnect refetch
// is on its way would otherwise rewind the row).
let transfersMissed: DccTransfer[] = [];
// Transfers cleared from the list (#1133). Ids are never reused, so a row
// arriving late for one of these (a list read before the clear, an action's
// response slower than the clear's frame) is history already gone.
const clearedIds = new Set<number>();
let inflightFiles: Promise<DccFile[]> | null = null;
// Frames that land while the files list loads: the response was read before
// them, so they are applied again on top of it.
let filesMissed: Array<DccFile | number> = [];
// Progress samples per transfer, for speed and time left: when the last frame
// came and how many bytes it said. Module-local: they are a reading of the
// frames' timing, not state anyone else needs.
const progressSamples = new Map<number, { at: number; bytes: number }>();
// The toast standing for each offer still waiting for an answer (#1085), by
// transfer id, so it goes when the offer is answered anywhere.
const offerToasts = new Map<number, number>();
// Offers put off with Later: their toast doesn't come back when the lists
// reload (every reconnect resyncs them), only their row in the DCC window stays.
const offersPutOff = new Set<number>();

// Hand a file to the browser's download manager, after a HEAD: a refusal
// handed to the browser is saved as a .json file of the error (or, without
// `download`, navigates the app to it), so it has to be caught here and shown
// instead. Throws the refusal, restated, since a HEAD carries no body.
async function saveThroughBrowser(url: string, refusals: Record<number, string>): Promise<void> {
  try {
    await api(url, { method: 'HEAD' });
  } catch (e: any) {
    throw new Error(refusals[e?.status] || e?.message || 'download failed', { cause: e });
  }
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  a.click();
}

// Why GET /api/dcc/files/:id/file refused, by status.
const KEPT_DOWNLOAD_REFUSALS: Record<number, string> = {
  403: 'DCC is turned off on this server',
  404: 'file not found',
  410: 'file is no longer on the server',
};

export const useDccStore = defineStore('dcc', {
  state: () => ({
    transfers: [] as DccTransfer[],
    loaded: false,
    loading: false,
    listError: '',
    // Whether the DCC window is open. Lives in the store (not a view-local
    // ref) so `/dcc`, `/xdcc`, the status bar and offer toasts can open it,
    // mirroring the composable-backed opens (useMediaViewer, useChannelListModal).
    panelOpen: false,
    // The files the account keeps (#1133), newest first.
    files: [] as DccFile[],
    filesLoaded: false,
    filesLoading: false,
    filesError: '',
    // Per-file action in flight, and its last error, as for transfers.
    fileBusy: {} as Record<number, boolean>,
    fileError: {} as Record<number, string>,
    // Per-transfer action in flight (disables that row's buttons).
    busy: {} as Record<number, boolean>,
    // Per-transfer last action error (cleared on the next attempt / success).
    actionError: {} as Record<number, string>,
    // Clear all is in flight, and its last error.
    clearing: false,
    clearError: '',
    // What the account may do, from /api/dcc/config, once asked (#1086).
    account: null as DccAccountConfig | null,
    // Speed and time left per transfer in flight, from its progress frames.
    rates: {} as Record<number, DccRate>,
    // Set while the DCC window is picking a file to send (#1086).
    pick: null as DccSendPick | null,
    // A file going up to be sent, and how far (0–100), or its failure.
    uploading: null as { name: string; percent: number } | null,
    uploadError: '',
  }),
  getters: {
    hasAny: (s): boolean => s.transfers.length > 0 || s.files.length > 0,
    // Whether this account can send a file over DCC (#1085): what offers
    // "Send File (DCC)…" on a nick.
    canSend: (s): boolean => useConfigStore().features.dcc && !!s.account?.send,
    // Whether this account can offer a DCC chat: what offers "Chat (DCC)" on a
    // nick. Accepting one someone offers is gated the same way, server-side.
    canChat: (s): boolean => useConfigStore().features.dcc && !!s.account?.chat,
    // Whether the DCC button shows: DCC runs here, and the account has some
    // of it (a grant), or something from before a grant went.
    hasDcc(s): boolean {
      if (!useConfigStore().features.dcc) return false;
      const a = s.account;
      return !!(a && (a.chat || a.receive || a.send)) || this.hasAny;
    },
    // Whether the way into the DCC window is offered: the desktop's DCC button
    // and the phone's menu row. While the window is open too, so it is not
    // left with nothing that opened it.
    entryShown(): boolean {
      return this.hasDcc || this.panelOpen;
    },
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
      transfersMissed = [];
      inflightLoad = (async () => {
        try {
          const { transfers } = await api<{ transfers: DccTransfer[] }>('/api/dcc');
          this.transfers = (transfers || [])
            .filter((t) => !clearedIds.has(t.id))
            .toSorted((a, b) => b.id - a.id);
          const missed = transfersMissed;
          transfersMissed = [];
          for (const t of missed) this.applyTransfer(t);
          this.syncOfferToasts();
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
      if (!t || typeof t.id !== 'number' || clearedIds.has(t.id)) return;
      if (inflightLoad) transfersMissed.push(t);
      const idx = this.transfers.findIndex((x) => x.id === t.id);
      if (idx >= 0) {
        if (TERMINAL_STATES.has(this.transfers[idx].state) && !TERMINAL_STATES.has(t.state)) return;
        this.transfers[idx] = t;
      } else {
        const at = this.transfers.findIndex((x) => x.id < t.id);
        if (at === -1) this.transfers.push(t);
        else this.transfers.splice(at, 0, t);
      }
      this.sampleProgress(t);
      this.syncOfferToast(t);
    },

    // Speed and time left from consecutive progress frames (the server
    // checkpoints every few seconds). A smoothed rate, so one slow checkpoint
    // doesn't swing the estimate.
    sampleProgress(t: DccTransfer): void {
      const moving = t.state === 'receiving' || t.state === 'sending';
      if (!moving) {
        progressSamples.delete(t.id);
        delete this.rates[t.id];
        return;
      }
      const now = Date.now();
      const prev = progressSamples.get(t.id);
      progressSamples.set(t.id, { at: now, bytes: t.received_bytes });
      if (!prev || t.received_bytes < prev.bytes || now - prev.at < 500) return;
      const instant = ((t.received_bytes - prev.bytes) * 1000) / (now - prev.at);
      const old = this.rates[t.id]?.bps;
      const bps = old == null ? instant : old * 0.6 + instant * 0.4;
      const left = t.advertised_size - t.received_bytes;
      this.rates[t.id] = { bps, etaSeconds: bps > 0 && left > 0 ? left / bps : null };
    },

    // An offer waiting for an answer has a toast (#1085): Accept · Decline ·
    // Later, the way a DCC chat offer does. It goes once the offer is answered,
    // from here or anywhere else. Later only puts the toast away; the offer
    // stays in the DCC window.
    syncOfferToast(t: DccTransfer): void {
      const toasts = useToastsStore();
      const shown = offerToasts.get(t.id);
      if (t.state !== 'pending_approval') {
        if (shown != null) {
          toasts.dismiss(shown);
          offerToasts.delete(t.id);
        }
        return;
      }
      // A toast counts only while it is still up: the toasts can be cleared
      // from under this map (a sign-out), and the offer then needs a new one.
      if (shown != null && toasts.items.some((x) => x.id === shown)) return;
      if (t.direction !== 'recv' || offersPutOff.has(t.id)) return;
      const size = t.advertised_size > 0 ? ` · ${formatBytes(t.advertised_size)}` : '';
      const toastId = toasts.push({
        kind: 'notify',
        // An SSEND (#1157) says so where the user decides, not only in the row.
        title: `${t.secure ? 'Secure DCC file' : 'DCC file'} from ${t.peer_nick}`,
        body: `${t.filename}${size}`,
        networkId: t.network_id ?? undefined,
        target: t.peer_nick,
        ttlMs: 0,
        dismissible: false,
        actions: [
          {
            label: 'Accept',
            tone: 'good',
            onClick: () => {
              offerToasts.delete(t.id);
              this.accept(t.id).catch(() => this.open());
            },
          },
          {
            label: 'Decline',
            tone: 'bad',
            onClick: () => {
              offerToasts.delete(t.id);
              this.reject(t.id).catch(() => this.open());
            },
          },
          { label: 'Later', tone: 'muted', onClick: () => offersPutOff.add(t.id) },
        ],
      });
      offerToasts.set(t.id, toastId);
    },

    // Every offer's toast against the list as it now stands: one for each offer
    // still waiting (an offer pending when the app loads gets its toast here),
    // none for one answered elsewhere while this tab wasn't listening.
    syncOfferToasts(): void {
      const byId = new Map(this.transfers.map((t) => [t.id, t]));
      for (const id of offerToasts.keys()) {
        const t = byId.get(id);
        if (!t || t.state !== 'pending_approval') {
          useToastsStore().dismiss(offerToasts.get(id)!);
          offerToasts.delete(id);
        }
      }
      for (const t of this.transfers) if (t.state === 'pending_approval') this.syncOfferToast(t);
    },

    // Sign-out: every offer's toast goes, and what was put off is forgotten.
    // Sticky, they would otherwise sit on the next account's screen with
    // buttons bound to this one's transfers.
    dropOfferToasts(): void {
      const toasts = useToastsStore();
      for (const id of offerToasts.values()) toasts.dismiss(id);
      offerToasts.clear();
      offersPutOff.clear();
    },

    // Queue XDCC packs from a bot (#1085). Resolves with the rows queued.
    async queueXdcc(networkId: number, bot: string, packs: number[]): Promise<DccTransfer[]> {
      const { transfers } = await api<{ transfers: DccTransfer[] }>('/api/dcc/xdcc', {
        method: 'POST',
        body: { networkId, nick: bot, packs },
      });
      for (const t of transfers || []) this.applyTransfer(t);
      return transfers || [];
    },

    // Take packs out of a bot's queue, or (null) all of them. Resolves with
    // how many went.
    async unqueueXdcc(networkId: number, bot: string, packs: number[] | null): Promise<number> {
      this.clearError = '';
      try {
        const { removed } = await api<{ removed: number }>('/api/dcc/xdcc/remove', {
          method: 'POST',
          body: { networkId, nick: bot, packs },
        });
        return removed;
      } catch (e: any) {
        this.clearError = e?.message || 'could not take the packs out';
        throw e;
      }
    },

    // Ask again for a queued pack that ended without its file: a new row at
    // the front of its bot's queue.
    async retry(id: number): Promise<DccTransfer> {
      return this.changeRow(id, `/api/dcc/${id}/retry`, 'POST', 'retry failed');
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
      return this.changeRow(id, `/api/dcc/${id}/${action}`, 'POST', `${action} failed`);
    },

    // Remove a finished transfer's file from the server (#1125). The row stays,
    // marked deleted.
    async deleteFile(id: number): Promise<DccTransfer> {
      return this.changeRow(id, dccFileUrl(id), 'DELETE', 'delete failed');
    },

    // Clear a finished transfer from the list (#1133). Its file stays in Files.
    // A partial it holds goes with it only when `deletePartial` says the user
    // agreed; otherwise the server refuses (409, `partial: true`).
    async clearTransfer(id: number, deletePartial = false): Promise<void> {
      this.busy[id] = true;
      delete this.actionError[id];
      try {
        await api(`/api/dcc/${id}${deletePartial ? '?partial=delete' : ''}`, { method: 'DELETE' });
        this.dropTransfers([id]);
      } catch (e: any) {
        this.actionError[id] = e?.message || 'clear failed';
        throw e;
      } finally {
        delete this.busy[id];
      }
    },

    // Clear every finished transfer but those still holding a partial. Files
    // stay. Resolves with how many went.
    async clearFinished(): Promise<number> {
      this.clearing = true;
      this.clearError = '';
      try {
        const { ids } = await api<{ ids: number[] }>('/api/dcc/clear', { method: 'POST' });
        this.dropTransfers(ids || []);
        return ids?.length ?? 0;
      } catch (e: any) {
        this.clearError = e?.message || 'clear failed';
        throw e;
      } finally {
        this.clearing = false;
      }
    },

    // Transfers gone from the list, from a `dcc-transfers-cleared` frame or
    // our own clear.
    dropTransfers(ids: number[]): void {
      for (const id of ids) clearedIds.add(id);
      this.transfers = this.transfers.filter((t) => !clearedIds.has(t.id));
      this.syncOfferToasts();
      for (const id of ids) {
        delete this.busy[id];
        delete this.actionError[id];
      }
    },

    // A request that answers with the transfer's authoritative row: the row's
    // buttons are disabled while it runs, the row is applied, and a refusal
    // shows on the row.
    async changeRow(
      id: number,
      url: string,
      method: 'POST' | 'DELETE',
      fallback: string,
    ): Promise<DccTransfer> {
      this.busy[id] = true;
      delete this.actionError[id];
      try {
        const { transfer } = await api<{ transfer: DccTransfer }>(url, { method });
        if (transfer) this.applyTransfer(transfer);
        return transfer;
      } catch (e: any) {
        this.actionError[id] = e?.message || fallback;
        throw e;
      } finally {
        delete this.busy[id];
      }
    },

    // Save a completed transfer's file through the browser's download manager
    // (#1079). Checked with a HEAD first: a refusal handed to the browser is
    // saved as a .json file of the error (or, without `download`, navigates the
    // app to it), so a file removed on the box has to be caught here and shown
    // on the row instead.
    async download(id: number): Promise<void> {
      this.busy[id] = true;
      delete this.actionError[id];
      try {
        await saveThroughBrowser(dccFileUrl(id), DOWNLOAD_REFUSALS);
      } catch (e: any) {
        this.actionError[id] = e.message;
        throw e;
      } finally {
        delete this.busy[id];
      }
    },

    // The files the account keeps (#1133), shared in-flight like load().
    async loadFiles(): Promise<DccFile[]> {
      if (inflightFiles) return inflightFiles;
      this.filesLoading = true;
      this.filesError = '';
      filesMissed = [];
      inflightFiles = (async () => {
        try {
          const { files } = await api<{ files: DccFile[] }>('/api/dcc/files');
          this.files = (files || []).toSorted((a, b) => b.id - a.id);
          const missed = filesMissed;
          filesMissed = [];
          for (const op of missed) {
            if (typeof op === 'number') this.dropFile(op);
            else this.applyFile(op);
          }
          this.filesLoaded = true;
          return this.files;
        } catch (e: any) {
          this.filesError = e?.message || 'failed to load files';
          throw e;
        } finally {
          this.filesLoading = false;
          inflightFiles = null;
        }
      })();
      return inflightFiles;
    },

    // A file from a live `dcc-file` frame: new, kept in id-DESC order.
    applyFile(f: DccFile): void {
      if (!f || typeof f.id !== 'number') return;
      if (inflightFiles) filesMissed.push(f);
      const idx = this.files.findIndex((x) => x.id === f.id);
      if (idx >= 0) {
        this.files[idx] = f;
        return;
      }
      const at = this.files.findIndex((x) => x.id < f.id);
      if (at === -1) this.files.push(f);
      else this.files.splice(at, 0, f);
    },

    // A file gone, from a `dcc-file-deleted` frame or our own delete.
    dropFile(id: number): void {
      if (inflightFiles) filesMissed.push(id);
      this.files = this.files.filter((f) => f.id !== id);
      delete this.fileBusy[id];
      delete this.fileError[id];
    },

    async downloadKeptFile(id: number): Promise<void> {
      this.fileBusy[id] = true;
      delete this.fileError[id];
      try {
        await saveThroughBrowser(keptFileUrl(id), KEPT_DOWNLOAD_REFUSALS);
      } catch (e: any) {
        this.fileError[id] = e.message;
        throw e;
      } finally {
        delete this.fileBusy[id];
      }
    },

    // Remove a kept file from the server. The transfer that received it stays,
    // marked deleted; its new row arrives as a `dcc-transfer` frame.
    async deleteKeptFile(id: number): Promise<void> {
      this.fileBusy[id] = true;
      delete this.fileError[id];
      try {
        await api(`/api/dcc/files/${id}`, { method: 'DELETE' });
        this.dropFile(id);
      } catch (e: any) {
        this.fileError[id] = e?.message || 'delete failed';
        throw e;
      } finally {
        delete this.fileBusy[id];
      }
    },

    // What the account may do. Asked once per panel open, so a grant an admin
    // changed shows the next time.
    async loadAccount(): Promise<DccAccountConfig | null> {
      try {
        this.account = await api<DccAccountConfig>('/api/dcc/config');
      } catch {
        // The send controls stay hidden; the actions say why if used anyway.
      }
      return this.account;
    },

    // Offer one of the account's files to a peer (#1086). Resolves with the
    // transfer, `offered`; it goes on through the live frames.
    async sendFile(
      networkId: number,
      nick: string,
      fileId: number,
      passive = false,
      secure = false,
    ): Promise<DccTransfer> {
      this.fileBusy[fileId] = true;
      delete this.fileError[fileId];
      try {
        const { transfer } = await api<{ transfer: DccTransfer }>('/api/dcc/send', {
          method: 'POST',
          body: { networkId, nick, fileId, passive, secure },
        });
        this.applyTransfer(transfer);
        return transfer;
      } catch (e: any) {
        this.fileError[fileId] = e?.message || 'send failed';
        throw e;
      } finally {
        delete this.fileBusy[fileId];
      }
    },

    // Upload a file to become one of the account's DCC files, in chunks
    // through an upload session (#650), so no proxy's limit caps it and a
    // dropped request costs a chunk. Resolves with the kept file.
    async uploadFile(file: File): Promise<DccFile> {
      this.uploading = { name: file.name, percent: 0 };
      this.uploadError = '';
      try {
        const { file: kept } = await uploadInChunks<{ file: DccFile }>(file, {
          purpose: 'dcc-send',
          filename: file.name,
          onProgress: (percent) => {
            if (this.uploading) this.uploading.percent = percent;
          },
        });
        this.applyFile(kept);
        return kept;
      } catch (e: any) {
        this.uploadError = e?.message || 'upload failed';
        throw e;
      } finally {
        this.uploading = null;
      }
    },

    // The DCC window's pick: send `fileId` to who it is picking for, and show
    // the transfer.
    async sendPicked(fileId: number): Promise<DccTransfer | null> {
      const pick = this.pick;
      if (!pick) return null;
      const transfer = await this.sendFile(
        pick.networkId,
        pick.nick,
        fileId,
        pick.passive,
        pick.secure === true,
      );
      this.pick = null;
      return transfer;
    },

    // "Send File (DCC)…" on a nick (#1085): pick a file for them. The server
    // makes it passive when it can't listen (#1154). `secure` is the "Secure
    // Send File" entry: an SSEND (#1157).
    openSendTo(networkId: number, nick: string, secure = false): void {
      this.openToSend({ networkId, nick, passive: false, secure });
    },

    // `/dcc send <nick>` with no file: open Files to pick one, or upload one.
    openToSend(pick: DccSendPick): void {
      this.open();
      this.pick = pick;
    },

    // Offer a DCC chat to a peer. Resolves as soon as the offer is away — the
    // outcome (connected, refused, timed out) arrives as notices in the `=nick`
    // buffer, which materializes from those notices, so there is nothing useful
    // to await here.
    async openChat(
      networkId: number,
      nick: string,
      passive = false,
      secure = false,
    ): Promise<void> {
      await api('/api/dcc/chat', { method: 'POST', body: { networkId, nick, passive, secure } });
    },

    async closeChat(networkId: number, nick: string): Promise<void> {
      await api('/api/dcc/chat/close', { method: 'POST', body: { networkId, nick } });
    },

    // Open the DCC window, and (re)load the DCC lists when DCC runs here. Used
    // by the DCC button, the status bar, offer toasts, `/dcc` and `/xdcc`.
    // Load errors surface in the window (listError, filesError).
    open(): void {
      this.panelOpen = true;
      this.pick = null;
      if (!useConfigStore().features.dcc) return;
      void this.loadAccount();
      this.load().catch(() => {
        /* surfaced via listError */
      });
      this.loadFiles().catch(() => {
        /* surfaced via filesError */
      });
    },
    close(): void {
      this.panelOpen = false;
      this.pick = null;
    },

    // With every snapshot, on an instance that runs DCC: both lists, so the
    // panel's button shows whenever the account has anything in it, and what
    // changed while the socket was down (frames nobody heard) is caught up.
    async resync(): Promise<void> {
      const config = useConfigStore();
      await config.fetch();
      if (!config.features.dcc) return;
      void this.loadAccount();
      this.load().catch(() => {});
      this.loadFiles().catch(() => {});
    },
  },
});
