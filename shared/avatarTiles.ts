// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Generated avatar tiles (#607): which image of a set a nick gets. A tile is
// one image from the active set drawn over the nick's colour, so every nick
// has an avatar on every network, and a metadata avatar replaces it where one
// is set. Shared so the web client, the apps and the server pick the same
// image for the same nick.
//
// The nick is trimmed and lowercased the way the nick colour is (weechat's
// gui_nick_find_color: `bob_` and `bob` share one), then hashed with djb2 like
// the colour — but salted. The palette has 16 entries and a set may have 100,
// which share a factor, so the colour's own hash value modulo the count would
// leave three in four colour-and-tile pairs unreachable.

// What look.avatars.set points at out of the box, and where a dangling
// pointer falls back to.
export const DEFAULT_AVATAR_SET = 'initial';
// The art set: Ealain pieces with the colour keyed out (tools/build-avatar-set.mjs).
export const EALAIN_AVATAR_SET = 'ealain';

// What a letter, a silhouette or a placeholder glyph is drawn in over a tile's
// colour: near-white or near-black, whichever reads on it.
export type AvatarInk = 'light' | 'dark';

/**
 * The sets that ship with the client. A `tiles` set is static files under
 * `url` with a manifest.json; an `initial` set has no files — the client draws
 * the first letter of the name in the box; a `plain` set is one silhouette
 * kept in both inks (`urls`), and the tile's colour says which file.
 */
export interface BuiltinAvatarSet {
  id: string;
  name: string;
  kind: 'tiles' | 'initial' | 'plain';
  url?: string;
  urls?: Readonly<Record<AvatarInk, string>>;
}
export const BUILTIN_AVATAR_SETS: readonly BuiltinAvatarSet[] = [
  { id: EALAIN_AVATAR_SET, name: 'Ealain', kind: 'tiles', url: '/avatars/ealain' },
  // One tile, a bust silhouette — the generic avatar every chat app has — for
  // anyone who finds the art too much.
  {
    id: 'plain',
    name: 'Plain',
    kind: 'plain',
    urls: { light: '/avatars/plain-light', dark: '/avatars/plain-dark' },
  },
  // The first letter of the display name (or the nick), as many clients do.
  { id: 'initial', name: 'Initial', kind: 'initial' },
];
export function isBuiltinAvatarSetId(id: string): boolean {
  return BUILTIN_AVATAR_SETS.some((set) => set.id === id);
}
// Initial and Plain each came in a light and a dark ink the user chose between,
// until the ink followed the tile's colour. A pointer stored under one of the
// old ids means the set it became; any other id is returned as it is.
const LEGACY_AVATAR_SETS: Readonly<Record<string, string>> = {
  'initial-light': 'initial',
  'initial-dark': 'initial',
  'plain-light': 'plain',
  'plain-dark': 'plain',
};
export const LEGACY_AVATAR_SET_IDS: readonly string[] = Object.keys(LEGACY_AVATAR_SETS);
export function currentAvatarSetId(id: string): string {
  return Object.prototype.hasOwnProperty.call(LEGACY_AVATAR_SETS, id) ? LEGACY_AVATAR_SETS[id] : id;
}

// Above this relative luminance a tile's colour takes dark ink, at or below it
// light. The two built-in nick palettes sit either side: the dark theme's
// pastels start at 0.305 and the light theme's stop at 0.274, so each keeps
// the ink it was drawn for, and a palette that mixes both gets each tile right.
// Nearer the light palette's end than the middle of that gap, so the dark
// theme's muted grey (#939293, 0.289) keeps dark ink too: the apps draw a
// server line's mark on it. Every client carries this number.
export const AVATAR_INK_LUMINANCE = 0.28;

function linearChannel(c: number): number {
  const cs = c / 255;
  return cs <= 0.04045 ? cs / 12.92 : ((cs + 0.055) / 1.055) ** 2.4;
}
/** WCAG 2 relative luminance of an sRGB colour (channels 0..255), 0 (black) .. 1 (white). */
export function relativeLuminance({ r, g, b }: { r: number; g: number; b: number }): number {
  return 0.2126 * linearChannel(r) + 0.7152 * linearChannel(g) + 0.0722 * linearChannel(b);
}
/**
 * The ink for a tile of this colour. Null (a colour nothing could resolve)
 * takes dark ink, what the default palette's tiles take.
 */
export function avatarInk(color: { r: number; g: number; b: number } | null): AvatarInk {
  if (!color) return 'dark';
  return relativeLuminance(color) > AVATAR_INK_LUMINANCE ? 'dark' : 'light';
}
// The stop characters the nick colour uses by default (look.nick.color_stop_chars).
export const DEFAULT_STOP_CHARS = '_|';

export interface AvatarSetManifest {
  count: number;
  ext: string;
}

const TILE_SALT = 'avatar-tile:';

function trimForHash(nick: string, stopChars: string): string {
  let out = '';
  let seenOther = false;
  for (const ch of nick) {
    const isStop = stopChars.includes(ch);
    if (isStop && seenOther) break;
    if (!isStop) seenOther = true;
    out += ch;
  }
  return out;
}

function djb2(str: string): number {
  let h = 5381 >>> 0;
  for (const ch of str) {
    const cp = ch.codePointAt(0) as number;
    const term = (((h << 5) >>> 0) + (h >>> 2) + cp) >>> 0;
    h = (h ^ term) >>> 0;
  }
  return h;
}

/** The index in a set of `count` tiles for a nick, or -1 for nothing to pick. */
export function tileIndex(
  nick: string | null | undefined,
  count: number,
  stopChars: string = DEFAULT_STOP_CHARS,
): number {
  if (!nick || !Number.isFinite(count) || count <= 0) return -1;
  const normalized = trimForHash(nick, stopChars || '').toLowerCase();
  if (!normalized) return -1;
  return djb2(TILE_SALT + normalized) % Math.floor(count);
}

/** `<base>/<nnn>.<ext>`: tiles are numbered from 000 in file-name order. */
export function tileUrl(baseUrl: string, index: number, ext: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${String(index).padStart(3, '0')}.${ext}`;
}
