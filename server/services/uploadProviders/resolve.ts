// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Resolve which configured uploader an upload should use. Replaces the old
// `isNodeMode() ? forced-provider : user-setting` selection + secretsForProvider
// switch in routes/uploads.ts with a single policy lookup:
//
//   allowed(user) = { user rows owned by user, enabled }
//                 ∪ { instance rows enabled AND offered_to_users }
//                 ∪ (isAdmin ? all instance rows : ∅)
//   effective     = requested (must be allowed) ?? user default (if allowed)
//                                               ?? instance is_default
//
// The returned object carries the decrypted+merged driver config plus the policy
// metadata (thumbnail strategy, SVG rule, size/pipeline caps) that the hosted
// locked default bakes into its config_json. Every isNodeMode() branch the route
// used to make is now one of these fields.

import { getUserSettings } from '../../db/settings.js';
import {
  getUploaderConfig,
  getInstanceDefault,
  resolvedConfig,
  type UploaderConfigRow,
} from '../../db/uploaderConfig.js';
import { getDriver, type UploadDriver, type DriverCapabilities } from './index.js';

// Policy metadata lives in config_json under `policy.<key>` string values so the
// driver config (the schema fields) stays clean. Seeded onto the hosted locked
// uploader (db/uploaderConfigSeed.ts); absent on ordinary self-host rows.
const POLICY_PREFIX = 'policy.';

export interface UploaderPolicy {
  // true → upload a separate thumb object and store thumbnail_url; false → keep
  // the inline BLOB thumbnail (the historical self-host behavior).
  hostsThumbnails: boolean;
  // true → reject SVG (hosted); false → pass SVG through (self-host).
  rasterOnly: boolean;
  // Operator-baked pipeline caps; undefined → fall back to the user's settings.
  maxMb?: number;
  maxDim?: number;
  quality?: number;
}

export interface ResolvedUploader {
  configId: number;
  driverId: string;
  driver: UploadDriver;
  label: string;
  capabilities: DriverCapabilities;
  scope: 'instance' | 'user';
  locked: boolean;
  // Driver fields only (schema keys + decrypted secrets); policy stripped.
  driverConfig: Record<string, string>;
  policy: UploaderPolicy;
}

export class UploaderUnavailableError extends Error {
  code = 'UPLOADER_UNAVAILABLE';
  constructor(message = 'no usable uploader is configured for this account') {
    super(message);
  }
}

export class UploaderNotConfiguredError extends Error {
  code = 'UPLOADER_NOT_CONFIGURED';
  constructor(message = 'uploads are not configured on this server') {
    super(message);
  }
}

export interface ResolveInput {
  userId: number;
  isAdmin?: boolean;
  // Per-upload override (client-supplied). Absent in P0 — the client doesn't send
  // it yet — so resolution runs the user-default → instance-default path.
  requestedId?: number | null;
}

function isAllowed(row: UploaderConfigRow, userId: number, isAdmin: boolean): boolean {
  if (!row.enabled) return false;
  if (row.scope === 'user') return row.owner_user_id === userId;
  return row.offered_to_users === 1 || isAdmin;
}

function splitPolicy(merged: Record<string, string>): {
  driverConfig: Record<string, string>;
  policy: UploaderPolicy;
} {
  const driverConfig: Record<string, string> = {};
  const raw: Record<string, string> = {};
  for (const [k, v] of Object.entries(merged)) {
    if (k.startsWith(POLICY_PREFIX)) raw[k.slice(POLICY_PREFIX.length)] = String(v);
    else driverConfig[k] = String(v);
  }
  const num = (s: string | undefined): number | undefined => {
    if (s == null || s === '') return undefined;
    const n = Number(s);
    return Number.isFinite(n) ? n : undefined;
  };
  return {
    driverConfig,
    policy: {
      hostsThumbnails: raw.hostsThumbnails === '1' || raw.hostsThumbnails === 'true',
      rasterOnly: raw.rasterOnly === '1' || raw.rasterOnly === 'true',
      maxMb: num(raw.maxMb),
      maxDim: num(raw.maxDim),
      quality: num(raw.quality),
    },
  };
}

/** True when a locked instance uploader is missing a required driver field —
 *  the hosted "operator hasn't configured uploads yet" case (→ 503). */
function lockedButUnconfigured(
  row: UploaderConfigRow,
  driver: UploadDriver,
  driverConfig: Record<string, string>,
): boolean {
  if (row.locked !== 1) return false;
  return driver.configSchema.some((f) => f.required && !driverConfig[f.key]);
}

export function resolveUploader(input: ResolveInput): ResolvedUploader {
  const { userId, isAdmin = false, requestedId = null } = input;

  let chosen: UploaderConfigRow | null = null;

  if (requestedId != null) {
    const r = getUploaderConfig(requestedId);
    // An explicit choice that isn't usable is an error — never silently reroute
    // the file to a different backend (design decision 15).
    if (!r || !isAllowed(r, userId, isAdmin)) throw new UploaderUnavailableError();
    chosen = r;
  } else {
    const settings = getUserSettings(userId);
    const savedId = settings['uploads.uploader_id'];
    if (typeof savedId === 'number') {
      const r = getUploaderConfig(savedId);
      if (r && isAllowed(r, userId, isAdmin)) chosen = r;
    }
    if (!chosen) chosen = getInstanceDefault();
  }

  if (!chosen) throw new UploaderUnavailableError();

  const driver = getDriver(chosen.driver);
  if (!driver) throw new UploaderUnavailableError(`unknown upload driver: ${chosen.driver}`);

  const { driverConfig, policy } = splitPolicy(resolvedConfig(chosen));
  if (lockedButUnconfigured(chosen, driver, driverConfig)) throw new UploaderNotConfiguredError();

  return {
    configId: chosen.id,
    driverId: chosen.driver,
    driver,
    label: chosen.label,
    capabilities: driver.capabilities,
    scope: chosen.scope,
    locked: chosen.locked === 1,
    driverConfig,
    policy,
  };
}
