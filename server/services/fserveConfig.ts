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
import { maskToRegExp, allowlistMatches } from './hostmaskMatch.js';
import type { FserveFilter } from './fserveCommands.js';

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

// --- visibility filter -------------------------------------------------------

export function fserveHideDotfiles(userId: number): boolean {
  // Default true; only an explicit stored `false` turns it off.
  return effectiveSetting(userId, 'fserve.hide_dotfiles') !== false;
}

/** Parse the allowed-extensions setting into lowercased bare extensions (no
 *  dot). Empty list = all files allowed. */
export function fserveAllowedExtensions(userId: number): string[] {
  const raw = settingStr(userId, 'fserve.allowed_extensions');
  if (!raw) return [];
  return raw
    .split(/[\s,]+/)
    .map((e) => e.trim().replace(/^\.+/, '').toLowerCase())
    .filter(Boolean);
}

/** Build the interpreter's visibility filter from the user's settings. */
export function buildFserveFilter(userId: number): FserveFilter {
  return {
    hideDotfiles: fserveHideDotfiles(userId),
    allowedExts: fserveAllowedExtensions(userId),
  };
}

export function fserveMaxSessions(userId: number): number {
  const v = effectiveSetting(userId, 'fserve.max_sessions');
  return typeof v === 'number' && v > 0 ? Math.floor(v) : 3;
}

/** Concurrent DCC sends the queue runs at once (the "Sends:[x/N]" cap). */
export function fserveMaxSends(userId: number): number {
  const v = effectiveSetting(userId, 'fserve.max_sends');
  return typeof v === 'number' && v > 0 ? Math.floor(v) : 1;
}

/** Waiting slots beyond the active sends (the "Queues:[y/M]" cap). */
export function fserveMaxQueue(userId: number): number {
  const v = effectiveSetting(userId, 'fserve.max_queue');
  return typeof v === 'number' && v >= 0 ? Math.floor(v) : 10;
}

/** Idle disconnect in ms; 0 disables. Stored in seconds. A short grace warning
 *  is sent before the cut (see FserveSession). */
export function fserveIdleTimeoutMs(userId: number): number {
  const v = effectiveSetting(userId, 'fserve.idle_timeout');
  const secs = typeof v === 'number' ? Math.floor(v) : 300;
  return secs > 0 ? secs * 1000 : 0;
}

/** Display name shown in banners/ads; falls back to the caller's own nick when
 *  blank (handled by the caller). */
export function fserveServerName(userId: number): string {
  return settingStr(userId, 'fserve.server_name');
}

// --- @find channel search ----------------------------------------------------

/** Whether the fserve answers `@find <query>` triggers in channels/DMs. Opt-in
 *  (default false): it responds to arbitrary users and walks the archive. */
export function fserveFindEnabled(userId: number): boolean {
  return fserveEnabledForUser(userId) && effectiveSetting(userId, 'fserve.find_enabled') === true;
}

/** The search trigger word (default "@find"). Compared case-insensitively on the
 *  first token of an incoming message. */
export function fserveFindTrigger(userId: number): string {
  const t = settingStr(userId, 'fserve.find_trigger');
  return t || '@find';
}

/** Max file matches returned by one @find. */
export function fserveFindMaxResults(userId: number): number {
  const v = effectiveSetting(userId, 'fserve.find_max_results');
  return typeof v === 'number' && v > 0 ? Math.floor(v) : 15;
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

// Hostmask glob matching lives in the shared hostmaskMatch module (reused by DCC
// auto-accept); imported above and re-exported so existing fserve callers/tests
// keep working.
export { maskToRegExp, allowlistMatches };

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
