// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { defineStore } from 'pinia';
import { api, apiMultipart } from '../api.js';
import { makeClientId } from '../utils/clientId.js';

// "Insert URL into MessageInput" needs to reach across the component tree.
// A tiny event bus pattern (Set of callbacks) keeps the modal independent of
// the input component — MessageInput subscribes on mount, unsubs on unmount.
const insertListeners = new Set<(url: string) => void>();
export function onInsertUrl(cb: (url: string) => void) {
  insertListeners.add(cb);
  return () => insertListeners.delete(cb);
}
function emitInsert(url: string) {
  for (const cb of insertListeners) {
    try {
      cb(url);
    } catch (_) {
      /* listener errors are not our problem */
    }
  }
}

const FAILURE_VISIBLE_MS = 10_000;
const PAGE_SIZE = 50;

/** The kinds the uploads browser filters by. Mirrors UPLOAD_KINDS on the server, which
 *  derives each one from the mime prefix. */
export type UploadKind = 'image' | 'video' | 'audio' | 'text';

function uploadsUrl({
  q,
  kind,
  before,
}: {
  q?: string;
  kind?: UploadKind | null;
  before?: number | null;
}): string {
  // URLSearchParams, not template concatenation: a filename search is arbitrary user
  // text and will contain `&`, `#`, `+` and spaces.
  const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (before != null) params.set('before', String(before));
  if (q) params.set('q', q);
  if (kind) params.set('kind', kind);
  return `/api/uploads?${params}`;
}

// The three legs of an upload, in the order they happen. Only the first is visible
// to the browser (#545):
//
//   uploading  — browser → server. Measured by xhr.upload; the ONLY thing the old
//                bar ever showed, which is why it read 100% and then sat there.
//   processing — the server's pipeline (sharp re-encode / metadata scrub). A native
//                one-shot with no seam to count, so it has no percentage.
//   sending    — server → provider. The long one on a home uplink. Has a percentage
//                when the driver can report bytes, and none when it can't (`local`
//                renames the temp file; there is no wire).
//
// `processing` is also the FALLBACK state: the store enters it the moment the
// browser leg finishes, without waiting for the server to say so. That alone kills
// the "Uploading: 100%" lie even if no WS frame ever arrives (an old server, a
// dropped socket) — the server's frames then refine it rather than enable it.
export type UploadPhase = 'uploading' | 'processing' | 'sending';

export interface UploadCurrent {
  // Correlates the server's progress frames with THIS upload. They fan out to every
  // socket the user has open, so a frame for anything else gets dropped.
  token: string;
  phase: UploadPhase;
  // 0-100, the browser→server leg.
  progress: number;
  // 0-100 for the server→provider leg, or null when the driver can't report bytes.
  sentPercent: number | null;
  // Human label of the uploader the server resolved ("Catbox", "Local disk"), so the
  // status bar can name where the file is going. Null until the server says.
  destination: string | null;
  filename: string | null;
}

export interface UploadProgressFrame {
  token: string;
  phase: 'processing' | 'sending';
  percent: number | null;
  destination: string | null;
}

export interface UploadItem {
  id: number;
  url: string;
  filename: string | null;
  mime: string | null;
  thumbnail_url?: string;
  // True when the hosted operator has moderated the upload away. The row stays
  // as a tombstone; its bytes are gone from storage.
  removed?: boolean;
  // True when deleting this row destroys the stored bytes. Rows without it get
  // no delete affordance at all — there is no "remove the record but leave the
  // file up" path (design decision 8).
  can_delete?: boolean;
}

