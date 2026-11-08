// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// IRCv3 metadata (draft/metadata-2): the pure parts. What the cap advertises,
// which keys Lurker subscribes to, how a server's metadata lines parse, and how
// a value is vetted before it reaches state. ircConnection.ts owns the state and
// the wire; nothing here touches either.
//
// ⚠ The spec's server message is `METADATA <target> <key> <vis> <value>`, but
// ergo (draft/metadata-3 behaviour behind the -2 name) sends live updates as
// `761 RPL_KEYVALUE * <target> <key> * <value>` and deletes as `766
// RPL_KEYNOTSET * <target> <key>`. Lists and syncs come as a `metadata` batch of
// 761s. All three shapes reduce to one change here.

import { isChannelTarget } from '../../shared/channels.js';
import {
  METADATA_EXTRA_VALUE_MAX_CHARS,
  METADATA_KEY_RE,
  METADATA_SUB_KEYS,
  METADATA_VALUE_MAX_CHARS,
  type OwnMetadataWrite,
} from '../../shared/metadataKeys.js';
import { stripFormatting } from '../../shared/textMatch.js';
import { parseLine } from './bouncerClientFilter.js';

export const METADATA_CAP = 'draft/metadata-2';

export { METADATA_SUB_KEYS };

// The avatar key may carry a `{size}` placeholder (IRCv3 registry); this is the
// pixel size Lurker asks for: what the previews decoder resizes an avatar to
// (lurker#1190), so an origin that honours it is never enlarged.
export const AVATAR_SIZE = 256;

// Days a departed nick's record still rides the snapshot (#1246): on disk it
// stays as long as they have a line to dress; on the wire, this long.
export const METADATA_ABSENT_SNAPSHOT_DAYS = 30;

// A key Lurker doesn't show but a bouncer client asked for is kept so a SUB
// can be answered from state, bounded by METADATA_EXTRA_VALUE_MAX_CHARS.
// Zero-width and joiner characters: a name made only of these is no name.
const INVISIBLE_RE = /[\u200b-\u200d\u2060\ufeff]/g;

export interface MetadataLimits {
  maxSubs: number | null;
  maxKeys: number | null;
  maxValueBytes: number | null;
  beforeConnect: boolean;
}

/** The `k=v,…` value of the cap, as CAP LS advertises it. */
export function parseMetadataLimits(advertised: string | undefined | null): MetadataLimits {
  const out: MetadataLimits = {
    maxSubs: null,
    maxKeys: null,
    maxValueBytes: null,
    beforeConnect: false,
  };
  for (const part of (advertised ?? '').split(',')) {
    const [key, val] = part.split('=');
    if (key === 'before-connect') {
      out.beforeConnect = true;
      continue;
    }
    const n = Number(val);
    if (!Number.isFinite(n) || n < 0) continue;
    if (key === 'max-subs') out.maxSubs = n;
    else if (key === 'max-keys') out.maxKeys = n;
    else if (key === 'max-value-bytes') out.maxValueBytes = n;
  }
  return out;
}

export function isValidMetadataKey(key: string): boolean {
  return METADATA_KEY_RE.test(key);
}

/** The keys to SUB, trimmed to what the server allows. 0 means none. */
export function metadataSubKeysFor(limits: MetadataLimits): string[] {
  if (limits.maxSubs === null) return [...METADATA_SUB_KEYS];
  return METADATA_SUB_KEYS.slice(0, Math.max(0, Math.floor(limits.maxSubs)));
}

export interface MetadataChange {
  target: string;
  key: string;
  // null = the key was unset.
  value: string | null;
}

/**
 * One metadata line from the server as a change, or null for a line that
 * isn't one. Handles the draft-2 `METADATA` message, 761 (set, or a list
 * entry), 766 (unset) and 760 (a WHOIS line, which is current too).
 */
export function parseMetadataLine(command: string, params: string[]): MetadataChange | null {
  const cmd = command.toUpperCase();
  if (cmd === 'METADATA') {
    // METADATA <target> <key> <visibility> [<value>]; three params = unset.
    const [target, key] = params;
    if (!target || !key) return null;
    return { target, key, value: params.length >= 4 ? (params[3] ?? '') : null };
  }
  if (cmd === '761' || cmd === '760') {
    // <asker> <target> <key> <visibility> [<value>]
    const [, target, key] = params;
    if (!target || !key) return null;
    return { target, key, value: params[4] ?? '' };
  }
  if (cmd === '766') {
    // <asker> <target> <key> [:key not set]
    const [, target, key] = params;
    if (!target || !key) return null;
    return { target, key, value: null };
  }
  return null;
}

// What a user record holds, keyed by the metadata key.
export type MetadataRecord = Record<string, string>;

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * A value fit to keep, or null when the key is better treated as unset: too
 * long, control characters, or a URL key whose value isn't an http(s) URL.
 * Only the keys Lurker subscribes to are kept — plus any `extra` keys a
 * bouncer client asked for — so a server can't grow the record without bound.
 */
