// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Metadata a user sets on somebody else, for their own eyes (#1449). On a
// network with IRCv3 metadata it stands in front of what that person set; on
// one without, it is all there is. Kept per user + network + nick, like a nick
// note, and synced the same way: the server stores it, each client lays it
// over the wire record in its one metadata lookup (`effectiveMetadata`).

import { METADATA_COLOR_KEY, METADATA_TZ_KEY } from './metadataKeys.js';

// The keys that can be set on someone, in the order a picker offers them.
export const NICK_METADATA_KEYS = [
  'display-name',
  'avatar',
  METADATA_COLOR_KEY,
  METADATA_TZ_KEY,
] as const;
export type NickMetadataKey = (typeof NICK_METADATA_KEYS)[number];

// The keys where "hidden" is a value: theirs is not shown and nothing stands
// in for it. An avatar can only be hidden.
export const NICK_METADATA_HIDEABLE: ReadonlySet<string> = new Set(['display-name', 'avatar']);

/**
 * What one user has set on one nick: a key with a string is their value, a key
 * with null hides the other person's, and a key not there leaves it alone.
 * A colour's value is a slot of the nick palette (`"3"`), never a hex: it
 * stays on-theme through a theme change.
 */
export type NickMetadataValues = Record<string, string | null>;

export function isNickMetadataKey(key: unknown): key is NickMetadataKey {
  return typeof key === 'string' && (NICK_METADATA_KEYS as readonly string[]).includes(key);
}

/** A palette slot as stored, or null when the text isn't one. */
export function parseColorSlot(value: string | null | undefined): number | null {
  if (typeof value !== 'string' || !/^\d{1,4}$/.test(value)) return null;
  return Number(value);
}

// The fields of a metadata view the overlay can change.
interface OverlaidFields {
  displayName?: string;
  avatarUrl?: string | null;
  color?: string;
  tz?: string;
}

/**
 * A nick's metadata as this user sees it: the wire record with their own
 * values laid over it. `colorSlot` is set only by them; a client paints it
 * ahead of the wire `color`. Null when nothing is left to show.
 */
export function effectiveMetadata<T extends OverlaidFields>(
  wire: T | null | undefined,
  mine: NickMetadataValues | null | undefined,
): (T & { colorSlot?: number }) | null {
  if (!mine || Object.keys(mine).length === 0) return wire ?? null;
  const out = { ...wire } as T & { colorSlot?: number };
  if (Object.hasOwn(mine, 'display-name')) {
    const name = mine['display-name'];
    if (name) out.displayName = name;
    else delete out.displayName;
  }
  if (Object.hasOwn(mine, 'avatar') && mine.avatar === null) delete out.avatarUrl;
  const slot = parseColorSlot(mine[METADATA_COLOR_KEY]);
  if (slot !== null) out.colorSlot = slot;
  const zone = mine[METADATA_TZ_KEY];
  if (zone) out.tz = zone;
  return Object.keys(out).length ? out : null;
}
