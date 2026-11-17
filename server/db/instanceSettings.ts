// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Instance-level key/value settings (issue #510). A tiny surface — one key today
// (uploads.allow_user_defined) — distinct from per-user settings: these belong to
// the whole instance, set by the admin/operator, not scoped to any account.

import db from './index.js';
import { isNodeMode } from '../utils/edition.js';
import { DEFAULT_UPLOAD_CEILING_MB } from '../../shared/settingsRegistry.js';
import { normalizeJitsiBase } from '../../shared/jitsi.js';

export function getInstanceSetting(key: string): string | null {
  const row = db.prepare('SELECT value FROM instance_settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row ? row.value : null;
}

export function setInstanceSetting(key: string, value: string): void {
  db.prepare(
    `INSERT INTO instance_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

// Keep this literal in sync with the one the seed migration writes
// (db/uploaderConfigSeed.ts) — the seed can't import this module (import cycle),
// so the string lives in both places by necessity.
export const ALLOW_USER_DEFINED_KEY = 'uploads.allow_user_defined';

/**
 * May users define their own uploaders? Default when unset: yes on self-host
 * (trusted), no on the hosted fleet (tenants get the operator's locked default).
 */
export function allowUserDefinedUploaders(): boolean {
  const v = getInstanceSetting(ALLOW_USER_DEFINED_KEY);
  if (v === null) return !isNodeMode();
  return v === '1';
}

export function setAllowUserDefinedUploaders(allow: boolean): void {
  setInstanceSetting(ALLOW_USER_DEFINED_KEY, allow ? '1' : '0');
}

export const ALLOW_USER_DEFINED_NETWORKS_KEY = 'networks.allow_user_defined';

/**
 * May users connect to networks the admin hasn't listed? (#298)
 *
 * Default when unset: yes, on BOTH editions — unlike the uploader switch, which
 * defaults off when hosted. A hosted customer is the admin of their own cell and
 * connecting to whatever network they like is the entire product; defaulting them
 * into a closed instance would lock them out of it. This is a self-hoster's
 * opt-in for a private/corporate instance, not a fleet policy.
 */
export function allowUserDefinedNetworks(): boolean {
  const v = getInstanceSetting(ALLOW_USER_DEFINED_NETWORKS_KEY);
  if (v === null) return true;
  return v === '1';
}

export function setAllowUserDefinedNetworks(allow: boolean): void {
  setInstanceSetting(ALLOW_USER_DEFINED_NETWORKS_KEY, allow ? '1' : '0');
}

export const PUSH_RELAY_ENABLED_KEY = 'push.relay_enabled';

/**
 * Has the admin opted in to push.lurker.chat for the official apps?
 * (lurker-dev/RELAY_PLAN.md §5a.) Off when unset, on both editions: until an
 * admin turns it on, the apps must never contact the relay at all.
 */
export function pushRelayEnabled(): boolean {
  return getInstanceSetting(PUSH_RELAY_ENABLED_KEY) === '1';
}

export function setPushRelayEnabled(enabled: boolean): void {
  setInstanceSetting(PUSH_RELAY_ENABLED_KEY, enabled ? '1' : '0');
}

export const UPLOAD_CEILING_MB_KEY = 'uploads.max_upload_mb';

/**
 * The admin-set upload ceiling in MiB, or null when the admin never set one
 * (#1131). Self-host only: on a hosted cell the ceiling is the operator's
 * LURKER_NODE_UPLOAD_MAX_MB, read in services/uploadLimits.ts, and a tenant's
 * write here would be ignored. A stored value that won't parse reads as unset.
 */
export function storedUploadCeilingMb(): number | null {
  const v = getInstanceSetting(UPLOAD_CEILING_MB_KEY);
  if (v === null) return null;
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** The ceiling as the self-host upload path resolves it: stored, else the
 *  install default. */
export function uploadCeilingMbStandalone(): number {
  return storedUploadCeilingMb() ?? DEFAULT_UPLOAD_CEILING_MB;
}

export function setUploadCeilingMb(mb: number): void {
  setInstanceSetting(UPLOAD_CEILING_MB_KEY, String(mb));
}

export const JITSI_URL_KEY = 'jitsi.url';

/**
 * The Jitsi Meet server the admin named for /jitsi (#527), or null: clients
 * then use the public one. A user's own chat.jitsi_url setting goes ahead of
 * this. A stored value that isn't a usable base reads as unset.
 */
export function instanceJitsiUrl(): string | null {
  return normalizeJitsiBase(getInstanceSetting(JITSI_URL_KEY));
}

/** Null clears it. The caller has normalized the value. */
export function setInstanceJitsiUrl(url: string | null): void {
  setInstanceSetting(JITSI_URL_KEY, url ?? '');
}