export function vetMetadataValue(
  key: string,
  raw: string | null,
  extra?: { has(key: string): boolean },
): string | null {
  if (raw === null) return null;
  const max =
    (Object.hasOwn(METADATA_VALUE_MAX_CHARS, key) ? METADATA_VALUE_MAX_CHARS[key] : undefined) ??
    (extra?.has(key) ? METADATA_EXTRA_VALUE_MAX_CHARS : undefined);
  if (max === undefined) return null;
  // Line breaks and NUL can't legally be here; other controls (mIRC formatting)
  // are the display layer's to render or strip.
  const value = raw.replace(/[\r\n\0]/g, '').trim();
  if (!value || value.length > max) return null;
  // A name that is only formatting codes or invisible characters would print
  // nothing in place of the nick.
  if (key === 'display-name' && !stripFormatting(value).replace(INVISIBLE_RE, '').trim()) {
    return null;
  }
  if (key === 'avatar' || key === 'homepage') {
    const sized = key === 'avatar' ? sizedAvatarUrl(value) : value;
    if (!isHttpUrl(sized)) return null;
    return key === 'avatar' ? sized : value;
  }
  return value;
}

/** The registry's `{size}` placeholder, filled in. */
export function sizedAvatarUrl(url: string, size = AVATAR_SIZE): string {
  return url.replace(/\{size\}/g, String(size));
}

const ANY_KEY = { has: () => true };

/**
 * What to save for one of our own keys (#1189): the value as typed (an avatar
 * keeps its `{size}`), null for an unset, or undefined for a value Lurker
 * wouldn't show — that one isn't saved, so it isn't re-set on every connect.
 */
export function ownMetadataToSave(key: string, raw: string | null): string | null | undefined {
  if (!METADATA_KEY_RE.test(key)) return undefined;
  const value = (raw ?? '').replace(/[\r\n\0]/g, '').trim();
  if (!value) return null;
  return vetMetadataValue(key, value, ANY_KEY) === null ? undefined : value;
}

/**
 * A `METADATA <target> SET <key> [<value>]` or `METADATA <target> CLEAR` line
 * on its way out, when the target is us: `*`, or our nick (halloy's form). A
 * SET with no value, or an empty one, is an unset, as ergo reads it.
 */
export function parseOwnMetadataWrite(
  line: string,
  isSelf: (target: string) => boolean,
): OwnMetadataWrite | null {
  const msg = parseLine(line);
  if (!msg || msg.command !== 'METADATA') return null;
  const [target, sub, key] = msg.params;
  if (!target || (target !== '*' && !isSelf(target))) return null;
  switch ((sub ?? '').toUpperCase()) {
    case 'CLEAR':
      return 'clear';
    case 'SET': {
      if (!key) return null;
      const value = msg.params[3];
      return { key: key.toLowerCase(), value: value ? value : null };
    }
    default:
      return null;
  }
}

// What a client is sent for a user. `avatarUrl` is minted by `mint`
// (avatarProxy.ts) and opaque to every client: the byte-cache CDN URL when the
// image is cached, else the authenticated proxy, else null when previews are
// off (then the client shows its generated tile). Clients never see the origin
// URL — an avatar set by another user is an involuntary fetch, the same rule
// as a preview thumbnail.
export interface UserMetadataView {
  displayName?: string;
  avatarUrl?: string | null;
  pronouns?: string;
  homepage?: string;
  status?: string;
}

export interface ChannelMetadataView {
  displayName?: string;
  avatarUrl?: string | null;
}

export type AvatarMint = (origin: string) => string | null;

export function userMetadataView(record: MetadataRecord, mint: AvatarMint): UserMetadataView {
  const view: UserMetadataView = {};
  if (record['display-name']) view.displayName = record['display-name'];
  if (record.avatar) view.avatarUrl = mint(record.avatar);
  if (record.pronouns) view.pronouns = record.pronouns;
  if (record.homepage) view.homepage = record.homepage;
  if (record.status) view.status = record.status;
  return view;
}

export function channelMetadataView(record: MetadataRecord, mint: AvatarMint): ChannelMetadataView {
  const view: ChannelMetadataView = {};
  if (record['display-name']) view.displayName = record['display-name'];
  if (record.avatar) view.avatarUrl = mint(record.avatar);
  return view;
}

/** Whether a metadata target is a channel (else a nick, or `*` for ourselves). */
export function isChannelMetadataTarget(target: string): boolean {
  return isChannelTarget(target);
}

// Numerics 760–775 are reserved for metadata. None belongs in the server
// buffer: the ones Lurker reads land in state, the rest are acknowledgements.
export const METADATA_NUMERICS = new Set([
  '760',
  '761',
  '762',
  '763',
  '764',
  '765',
  '766',
  '767',
  '768',
  '769',
  '770',
  '771',
  '772',
  '773',
  '774',
  '775',
]);
