// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { ref } from 'vue';
import { defineStore } from 'pinia';
import { mimeMatchesKind, type UploadKind } from '../../../shared/uploadKinds.js';
import { UPLOADS_RESTRICTED } from '../../../shared/accountRestrictions.js';
import { useAuthStore } from './auth.js';
import { api, apiMultipart } from '../api.js';
import { uploadInChunks } from '../lib/chunkedUpload.js';
import { makeClientId } from '../utils/clientId.js';

// "Insert URL into MessageInput" needs to reach across the component tree.
// A tiny event bus pattern (Set of callbacks) keeps the modal independent of
// the input component — MessageInput subscribes on mount, unsubs on unmount.
const insertListeners = new Set<(url: string) => void>();
// ⚠ Reactive mirror of the set's size, exposed as the `canInsert` getter. An
// insert affordance offered with nobody subscribed does NOTHING — silently, with
// no error anywhere — and that is not hypothetical: the mobile shell reaches the
// uploads browser from the buffer LIST screen, where MessageInput isn't mounted
// at all, and `hasInput` is false on virtual buffers that have no composer. A
// plain Set can't be watched, so the count is tracked alongside it.
const insertListenerCount = ref(0);
export function onInsertUrl(cb: (url: string) => void) {
  insertListeners.add(cb);
  insertListenerCount.value = insertListeners.size;
  return () => {
    const removed = insertListeners.delete(cb);
    insertListenerCount.value = insertListeners.size;
    return removed;
  };
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

// The browser's starred view fetches the whole curated set in one request instead
// of paging it (the server orders favourites by when you starred, which the
// id-keyset cursor can't page — see listUploads). FAVORITES_LIMIT mirrors the
// server's ceiling; hitting it is disclosed in the UI rather than silently
// truncating.
const FAVORITES_LIMIT = 200;
// The attach menu shows only the head of a list — enough to fill a couple of rows
// above the composer without becoming a second uploads browser. Same number in
// either mode: it is a function of the panel, not of what is in it.
const UPLOAD_MENU_LIMIT = 24;

// Re-exported so components keep importing the type from the store they already use.
// The definition — and the mime→kind rule both sides filter by — lives in shared/.
export type { UploadKind };

/** Which list the composer's attach menu is showing: the curated starred set, or
 *  the tail of everything uploaded. */
export type UploadMenuMode = 'favorites' | 'recent';

function uploadsUrl({
  q,
  kind,
  before,
  favorites,
  limit = PAGE_SIZE,
}: {
  q?: string;
  kind?: UploadKind | null;
  before?: number | null;
  favorites?: boolean;
  limit?: number;
}): string {
  // URLSearchParams, not template concatenation: a filename search is arbitrary user
  // text and will contain `&`, `#`, `+` and spaces.
  const params = new URLSearchParams({ limit: String(limit) });
  if (before != null) params.set('before', String(before));
  if (q) params.set('q', q);
  if (kind) params.set('kind', kind);
  if (favorites) params.set('favorites', '1');
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
  // Starred by the owner. Server-side state, so the same quick-access set is
  // there on every device.
  favorite?: boolean;
}

export const useUploadsStore = defineStore('uploads', {
  state: () => ({
    // Active upload — drives the status-bar "Uploading: NN%" segment.
    current: null as UploadCurrent | null, // { progress: 0-100, filename: string|null }
    failedAt: null as number | null, // epoch ms; status-bar renders "Upload failed" until cleared
    failedMessage: '',
    // The largest chunk an upload session takes (#650), from the snapshot. A
    // file bigger than one chunk goes in chunks; null (a server without
    // sessions) sends everything in one request, as before.
    chunkBytes: null as number | null,
    // The instance ceiling (#1131), from the snapshot and the settings frame:
    // the bound on the user's own cap setting, which the registry can't hold any
    // more because the admin sets it. null until a snapshot says.
    ceilingBytes: null as number | null,

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
    // The browser's "starred only" toggle. Orthogonal to `kind` — starred + images
    // is a meaningful view — so it's its own flag rather than another kind value.
    favoritesOnly: false,
    // Bumped on every filter change. A page that comes back from a superseded request
    // carries a stale generation and is dropped — otherwise a slow "scree" response
    // lands after the faster "screenshot" one and overwrites it.
    generation: 0,

    // ─── The composer's attach menu ────────────────────────────────────────────
    // Kept SEPARATE from `recent` on purpose: `recent` holds whatever the uploads
    // browser is currently filtered to, and the attach menu must not change
    // contents because someone left a search term in a modal.
    menuItems: [] as UploadItem[],
    // Which list is currently ON SCREEN.
    menuMode: 'favorites' as UploadMenuMode,
    // ⚠ Which list the user ASKED for, which is not the same thing and must not be
    // collapsed into it. openMenu falls back to 'recent' when nothing is starred,
    // and if that fallback wrote back to the preference it would latch: star your
    // first upload and the menu would still lead with 'recent' forever, because the
    // one time it was empty is the only time it ever checked.
    menuPreferredMode: 'favorites' as UploadMenuMode,
    menuLoading: false,
    menuError: '',
    // Bumped on every menu load. A page from a superseded request carries a stale
    // generation and is dropped — the menu's own copy of the guard `generation`
    // provides for the browser's list.
    menuGeneration: 0,
  }),
  getters: {
    // Is there a composer listening? Gates every "put this in my message"
    // affordance — see the note on insertListenerCount for why an ungated one is
    // a button that does nothing rather than a button that fails.
    canInsert(): boolean {
      return insertListenerCount.value > 0;
    },
    // The starred view came back full, so there may be more the server didn't send.
    // Surfaced in the modal rather than swallowed — a list that quietly stops at 200
    // reads as "these are all my favourites", which would be a lie.
    favoritesTruncated(state): boolean {
      return state.favoritesOnly && state.recent.length >= FAVORITES_LIMIT;
    },
  },
  actions: {
    // `avatar`: the profile editor's (#1189). The server crops it square, and
    // its URL goes into the editor's field, not the composer.
    async upload(
      file: File | Blob,
      filename: string | null = null,
      // `insert: false` hands the URL back to the caller alone rather than to
      // every composer listening (onInsertUrl): the thread panel's composer
      // puts it in its own reply, not in the channel's draft. An avatar is
      // never inserted.
      { avatar = false, insert = !avatar }: { avatar?: boolean; insert?: boolean } = {},
    ) {
      // An account held off the uploaders (shared/accountRestrictions.ts). The
      // composer and status bar hide their buttons; this is the gate for every
      // caller that doesn't, thrown so the caller's own failure path shows it.
      if (!useAuthStore().canUpload) throw new Error(UPLOADS_RESTRICTED);
      if (this.current) return; // Single concurrent upload — keeps the status bar coherent.
      const token = makeClientId();
      const fd = new FormData();
      const name = filename || (file instanceof File ? file.name : null) || 'upload';
      // Before the file, not after: multer populates req.body as fields stream past,
      // so a token appended behind a 200 MB file would not exist yet when the route
      // reads it.
      fd.append('progressToken', token);
      if (avatar) fd.append('purpose', 'avatar');
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
      const onProgress = (pct: number) => {
        if (!this.current) return;
        this.current.progress = pct;
        // The moment the browser leg is done, stop claiming to be uploading. This
        // is the whole of "tier 1": it needs no server cooperation, so the bar
        // stops lying even when the WS frames never come.
        if (pct >= 100 && this.current.phase === 'uploading') {
          this.current.phase = 'processing';
        }
      };
      try {
        const result =
          this.chunkBytes != null && file.size > this.chunkBytes
            ? await uploadInChunks(file, {
                purpose: avatar ? 'avatar' : 'upload',
                filename: name,
                progressToken: token,
                onProgress,
                onSent: () => onProgress(100),
              })
            : await apiMultipart('/api/uploads', fd, { onProgress });
        if (insert) emitInsert(result.url);
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
     * Would the active filters have returned this row? Shares one definition with the
     * server's WHERE clause (shared/uploadKinds.ts) — substring on filename,
     * mimeMatchesKind on kind — so an optimistically inserted upload appears if and
     * only if a refetch would have shown it. This used to hand-copy the rule as a
     * mime PREFIX test, which silently disagreed the moment a kind covered a mime
     * from outside its prefix (`application/json` under text, #788).
     */
    matchesFilters(row: UploadItem): boolean {
      // A fresh upload is never starred, so this also correctly keeps one out of an
      // active starred-only view rather than flashing it in until the next reload.
      if (this.favoritesOnly && !row.favorite) return false;
      if (this.kind && !mimeMatchesKind(row.mime, this.kind)) return false;
      if (!this.query) return true;
      return (row.filename || '').toLowerCase().includes(this.query.toLowerCase());
    },

    /** Apply the browser's filters and reload from the top (#547). */
    async setFilters({
      query,
      kind,
      favoritesOnly,
    }: {
      query?: string;
      kind?: UploadKind | null;
      favoritesOnly?: boolean;
    }) {
      if (query !== undefined) this.query = query;
      if (kind !== undefined) this.kind = kind;
      if (favoritesOnly !== undefined) this.favoritesOnly = favoritesOnly;
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
        const { items } = await api(
          uploadsUrl({
            q: this.query,
            kind: this.kind,
            favorites: this.favoritesOnly,
            limit: this.favoritesOnly ? FAVORITES_LIMIT : PAGE_SIZE,
          }),
        );
        if (gen !== this.generation) return; // superseded by a newer filter
        this.recent = items || [];
        this.cursor = this.recent.length ? this.recent[this.recent.length - 1].id : null;
        // The starred view arrives whole — there is no cursor that can page it (the
        // server orders it by when you starred, not by id), so infinite scroll has
        // nothing to ask for. The modal discloses it when the set hit the ceiling.
        this.hasMore = this.favoritesOnly ? false : this.recent.length === PAGE_SIZE;
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
        // `favorites` rides along even though loadRecent forces hasMore=false for
        // the starred view and this should never run there. Omitting it made the
        // back-fill page the UNFILTERED history — so the one bug this could have
        // is silently mixing unstarred rows into a starred list, guarded only by an
        // invariant three functions away. Passing the flag costs nothing.
        const { items } = await api(
          uploadsUrl({
            q: this.query,
            kind: this.kind,
            favorites: this.favoritesOnly,
            before: this.cursor,
          }),
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
      // The file is gone, so it cannot stay in the attach menu — in EITHER mode, or
      // the menu keeps offering to insert a URL that now 404s until a reload.
      this.menuItems = this.menuItems.filter((u) => u.id !== id);
    },

    /**
     * Load one page for the attach menu, in whichever mode it is in. Refetched on
     * every open rather than cached for the session: uploads and stars both happen
     * on other devices, and this is one small page either way.
     */
    async loadMenu(mode?: UploadMenuMode): Promise<boolean> {
      const next = mode ?? this.menuMode;
      // Same generation guard as loadRecent, and for the same reason: switching
      // modes leaves two requests in flight, and the SLOWER one can land last. A
      // stale 'recent' page committing after a 'starred' one would leave the panel
      // showing everything under a tab that says starred — and its `finally` would
      // clear a spinner the live request still owns. Opening the menu and
      // immediately tapping the other mode is the easy way to hit it on a phone.
      const gen = ++this.menuGeneration;
      this.menuLoading = true;
      this.menuError = '';
      try {
        const { items } = await api(
          uploadsUrl({ favorites: next === 'favorites', limit: UPLOAD_MENU_LIMIT }),
        );
        if (gen !== this.menuGeneration) return false;
        // ⚠ Moderated rows have to go. The favourites query already excludes them
        // server-side, but the unfiltered list returns them as tombstones — and a
        // tombstone in a menu whose only action is "insert this" would paste a URL
        // whose bytes are gone. The browser shows them because seeing WHY a file
        // vanished is the point there; here there is nothing to offer.
        this.menuItems = ((items || []) as UploadItem[]).filter((u) => !u.removed);
        // ⚠ The mode moves HERE, with the rows it describes — not when the request
        // was issued. `menuMode` is what `menuItems` currently holds, and a failed
        // switch must not leave the tab claiming 'recent' over the starred
        // thumbnails still on screen (setFavorite branches on this too, so a stale
        // pairing makes it maintain the wrong list). A switch that doesn't land
        // isn't a switch.
        this.menuMode = next;
      } catch (e: any) {
        if (gen !== this.menuGeneration) return false;
        this.menuError = e.message || 'failed to load uploads';
      } finally {
        // Only the request that is still the current one owns the spinner.
        if (gen === this.menuGeneration) this.menuLoading = false;
      }
      return gen === this.menuGeneration;
    },

    /** Switch lists because the user said so. The only thing that moves the
     *  preference — see menuPreferredMode for why that is not the same as the mode
     *  actually being displayed. */
    async selectMenuMode(mode: UploadMenuMode) {
      this.menuPreferredMode = mode;
      await this.loadMenu(mode);
    },

    /**
     * The menu was opened. Shows the starred set by default — that is the point of
     * having curated one — but falls back to recent uploads when nothing is starred,
     * so someone who has never used the feature gets a useful panel instead of an
     * empty tab above two buttons.
     *
     * Reads the PREFERENCE, and the fallback deliberately doesn't write to it: an
     * explicit switch to 'recent' sticks for the session, while a fallback is
     * re-decided on every open.
     */
    async openMenu() {
      // ⚠ Bail if our own load was superseded. Tapping a mode while the open's
      // fetch is still in flight is the common way in, and without this the
      // fallback below would read the WINNER's state and could fire a 'recent'
      // load over the choice the user just made explicitly.
      if (!(await this.loadMenu(this.menuPreferredMode))) return;
      if (this.menuMode === 'favorites' && !this.menuItems.length && !this.menuError) {
        await this.loadMenu('recent');
      }
    },

    /**
     * Star or unstar an upload. Applied to the local lists only AFTER the server
     * agrees — an optimistic star that failed would leave a quick-access entry the
     * next device never sees, which is worse than a beat of latency on a click.
     */
    async setFavorite(id: number, favorite: boolean) {
      await api(`/api/uploads/${id}/favorite`, { method: favorite ? 'PUT' : 'DELETE' });

      const row = this.recent.find((u) => u.id === id);
      if (row) row.favorite = favorite;
      // Keep the flag honest wherever the row also sits, so the menu doesn't need a
      // refetch to agree with the browser about what is starred.
      const menuRow = this.menuItems.find((u) => u.id === id);
      if (menuRow) menuRow.favorite = favorite;

      // Only the menu's FAVOURITES mode is a list of starred things; in 'recent' it
      // is showing everything, where a star is a property of a row rather than the
      // reason the row is there, and membership must not change.
      if (this.menuMode === 'favorites') {
        if (favorite) {
          // Front of the list, matching the server's "most recently starred first"
          // ordering — so what the user sees now is what a refetch returns.
          const known = row ?? menuRow;
          if (known)
            this.menuItems = [
              { ...known, favorite: true },
              ...this.menuItems.filter((u) => u.id !== id),
            ];
        } else {
          this.menuItems = this.menuItems.filter((u) => u.id !== id);
        }
      }

      // Unstarring from inside the browser's starred-only view: the row no longer
      // belongs to the list being displayed, so drop it instead of leaving an
      // unstarred tile sitting in a view that claims to show only starred ones.
      if (!favorite && this.favoritesOnly) this.recent = this.recent.filter((u) => u.id !== id);
    },

    requestInsert(url: string) {
      emitInsert(url);
    },
  },
});