export const useUploadsStore = defineStore('uploads', {
  state: () => ({
    // Active upload — drives the status-bar "Uploading: NN%" segment.
    current: null as UploadCurrent | null, // { progress: 0-100, filename: string|null }
    failedAt: null as number | null, // epoch ms; status-bar renders "Upload failed" until cleared
    failedMessage: '',

    recent: [] as UploadItem[], // paginated history rows
    cursor: null as number | null, // smallest id seen, used as `before=` for the next page
    hasMore: true,
    loaded: false,
    loading: false,
    listError: '',

    // The uploads browser's filters (#547). Server-side, unlike almost every other
    // filter in Lurker: the client only holds the pages it has scrolled through, and
    // the whole point is finding one it hasn't. `recent` therefore holds the RESULTS
    // of these filters, not the whole history — every consumer of it sees a filtered
    // view once a filter is set.
    query: '',
    kind: null as UploadKind | null,
    // Bumped on every filter change. A page that comes back from a superseded request
    // carries a stale generation and is dropped — otherwise a slow "scree" response
    // lands after the faster "screenshot" one and overwrites it.
    generation: 0,
  }),
  actions: {
    async upload(file: File | Blob, filename: string | null = null) {
      if (this.current) return; // Single concurrent upload — keeps the status bar coherent.
      const token = makeClientId();
      const fd = new FormData();
      const name = filename || (file instanceof File ? file.name : null) || 'upload';
      // Before the file, not after: multer populates req.body as fields stream past,
      // so a token appended behind a 200 MB file would not exist yet when the route
      // reads it.
      fd.append('progressToken', token);
      fd.append('image', file, name);
      this.current = {
        token,
        phase: 'uploading',
        progress: 0,
        sentPercent: null,
        destination: null,
        filename: filename || (file instanceof File ? file.name : null) || null,
      };
      this.failedAt = null;
      this.failedMessage = '';
      try {
        const result = await apiMultipart('/api/uploads', fd, {
          onProgress: (pct) => {
            if (!this.current) return;
            this.current.progress = pct;
            // The moment the browser leg is done, stop claiming to be uploading. This
            // is the whole of "tier 1": it needs no server cooperation, so the bar
            // stops lying even when the WS frames never come.
            if (pct >= 100 && this.current.phase === 'uploading') {
              this.current.phase = 'processing';
            }
          },
        });
        emitInsert(result.url);
        // Prepend the new row optimistically without a refetch. Prefer a remote
        // thumbnail URL the server returned (node edition stores thumbs on the
        // CDN); otherwise, for images, fall back to the local BLOB-serving route
        // — the same gate the server's GET response applies. Text uploads have
        // no thumbnail.
        if (this.loaded) {
          // Trust the server's mime — it's derived from the magic bytes, whereas
          // file.type is the browser's guess and can be wrong or absent. It decides
          // which type icon the row shows, so a lie here is visible.
          const mime: string | null = result.mime ?? (file.type || null);
          const isImage = typeof mime === 'string' && mime.startsWith('image/');
          const thumbnail_url =
            result.thumbnail_url || (isImage ? `/api/uploads/${result.id}/thumb` : undefined);
          const row: UploadItem = {
            id: result.id,
            url: result.url,
            // `name`, not `filename`: the server stores req.file.originalname, which IS
            // `name` (it's what we appended to the FormData). The optimistic row used
            // the nullable `filename` param, so a pasted image read "(pasted)" until a
            // reload turned it into "image.png". Harmless before; now that search
            // matches on this field, the optimistic row has to agree with the stored one.
            filename: filename || name,
            mime,
            can_delete: !!result.can_delete,
            ...(thumbnail_url ? { thumbnail_url } : {}),
          };
          // ⚠ `recent` holds the results of the browser's FILTERS now, not the whole
          // history (#547). Prepending unconditionally would put a row the user's
          // current search excludes at the top of their search results — and it would
          // vanish on the next reload, which reads like a bug. Only optimistically
          // insert what the active filter would actually have returned.
          if (this.matchesFilters(row)) this.recent.unshift(row);
        }
        return result;
      } catch (err: any) {
        this.failedAt = Date.now();
        this.failedMessage = err.message || 'upload failed';
        setTimeout(() => {
          if (this.failedAt && Date.now() - this.failedAt >= FAILURE_VISIBLE_MS - 50) {
            this.failedAt = null;
            this.failedMessage = '';
          }
        }, FAILURE_VISIBLE_MS);
        throw err;
      } finally {
        this.current = null;
      }
    },

    /**
     * A server progress frame (#545). Fans out to every socket the user has open, so
     * most of the guarding here is about frames that aren't ours:
     *
     *  - no active upload → another tab's, or one that already finished. Drop it.
     *  - token mismatch → another tab/device is uploading too. Drop it, or its bytes
     *    would drive this tab's bar.
     *  - phase went backwards → a delayed 'processing' frame arriving after 'sending'
     *    has begun would rewind the bar to indeterminate. WS ordering makes this
     *    unlikely, not impossible, and the cost of being wrong is a visibly jumping
     *    UI, so it's cheaper to enforce monotonicity than to trust the wire.
     */
    applyProgress(frame: UploadProgressFrame) {
      const cur = this.current;
      if (!cur || !frame?.token || frame.token !== cur.token) return;
      if (cur.phase === 'sending' && frame.phase === 'processing') return;

      cur.phase = frame.phase;
      if (frame.destination) cur.destination = frame.destination;
      cur.sentPercent = frame.phase === 'sending' ? (frame.percent ?? null) : null;
    },

    async uploadText(content: string, filename = 'message.txt') {
      // Long-message → .txt upload. Wrap the text in a Blob so it can ride
      // the same multipart endpoint as image uploads; the server branches on
      // text/plain and skips the sharp pipeline.
      const blob = new Blob([content], { type: 'text/plain' });
      return this.upload(blob, filename);
    },

    /**
     * Would the active filters have returned this row? Mirrors the server's WHERE
     * clause — substring on filename, mime prefix on kind — so an optimistically
     * inserted upload appears if and only if a refetch would have shown it.
     */
    matchesFilters(row: UploadItem): boolean {
      if (this.kind && !(row.mime || '').startsWith(`${this.kind}/`)) return false;
      if (!this.query) return true;
      return (row.filename || '').toLowerCase().includes(this.query.toLowerCase());
    },

    /** Apply the browser's filters and reload from the top (#547). */
    async setFilters({ query, kind }: { query?: string; kind?: UploadKind | null }) {
      if (query !== undefined) this.query = query;
      if (kind !== undefined) this.kind = kind;
      // A filtered result set is a different list, not a continuation of this one: the
      // old cursor points into the unfiltered sequence and would page the wrong rows.
      this.cursor = null;
      this.hasMore = true;
      await this.loadRecent();
    },

    async loadRecent() {
      // Deliberately does NOT bail while a load is in flight. A filter change must
      // SUPERSEDE the request it replaces — bailing would drop the newest keystroke's
      // results and leave the list showing the previous term's.
      const gen = ++this.generation;
      this.loading = true;
      this.listError = '';
      try {
        const { items } = await api(uploadsUrl({ q: this.query, kind: this.kind }));
        if (gen !== this.generation) return; // superseded by a newer filter
        this.recent = items || [];
        this.cursor = this.recent.length ? this.recent[this.recent.length - 1].id : null;
        this.hasMore = this.recent.length === PAGE_SIZE;
        this.loaded = true;
      } catch (e: any) {
        if (gen !== this.generation) return;
        this.listError = e.message || 'failed to load uploads';
        throw e;
      } finally {
        // Only the request that is still the current one owns the spinner.
        if (gen === this.generation) this.loading = false;
      }
    },

    async loadMore() {
      if (this.loading || !this.hasMore || this.cursor == null) return;
      const gen = this.generation;
      this.loading = true;
      try {
        const { items } = await api(
          uploadsUrl({ q: this.query, kind: this.kind, before: this.cursor }),
        );
        // The filters changed while this page was in flight — these rows belong to a
        // list that no longer exists. Appending them would mix two result sets.
        if (gen !== this.generation) return;
        this.recent.push(...(items || []));
        if (items && items.length) {
          this.cursor = items[items.length - 1].id;
          this.hasMore = items.length === PAGE_SIZE;
        } else {
          this.hasMore = false;
        }
      } catch (e: any) {
        if (gen !== this.generation) return;
        this.listError = e.message || 'failed to load more';
      } finally {
        if (gen === this.generation) this.loading = false;
      }
    },

    async remove(id: number) {
      await api(`/api/uploads/${id}`, { method: 'DELETE' });
      this.recent = this.recent.filter((u) => u.id !== id);
    },

    requestInsert(url: string) {
      emitInsert(url);
    },
  },
});
