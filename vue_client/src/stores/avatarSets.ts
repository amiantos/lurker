// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Avatar tile sets (#607): the bundled sets (shared/avatarTiles.ts, the tile
// ones under public/avatars/) and the sets the user uploaded
// (/api/avatar-sets), plus the pointer that picks one (look.avatars.set,
// 'initial' out of the box). Answers "which image goes
// on this nick's tile" — the nick colour behind it is the nick colour's
// business, and a metadata avatar replaces the whole tile where one is set
// (NickAvatar.vue).
//
// Uploaded sets refetch on the 'avatar-sets-changed' socket frame and on every
// (re)connect, the themes contract; the bundled set's manifest is fetched once.

import { defineStore } from 'pinia';
import { api, apiMultipart } from '../api.js';
import { useSettingsStore } from './settings.js';
import {
  BUILTIN_AVATAR_SETS,
  DEFAULT_AVATAR_SET,
  DEFAULT_STOP_CHARS,
  tileIndex,
  tileUrl,
  type AvatarInk,
  type AvatarSetManifest,
  type BuiltinAvatarSet,
} from '../../../shared/avatarTiles.js';
import { AVATAR_TILE_EXT, type AvatarSetSummary } from '../../../shared/avatarSets.js';

export const AVATAR_SET_POINTER_KEY = 'look.avatars.set';

/** One set as the UI and the tile picker see it: bundled or uploaded. */
export interface AvatarSetEntry {
  id: string;
  name: string;
  count: number;
  builtin: boolean;
  baseUrl: string;
  ext: string;
  // `initial` draws a letter instead of a tile; `plain` is one silhouette kept
  // in both inks, and the tile's colour says which (`inkBaseUrls`).
  kind: 'tiles' | 'initial' | 'plain';
  inkBaseUrls?: Readonly<Record<AvatarInk, string>>;
}

// Where a bundled set's manifests are: one per directory of tiles.
function manifestUrls(set: BuiltinAvatarSet): string[] {
  if (set.kind === 'tiles') return set.url ? [set.url] : [];
  if (set.kind === 'plain') return set.urls ? [set.urls.light, set.urls.dark] : [];
  return [];
}

