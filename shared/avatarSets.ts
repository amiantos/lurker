// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Uploaded avatar tile sets (#607): the limits and name rules both sides
// agree on. A set is a zip of square images a user uploads; the server
// normalises every tile to AVATAR_TILE_SIZE WebP and stores them as blobs, and
// look.avatars.set points at one by id (the bundled ones are shared/avatarTiles.ts).

export const AVATAR_SET_NAME_MAX = 40;
export const MAX_AVATAR_SETS_PER_USER = 5;
// A set needs enough tiles to tell nicks apart; past the ceiling it's not a
// tile set any more, it's a gallery.
export const AVATAR_SET_MIN_TILES = 4;
export const AVATAR_SET_MAX_TILES = 256;
// What one tile is stored as: square, WebP (alpha kept).
export const AVATAR_TILE_SIZE = 256;
export const AVATAR_TILE_EXT = 'webp';
// The zip itself, the entries the reader will walk before giving up, and one
// image's size before normalisation. yauzl enforces none of these.
export const AVATAR_SET_ZIP_MAX_BYTES = 24 * 1024 * 1024;
export const AVATAR_SET_ZIP_MAX_ENTRIES = 512;
export const AVATAR_SET_IMAGE_MAX_BYTES = 4 * 1024 * 1024;
// Decompressed bytes held in memory across every image read from one zip: a
// zip of compressible images could otherwise expand far past its own size.
export const AVATAR_SET_UNPACKED_MAX_BYTES = 64 * 1024 * 1024;

export const RESERVED_AVATAR_SET_NAMES = [
  'default',
  'ealain',
  'plain',
  'initial',
  'plain (light)',
  'plain (dark)',
  'initial (light)',
  'initial (dark)',
];

export interface AvatarSetSummary {
  id: number;
  name: string;
  count: number;
  bytes: number;
  createdAt: string;
}

export function normalizeAvatarSetName(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ');
}

/** '' when the name is usable, else why not. */
export function avatarSetNameError(raw: string): string {
  const name = normalizeAvatarSetName(raw);
  if (!name) return 'name is required';
  if (name.length > AVATAR_SET_NAME_MAX) return `name is too long (max ${AVATAR_SET_NAME_MAX})`;
  if (RESERVED_AVATAR_SET_NAMES.includes(name.toLowerCase())) return `"${name}" is reserved`;
  return '';
}
