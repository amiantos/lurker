// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// `/nickmeta`: metadata you set on somebody else, seen only by you (#1449).
// Pure, like the other command helpers; the composer sends what this answers.
//
//   /nickmeta <nick>                     what you set on them
//   /nickmeta <nick> name <name>|hide    a display name, or hide theirs
//   /nickmeta <nick> avatar hide         hide their avatar
//   /nickmeta <nick> color <n>|<#hex>    a colour of your nick palette
//   /nickmeta <nick> tz <zone>           an IANA time zone
//   /nickmeta <nick> -<field>            back to whatever they set

import { METADATA_COLOR_KEY, METADATA_TZ_KEY } from '../../../../shared/metadataKeys.js';
import type { NickMetadataKey } from '../../../../shared/nickMetadata.js';

export type NickMetaCommand =
  | { op: 'list'; nick: string }
  | { op: 'set'; nick: string; key: NickMetadataKey; value: string | null }
  | { op: 'reset'; nick: string; key: NickMetadataKey }
  | { error: string };

export const NICKMETA_USAGE =
  'usage: /nickmeta <nick> · /nickmeta <nick> name <name>|hide · avatar hide · color <n>|<#hex> · tz <zone> · /nickmeta <nick> -<field>';

const FIELDS: Record<string, NickMetadataKey> = {
  name: 'display-name',
  displayname: 'display-name',
  'display-name': 'display-name',
  avatar: 'avatar',
  color: METADATA_COLOR_KEY,
  colour: METADATA_COLOR_KEY,
  tz: METADATA_TZ_KEY,
  timezone: METADATA_TZ_KEY,
  zone: METADATA_TZ_KEY,
};

export interface NickMetaContext {
  /** How many colours the nick palette has; `color <n>` counts from 1. */
  paletteSize: number;
  /** The palette slot nearest a hex, or -1 when the text is no colour. */
  snap(hex: string): number;
  /** Whether this browser knows the zone. */
  knowsZone(zone: string): boolean;
}

export function parseNickMetaCommand(argLine: string, ctx: NickMetaContext): NickMetaCommand {
  const words = argLine.trim().split(/\s+/).filter(Boolean);
  const [nick, rawField] = words;
  if (!nick) return { error: NICKMETA_USAGE };
  if (!rawField) return { op: 'list', nick };

  const resetting = rawField.startsWith('-');
  const key = FIELDS[(resetting ? rawField.slice(1) : rawField).toLowerCase()];
  if (!key) return { error: `/nickmeta: no field "${rawField}" (name, avatar, color, tz)` };
  if (resetting) return { op: 'reset', nick, key };

  // The value as typed after the field, inner spacing kept (a display name).
  const value = argLine.trim().replace(/^\S+\s+\S+\s*/, '');
  if (!value) return { error: NICKMETA_USAGE };
  const hide = value.toLowerCase() === 'hide';

  switch (key) {
    case 'display-name':
      return { op: 'set', nick, key, value: hide ? null : value };
    case 'avatar':
      return hide
        ? { op: 'set', nick, key, value: null }
        : { error: '/nickmeta: an avatar can only be hidden: /nickmeta <nick> avatar hide' };
    case METADATA_COLOR_KEY: {
      if (!ctx.paletteSize) return { error: '/nickmeta: the nick palette is empty' };
      let slot = -1;
      if (/^\d+$/.test(value)) {
        const n = Number(value);
        if (n >= 1 && n <= ctx.paletteSize) slot = n - 1;
      } else {
        slot = ctx.snap(value);
      }
      if (slot < 0) {
        return {
          error: `/nickmeta: a color is 1 to ${ctx.paletteSize} (your nick palette) or a #hex, which takes the nearest`,
        };
      }
      return { op: 'set', nick, key, value: String(slot) };
    }
    default:
      return ctx.knowsZone(value)
        ? { op: 'set', nick, key, value }
        : { error: `/nickmeta: "${value}" isn't a time zone (like Europe/Berlin)` };
  }
}
