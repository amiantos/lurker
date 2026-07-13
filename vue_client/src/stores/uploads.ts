// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { defineStore } from 'pinia';
import { api, apiMultipart } from '../api.js';

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

export interface UploadCurrent {
  progress: number;
  filename: string | null;
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
      const fd = new FormData();
      const name = filename || (file instanceof File ? file.name : null) || 'upload';
      fd.append('image', file, name);
      this.current = {
        progress: 0,
        filename: filename || (file instanceof File ? file.name : null) || null,
      };
      this.failedAt = null;
      this.failedMessage = '';
      try {
        const result = await apiMultipart('/api/uploads', fd, {
          onProgress: (pct) => {
            if (this.current) this.current.progress = pct;
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