export const useAvatarSetsStore = defineStore('avatarSets', {
  state: () => ({
    // Each bundled tile directory's manifest by its URL, once fetched; absent
    // until then (no tile).
    builtinManifests: {} as Record<string, AvatarSetManifest>,
    builtinLoad: null as Promise<void> | null,
    // The user's uploaded sets, as the server lists them.
    saved: [] as AvatarSetSummary[],
    loaded: false,
  }),
  getters: {
    /** The bundled sets first, then the uploaded ones (server keeps them name-sorted). */
    all(state): AvatarSetEntry[] {
      const bundled: AvatarSetEntry[] = BUILTIN_AVATAR_SETS.map((set) => {
        // A Plain set's two directories hold the same tiles; the light one
        // speaks for the count.
        const url = set.kind === 'plain' ? (set.urls?.light ?? '') : (set.url ?? '');
        const manifest = state.builtinManifests[url];
        return {
          id: set.id,
          name: set.name,
          count: set.kind === 'initial' ? 1 : (manifest?.count ?? 0),
          builtin: true,
          baseUrl: set.kind === 'initial' ? '' : url,
          ext: set.kind === 'initial' ? '' : (manifest?.ext ?? AVATAR_TILE_EXT),
          kind: set.kind,
          inkBaseUrls: set.urls,
        };
      });
      return [
        ...bundled,
        ...state.saved.map((s) => ({
          id: String(s.id),
          name: s.name,
          count: s.count,
          builtin: false,
          baseUrl: `/api/avatar-sets/${s.id}`,
          ext: AVATAR_TILE_EXT,
          kind: 'tiles' as const,
        })),
      ];
    },
    byId(): (id: string) => AvatarSetEntry | null {
      return (id: string) => this.all.find((s) => s.id === id) || null;
    },
    /** The pointer, resolved; one at a set we don't have falls back to the registry default. */
    activeSetId(): string {
      const settings = useSettingsStore();
      const id = String(settings.effective(AVATAR_SET_POINTER_KEY) ?? DEFAULT_AVATAR_SET);
      return this.byId(id) ? id : DEFAULT_AVATAR_SET;
    },
    activeSet(): AvatarSetEntry {
      return this.byId(this.activeSetId) || this.all[0];
    },
    // The tile image for a nick, or null while the set has no tiles to pick
    // from (the coloured square still shows). `ink` is what reads on the
    // nick's colour: a Plain set has its silhouette in each.
    tileFor(state): (nick: string, ink: AvatarInk) => string | null {
      return (nick: string, ink: AvatarInk) => {
        const set = this.activeSet;
        if (!set || set.kind === 'initial') return null;
        let baseUrl = set.baseUrl;
        let count = set.count;
        let ext = set.ext;
        if (set.kind === 'plain') {
          baseUrl = set.inkBaseUrls?.[ink] ?? '';
          const manifest = state.builtinManifests[baseUrl];
          count = manifest?.count ?? 0;
          ext = manifest?.ext ?? AVATAR_TILE_EXT;
        }
        if (count <= 0) return null;
        const settings = useSettingsStore();
        const stopChars = String(
          settings.effective('look.nick.color_stop_chars') ?? DEFAULT_STOP_CHARS,
        );
        const index = tileIndex(nick, count, stopChars);
        return index < 0 ? null : tileUrl(baseUrl, index, ext);
      };
    },
  },
  actions: {
    // Fetch every bundled set's manifest once. Safe to call from every tile:
    // one request each, and a failure leaves those squares plain rather than
    // retrying on every render. Revalidated every time: a rebuilt set changes
    // the count, and a copy the browser kept would point tiles at files that
    // are gone.
    ensureBuiltins(): Promise<void> {
      if (this.builtinLoad) return this.builtinLoad;
      if (typeof fetch !== 'function') return Promise.resolve();
      const missing = BUILTIN_AVATAR_SETS.flatMap(manifestUrls).filter(
        (url) => !this.builtinManifests[url],
      );
      if (missing.length === 0) return Promise.resolve();
      this.builtinLoad = (async () => {
        await Promise.all(
          missing.map(async (url) => {
            try {
              const res = await fetch(`${url}/manifest.json`, { cache: 'no-cache' });
              if (!res.ok) return;
              const body = (await res.json()) as Partial<AvatarSetManifest>;
              const count = Number(body.count);
              if (!Number.isInteger(count) || count <= 0) return;
              this.builtinManifests[url] = {
                count,
                ext: typeof body.ext === 'string' ? body.ext : AVATAR_TILE_EXT,
              };
            } catch {
              /* no fetch here (tests), or the set is missing: plain squares */
            }
          }),
        );
      })();
      return this.builtinLoad;
    },
    hydrate(items: AvatarSetSummary[]) {
      this.saved = items;
      this.loaded = true;
    },
    async fetchAll() {
      const { items } = await api('/api/avatar-sets');
      this.hydrate(items);
    },
    /** Upload a zip as a new set; resolves to the set and what was skipped. */
    async upload(
      name: string,
      zip: File | Blob,
      onProgress?: (percent: number) => void,
    ): Promise<{ set: AvatarSetSummary; skipped: Array<{ name: string; reason: string }> }> {
      const fd = new FormData();
      fd.append('name', name);
      fd.append('zip', zip, 'set.zip');
      const result = await apiMultipart('/api/avatar-sets', fd, { onProgress });
      await this.fetchAll();
      return result;
    },
    async remove(id: number) {
      await api(`/api/avatar-sets/${id}`, { method: 'DELETE' });
      // The server resets a pointer that dangled; its settings broadcast and
      // the avatar-sets-changed frame follow. Refresh the list now for this tab.
      await this.fetchAll();
    },
    /** Point generated avatars at a set. */
    async use(id: string) {
      await useSettingsStore().setValue(AVATAR_SET_POINTER_KEY, id);
    },
  },
});
