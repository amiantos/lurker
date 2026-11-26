// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// IRCv3 metadata keys (#607, #1189): what a key may be named and how long a
// value Lurker keeps may be. The server's vetting (ircMetadata.ts) and the
// profile editor read the same numbers.

export const METADATA_KEY_RE = /^[a-z0-9_./-]+$/;

// A user's colour (#1452) and time zone (#1450). The zone is Lurker's own key,
// so it carries a vendor prefix, as the spec asks of a non-standard key.
export const METADATA_COLOR_KEY = 'color';
export const METADATA_TZ_KEY = 'lurker.chat/tz';

// The keys Lurker shows, in order of preference: a server with a small
// `max-subs` grants the first. A `color` is never painted as sent (#607: hex
// values fight every theme); a client adapts it to its theme's nick palette
// (#1452). The profile editor's fields too (#1189).
export const METADATA_SUB_KEYS = [
  'display-name',
  'avatar',
  'pronouns',
  'homepage',
  'status',
  METADATA_COLOR_KEY,
  METADATA_TZ_KEY,
];

// Values longer than this are dropped rather than truncated: a truncated URL
// is a different URL, and a truncated name reads as someone else's.
export const METADATA_VALUE_MAX_CHARS: Readonly<Record<string, number>> = {
  'display-name': 64,
  pronouns: 64,
  status: 200,
  homepage: 2048,
  avatar: 2048,
  [METADATA_COLOR_KEY]: 7,
  [METADATA_TZ_KEY]: 64,
};

/**
 * A metadata colour as `#rrggbb`, lower case, or null when it isn't one. Only
 * the hex forms are read (`#rgb`, `#rrggbb`): a CSS name or `rgb()` some
 * clients write would need a CSS parser on every platform to mean the same.
 */
export function normalizeMetadataColor(value: string | null | undefined): string | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec((value ?? '').trim());
  if (!m) return null;
  const hex = m[1].toLowerCase();
  return `#${hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex}`;
}

// An IANA zone name's alphabet. Checked before Intl sees the value: Intl also
// takes a bare offset (`+01:00`), which is not a zone and has no DST.
const TIME_ZONE_RE = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/;

// The zones this runtime lists, by lower-cased name, to give a zone typed in
// the wrong case its usual spelling. Built on first use.
let zonesByLower: Map<string, string> | null = null;
function listedZone(lower: string): string | undefined {
  if (!zonesByLower) {
    zonesByLower = new Map();
    try {
      for (const zone of Intl.supportedValuesOf('timeZone'))
        zonesByLower.set(zone.toLowerCase(), zone);
    } catch {
      // A runtime too old to list them: zones keep the spelling they came in.
    }
  }
  return zonesByLower.get(lower);
}

/**
 * An IANA time zone this runtime knows, or null. The name is the one given:
 * only its case is put right (`europe/berlin` reads as `Europe/Berlin`).
 * ⚠ Not `resolvedOptions().timeZone`: that answers with the runtime's
 * canonical zone, which for a renamed one is the OLD name (`Europe/Kyiv`
 * comes back `Europe/Kiev`, `Asia/Kolkata` as `Asia/Calcutta`) and for an
 * alias a different place altogether (`EST` as `America/Panama`).
 */
export function normalizeTimeZone(value: string | null | undefined): string | null {
  const zone = (value ?? '').trim();
  if (!zone || zone.length > 64 || !TIME_ZONE_RE.test(zone)) return null;
  let canonical: string;
  try {
    canonical = new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
  const lower = zone.toLowerCase();
  return listedZone(lower) ?? (canonical.toLowerCase() === lower ? canonical : zone);
}

// A key Lurker doesn't show, bounded like a status.
export const METADATA_EXTRA_VALUE_MAX_CHARS = 512;

// A change to our own metadata: one key (null unsets it), or all of them.
export type OwnMetadataWrite = { key: string; value: string | null } | 'clear';

/**
 * Why our own metadata can't be set on a network now, or null when it can:
 * connected, with the cap and room for a key (soju offers the cap with
 * max-keys=0 and refuses a SET on `*`). The server and the client say the same.
 */
export function ownMetadataRefusal(
  connected: boolean,
  limits: { maxKeys: number | null } | null | undefined,
): string | null {
  if (!connected) return 'not connected';
  if (!limits) return "this network doesn't support IRCv3 metadata";
  if (limits.maxKeys === 0) return "this network doesn't keep metadata for you";
  return null;
}
