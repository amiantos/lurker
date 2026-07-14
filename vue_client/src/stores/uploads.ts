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
  provider?: string;
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
          this.recent.unshift({
            id: result.id,
            provider: undefined, // server-only field; recent-uploads modal will re-fetch if it cares
            url: result.url,
            filename,
            mime,
            can_delete: !!result.can_delete,
            ...(thumbnail_url ? { thumbnail_url } : {}),
          });
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

    async loadRecent() {
      if (this.loading) return;
      this.loading = true;
      this.listError = '';
      try {
        const { items } = await api('/api/uploads?limit=50');
        this.recent = items || [];
        this.cursor = this.recent.length ? this.recent[this.recent.length - 1].id : null;
        this.hasMore = this.recent.length === 50;
        this.loaded = true;
      } catch (e: any) {
        this.listError = e.message || 'failed to load uploads';
        throw e;
      } finally {
        this.loading = false;
      }
    },

    async loadMore() {
      if (this.loading || !this.hasMore || this.cursor == null) return;
      this.loading = true;
      try {
        const { items } = await api(`/api/uploads?before=${this.cursor}&limit=50`);
        this.recent.push(...(items || []));
        if (items && items.length) {
          this.cursor = items[items.length - 1].id;
          this.hasMore = items.length === 50;
        } else {
          this.hasMore = false;
        }
      } catch (e: any) {
        this.listError = e.message || 'failed to load more';
      } finally {
        this.loading = false;
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
