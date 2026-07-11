// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Fserve enablement + access policy. An fserve (DCC-CHAT file server for a
// user's archive) rides the DCC subsystem, so it's gated on top of it:
//   1. LURKER_FSERVE_ENABLED — the instance master switch (opt-in, off by
//      default — an fserve exposes files to arbitrary IRC users).
//   2. LURKER_FSERVE_DIR — the archive root served (canonical + must exist).
//   3. DCC enabled for the user (master + per-user capability) — the transport.
//   4. the user's own `fserve.enabled` setting.
// ALL four must hold. Per-user policy (trigger word, access mode, password,
// allowlist, ads) lives in the settings registry. The mask matcher + access
// decision are pure and unit-tested.

import fs from 'fs';
import path from 'path';

import { dccEnabledForUser } from './dccConfig.js';
import { effectiveSetting } from './settingsService.js';

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

export function fserveMasterEnabled(): boolean {
  return TRUTHY.has((process.env.LURKER_FSERVE_ENABLED ?? '').trim().toLowerCase());
}

/** The archive root, canonicalized, or null when unset / nonexistent. This is
 *  the sandbox ceiling handed to the command interpreter. */
export function fserveRoot(): string | null {
  const d = (process.env.LURKER_FSERVE_DIR ?? '').trim();
  if (!d) return null;
  try {
    return fs.realpathSync(path.resolve(d));
  } catch {
    return null;
  }
}

/** Whether `userId` may run an fserve: master switch AND DCC enabled AND a
 *  usable root AND the user's own toggle. */
export function fserveEnabledForUser(userId: number): boolean {
  return (
    fserveMasterEnabled() &&
    dccEnabledForUser(userId) &&
    fserveRoot() !== null &&
    effectiveSetting(userId, 'fserve.enabled') === true
  );
}

function settingStr(userId: number, key: string): string {
  const v = effectiveSetting(userId, key);
  return typeof v === 'string' ? v.trim() : '';
}

/** The trigger token (a CTCP FSERVE keyword or a /msg word) that opens the
 *  fserve. Empty disables triggering (leaving only CTCP FSERVE, handled by the
 *  caller). Compared case-insensitively. */
export function fserveTrigger(userId: number): string {
  return settingStr(userId, 'fserve.trigger');
}

export function fserveWelcome(userId: number): string {
  return settingStr(userId, 'fserve.welcome');
}

export function fserveMaxSessions(userId: number): number {
  const v = effectiveSetting(userId, 'fserve.max_sessions');
  return typeof v === 'number' && v > 0 ? Math.floor(v) : 3;
}

export type FserveAccessMode = 'open' | 'allowlist' | 'password';

export function fserveAccessMode(userId: number): FserveAccessMode {
  const v = settingStr(userId, 'fserve.access');
  return v === 'allowlist' || v === 'password' ? v : 'open';
}

export function fservePassword(userId: number): string {
  return settingStr(userId, 'fserve.password');
}

export function fserveAllowlist(userId: number): string[] {
  const v = effectiveSetting(userId, 'fserve.allowlist');
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x).trim()).filter(Boolean);
}

// --- ads ---------------------------------------------------------------------

export function fserveAdChannel(userId: number): string {
  return settingStr(userId, 'fserve.ad_channel');
}
export function fserveAdMessage(userId: number): string {
  return settingStr(userId, 'fserve.ad_message');
}
export function fserveAdIntervalMs(userId: number): number {
  const v = effectiveSetting(userId, 'fserve.ad_interval');
  // Minutes → ms; 0 (or unset) disables. Floor at 1 minute to protect channels.
  const mins = typeof v === 'number' ? Math.floor(v) : 0;
  return mins > 0 ? Math.max(1, mins) * 60_000 : 0;
}

// --- access decision (pure) --------------------------------------------------

/** Convert an IRC hostmask glob (`*`/`?` wildcards over nick!user@host) to a
 *  case-insensitive anchored RegExp. Everything else is escaped literally. */
export function maskToRegExp(mask: string): RegExp {
  const escaped = mask
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

/** Whether `hostmask` (nick!user@host) matches any allowlist entry. A bare nick
 *  entry (no `!`) also matches the nick alone, so "friend" allows friend!*@*. */
export function allowlistMatches(allowlist: string[], hostmask: string, nick: string): boolean {
  for (const entry of allowlist) {
    const pat = entry.includes('!') || entry.includes('@') ? entry : `${entry}!*@*`;
    if (maskToRegExp(pat).test(hostmask)) return true;
    // Also allow a bare-nick entry to match the nick directly.
    if (!entry.includes('!') && !entry.includes('@') && maskToRegExp(entry).test(nick)) return true;
  }
  return false;
}

export type FserveAccessDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'password' }; // open the session but require the password in-band

/**
 * Decide whether a trigger from `nick` (`hostmask` = nick!user@host) may open an
 * fserve session, given the user's policy. Password mode returns `password` so
 * the session prompts for it; the actual password check happens in-session.
 */
export function decideFserveAccess(
  mode: FserveAccessMode,
  allowlist: string[],
  hostmask: string,
  nick: string,
): FserveAccessDecision {
  if (mode === 'password') return { kind: 'password' };
  if (mode === 'allowlist') {
    return allowlistMatches(allowlist, hostmask, nick)
      ? { kind: 'allow' }
      : { kind: 'deny', reason: 'not on the access list' };
  }
  return { kind: 'allow' };
}
