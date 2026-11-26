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

import {
  METADATA_COLOR_KEY,
  METADATA_TZ_KEY,
  METADATA_VALUE_MAX_CHARS,
  normalizeTimeZone,
} from '../../../../shared/metadataKeys.js';
import { isChannelTarget } from '../../../../shared/channels.js';
import { stripFormatting } from '../../../../shared/textMatch.js';
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
  /** The palette slot nearest a hex in tint, or -1 for no colour or one with no tint. */
  snap(hex: string): number;
  /** Whether a nick is our own on this network. */
  isSelf(nick: string): boolean;
}

export function parseNickMetaCommand(argLine: string, ctx: NickMetaContext): NickMetaCommand {
  const words = argLine.trim().split(/\s+/).filter(Boolean);
  const [nick, rawField] = words;
  if (!nick) return { error: NICKMETA_USAGE };
  // Metadata is set on a person. Ours has its own commands and its own editor.
  if (isChannelTarget(nick)) return { error: `/nickmeta: ${nick} is a channel, not a nick` };
  if (ctx.isSelf(nick)) {
    return { error: '/nickmeta is for other people; yours is /displayname, /color, /tz' };
  }
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
    case 'display-name': {
      if (hide) return { op: 'set', nick, key, value: null };
      // The server's rules, said here: it refuses these without a word.
      const max = METADATA_VALUE_MAX_CHARS['display-name'];
      if (value.length > max) return { error: `/nickmeta: a name is at most ${max} characters` };
      if (!stripFormatting(value).trim()) {
        return { error: '/nickmeta: that name is only formatting codes' };
      }
      return { op: 'set', nick, key, value };
    }
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
          error: `/nickmeta: a color is 1 to ${ctx.paletteSize} (your nick palette), or a #hex with a tint, which takes the nearest`,
        };
      }
      return { op: 'set', nick, key, value: String(slot) };
    }
    default: {
      const zone = normalizeTimeZone(value);
      return zone
        ? { op: 'set', nick, key, value: zone }
        : { error: `/nickmeta: "${value}" isn't a time zone (like Europe/Berlin)` };
    }
  }
}
