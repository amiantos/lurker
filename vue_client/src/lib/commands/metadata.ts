// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// `/metadata`, `/avatar` and `/displayname` (IRCv3 draft/metadata-2, #607):
// the lines they put on the wire. Pure, like the other command helpers. The
// server echoes the reply (a 761 per key, or a FAIL) where a /command's reply
// goes, so nothing here needs an answer.
//
//   /metadata set <key> <value>      METADATA * SET <key> :<value>
//   /metadata del <key>              METADATA * SET <key>        (no value unsets)
//   /metadata list [nick|#chan]      METADATA <target> LIST
//   /metadata clear                  METADATA * CLEAR
//   /avatar <url> | off              the avatar key
//   /displayname <name> | off        the display-name key
//   /color <#rrggbb> | off           the color key (#1452)
//   /tz <zone> | off                 the timezone key (#1450)
//
// A change to our own keys says what it writes too (#1189): the server saves
// it from the answer, and the client refuses it where it can't go.

import {
  METADATA_COLOR_KEY,
  METADATA_KEY_RE,
  METADATA_TZ_KEY,
  normalizeMetadataColor,
  normalizeTimeZone,
  ownMetadataRefusal as refusalFor,
  type OwnMetadataWrite,
} from '../../../../shared/metadataKeys.js';
import type { NetworkState } from '../../stores/networks.js';

export type MetadataCommand = { line: string; write?: OwnMetadataWrite } | { error: string };

const USAGE =
  'usage: /metadata set <key> <value> · /metadata del <key> · /metadata list [nick|#chan] · /metadata clear';

function setLine(key: string, value: string | null): MetadataCommand {
  if (!METADATA_KEY_RE.test(key)) {
    return { error: `invalid metadata key: ${key} (a-z, 0-9, _ . / -)` };
  }
  const clean = value === null ? null : value.replace(/[\r\n\0]/g, '').trim();
  return {
    line: clean ? `METADATA * SET ${key} :${clean}` : `METADATA * SET ${key}`,
    write: { key, value: clean || null },
  };
}

/** Why our own metadata can't be set on this network now, or null when it can. */
export function ownMetadataRefusal(state: NetworkState | undefined): string | null {
  return refusalFor(state?.state === 'connected', state?.metadataLimits);
}

/** `/metadata <sub> …` → the wire line, or what to tell the user. */
export function parseMetadataCommand(argLine: string): MetadataCommand {
  const trimmed = argLine.trim();
  const space = trimmed.search(/\s/);
  const sub = (space < 0 ? trimmed : trimmed.slice(0, space)).toLowerCase();
  const rest = space < 0 ? '' : trimmed.slice(space + 1).trim();
  switch (sub) {
    case 'set': {
      const at = rest.search(/\s/);
      if (!rest || at < 0) return { error: 'usage: /metadata set <key> <value>' };
      return setLine(rest.slice(0, at).toLowerCase(), rest.slice(at + 1));
    }
    case 'del':
    case 'unset':
    case 'delete': {
      if (!rest || /\s/.test(rest)) return { error: 'usage: /metadata del <key>' };
      return setLine(rest.toLowerCase(), null);
    }
    case 'list': {
      const target = rest.split(/\s+/)[0] || '*';
      return { line: `METADATA ${target} LIST` };
    }
    case 'clear':
      return { line: 'METADATA * CLEAR', write: 'clear' };
    default:
      return { error: USAGE };
  }
}

/** `/avatar <url>` or `/avatar off`. */
export function parseAvatarCommand(argLine: string): MetadataCommand {
  const value = argLine.trim();
  if (!value) return { error: 'usage: /avatar <https://…/image.png> · /avatar off' };
  if (value.toLowerCase() === 'off') return setLine('avatar', null);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { error: 'the avatar must be an http(s) URL' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { error: 'the avatar must be an http(s) URL' };
  }
  return setLine('avatar', value);
}

/** `/displayname <name>` or `/displayname off`. */
export function parseDisplayNameCommand(argLine: string): MetadataCommand {
  const value = argLine.trim();
  if (!value) return { error: 'usage: /displayname <name> · /displayname off' };
  if (value.toLowerCase() === 'off') return setLine('display-name', null);
  return setLine('display-name', value);
}

/** `/color <#rrggbb>` or `/color off`: the colour we ask other clients to show us in. */
export function parseColorCommand(argLine: string): MetadataCommand {
  const value = argLine.trim();
  if (!value) return { error: 'usage: /color <#rrggbb> · /color off' };
  if (value.toLowerCase() === 'off') return setLine(METADATA_COLOR_KEY, null);
  const hex = normalizeMetadataColor(value);
  return hex ? setLine(METADATA_COLOR_KEY, hex) : { error: 'the color must be a hex: #rrggbb' };
}

/** `/tz <zone>` or `/tz off`: our time zone, as an IANA name. */
export function parseTzCommand(argLine: string): MetadataCommand {
  const value = argLine.trim();
  if (!value) return { error: 'usage: /tz <zone, like Europe/Berlin> · /tz off' };
  if (value.toLowerCase() === 'off') return setLine(METADATA_TZ_KEY, null);
  const zone = normalizeTimeZone(value);
  return zone
    ? setLine(METADATA_TZ_KEY, zone)
    : { error: `"${value}" isn't a time zone (like Europe/Berlin)` };
}
