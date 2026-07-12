// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The user-facing half of uploader management (#514): list the uploaders you may
// send a file to, stand up your own (a catbox account, your Zipline, your S3
// bucket), and choose which one is yours by default. The admin half — instance
// uploaders and the policy switches — lives in routes/admin.ts.
//
// This router replaces the old `uploads.provider` enum + flat `uploads.*.api_key`
// settings keys. Two things that were implicit there are explicit here:
//
//   1. SECRETS ARE WRITE-ONLY. A response never carries a secret value, only
//      `secretsSet[field] = true/false`. An edit that omits a secret keeps the
//      stored one (see db/uploaderConfig.ts#updateUploaderConfig), so changing a
//      bucket name doesn't require re-typing the key you can't read back.
//   2. THE FORM IS THE DRIVER'S. `drivers[].configSchema` is served straight from
//      each driver module, so a new driver is a form with no client change.

import express, { type Request, type Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { getUserSettings, setUserSetting, deleteUserSetting } from '../db/settings.js';
import {
  getUploaderConfig,
  createUploaderConfig,
  updateUploaderConfig,
  deleteUploaderConfig,
  toDetail,
  toSummary,
  type UploaderConfigRow,
} from '../db/uploaderConfig.js';
import { allowUserDefinedUploaders } from '../db/instanceSettings.js';
import { listAllowedUploaders } from '../services/uploadProviders/resolve.js';
import { getDriver, driverIds, type UploadDriver } from '../services/uploadProviders/index.js';
import { isNodeMode } from '../utils/edition.js';

const router = express.Router();
router.use(requireAuth);

/** The user's chosen uploader id (settings key, not a registry setting — it's a
 *  row id, not a preference). Undefined → "use the instance default". */
const SELECTION_KEY = 'uploads.uploader_id';

const MAX_LABEL_LEN = 64;
const MAX_VALUE_LEN = 2048;

interface DriverDescriptor {
  driver: string;
  label: string;
  configSchema: UploadDriver['configSchema'];
  // Whether a human may stand up a NEW one. The client filters the "add an
  // uploader" menu by this.
  creatable: boolean;
}

/**
 * Every driver the client might need to describe — NOT just the creatable ones.
 *
 * These are two different questions and conflating them was a bug: "what may I
 * add?" is `creatable`, but "what schema describes this row I already own?" is
 * any driver at all. A self-hoster migrated off the legacy Hoarder settings owns a
 * `hoarder` row — editable, and NOT creatable — so a creatable-only list left the
 * client with no schema to render their edit form from. They are precisely the
 * people this release exists to rescue, so they are precisely the people who must
 * not hit a wall on this pane.
 *
 * Config VALUES still only ever ship for rows the caller owns (projectForUser);
 * a schema is just field metadata — labels and types, never a secret.
 */
function visibleDrivers(): DriverDescriptor[] {
  const out: DriverDescriptor[] = [];
  for (const id of driverIds) {
    const d = getDriver(id);
    if (!d) continue;
    if (d.capabilities.selfHostOnly && isNodeMode()) continue;
    out.push({
      driver: d.driver,
      label: d.label,
      configSchema: d.configSchema,
      creatable: Boolean(d.capabilities.creatable),
    });
  }
  return out;
}

/** A row is editable by its owner, and only its owner: an instance row is the
 *  admin surface's business even when the caller happens to be an admin, so the
 *  two APIs never disagree about who owns a write. */
function isOwnedBy(row: UploaderConfigRow, userId: number): boolean {
  return row.scope === 'user' && row.owner_user_id === userId;
}

function projectForUser(row: UploaderConfigRow, userId: number) {
  const base = {
    ...toSummary(row),
    scope: row.scope,
    enabled: row.enabled === 1,
    editable: isOwnedBy(row, userId),
  };
  // Config values (non-secret) only for rows the caller owns. An instance row's
  // endpoint/bucket is the operator's business, not the tenant's — they get a
  // name to pick, nothing more.
  if (!isOwnedBy(row, userId)) return base;
  const detail = toDetail(row);
  return { ...base, config: detail.config, secretsSet: detail.secretsSet };
}

/** Validate a flat values object against a driver's schema. Returns an error
 *  string, or null when it's good. `partial` (a PATCH) skips the required check:
 *  an omitted secret means "keep the stored one", which is only knowable here. */
function validateValues(
  driver: UploadDriver,
  values: Record<string, unknown>,
  { partial }: { partial: boolean },
): string | null {
  for (const [k, v] of Object.entries(values)) {
    if (!driver.configSchema.some((f) => f.key === k)) return `unknown config field: ${k}`;
    if (typeof v !== 'string') return `config field must be a string: ${k}`;
    if (v.length > MAX_VALUE_LEN) return `config field is too long: ${k}`;
  }
  if (partial) return null;
  for (const f of driver.configSchema) {
    if (f.required && !String(values[f.key] ?? '').trim()) return `${f.label} is required`;
  }
  return null;
}

function readValues(body: unknown): Record<string, string> | null {
  const raw = (body as { values?: unknown } | null)?.values;
  if (raw == null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  return raw as Record<string, string>;
}

function readLabel(body: unknown): string | undefined {
  const raw = (body as { label?: unknown } | null)?.label;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed ? trimmed.slice(0, MAX_LABEL_LEN) : undefined;
}

// ─── routes ──────────────────────────────────────────────────────────────────

/** Everything the Uploads pane needs in one shot: what you may use, what you've
 *  picked, whether you're allowed to add your own, and the driver forms. */
router.get('/', (req: Request, res: Response) => {
  const userId = req.user!.id;
  const isAdmin = req.user!.role === 'admin';
  const allowed = listAllowedUploaders(userId, isAdmin);

  const settings = getUserSettings(userId);
  const savedId = settings[SELECTION_KEY];
  const selectedId =
    typeof savedId === 'number' && allowed.some((r) => r.id === savedId) ? savedId : null;

  res.json({
    uploaders: allowed.map((r) => projectForUser(r, userId)),
    selectedId,
    allowUserDefined: allowUserDefinedUploaders(),
    drivers: visibleDrivers(),
  });
});

/** Choose your default uploader. `id: null` → fall back to the instance default. */
router.put('/selection', (req: Request, res: Response) => {
  const userId = req.user!.id;
  const id = (req.body as { id?: unknown } | null)?.id ?? null;

  if (id === null) {
    deleteUserSetting(userId, SELECTION_KEY);
    res.json({ ok: true, selectedId: null });
    return;
  }
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: 'id must be an integer or null' });
    return;
  }
  // Must be in the allowed set — the same set resolveUploader() will consult at
  // upload time, so a selection the picker accepts can never fail to resolve.
  const allowed = listAllowedUploaders(userId, req.user!.role === 'admin');
  if (!allowed.some((r) => r.id === id)) {
    res.status(400).json({ error: 'that uploader is not available to you' });
    return;
  }
  setUserSetting(userId, SELECTION_KEY, id);
  res.json({ ok: true, selectedId: id });
});

router.post('/', (req: Request, res: Response) => {
  const userId = req.user!.id;

  if (!allowUserDefinedUploaders()) {
    res.status(403).json({ error: 'this server does not allow personal uploaders' });
    return;
  }
  const driverId = (req.body as { driver?: unknown } | null)?.driver;
  if (typeof driverId !== 'string' || !driverId) {
    res.status(400).json({ error: 'driver is required' });
    return;
  }
  const driver = getDriver(driverId);
  if (!driver || !driver.capabilities.creatable) {
    res.status(400).json({ error: `unknown upload driver: ${driverId}` });
    return;
  }
  if (driver.capabilities.selfHostOnly && isNodeMode()) {
    res.status(400).json({ error: `${driver.label} is not available on this server` });
    return;
  }
  const values = readValues(req.body);
  if (!values) {
    res.status(400).json({ error: 'values must be an object' });
    return;
  }
  const invalid = validateValues(driver, values, { partial: false });
  if (invalid) {
    res.status(400).json({ error: invalid });
    return;
  }

  const id = createUploaderConfig({
    scope: 'user',
    ownerUserId: userId,
    driver: driverId,
    label: readLabel(req.body),
    values,
  });
  res.status(201).json(projectForUser(getUploaderConfig(id)!, userId));
});

router.patch('/:id', (req: Request, res: Response) => {
  const userId = req.user!.id;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: 'invalid id' });
    return;
  }
  const row = getUploaderConfig(id);
  // Ownership is the 404: a row you don't own is a row that doesn't exist, so
  // this can't be used to probe for other people's uploaders.
  if (!row || !isOwnedBy(row, userId)) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const driver = getDriver(row.driver);
  if (!driver) {
    res.status(400).json({ error: `unknown upload driver: ${row.driver}` });
    return;
  }
  const values = readValues(req.body);
  if (!values) {
    res.status(400).json({ error: 'values must be an object' });
    return;
  }
  const invalid = validateValues(driver, values, { partial: true });
  if (invalid) {
    res.status(400).json({ error: invalid });
    return;
  }
  const enabled = (req.body as { enabled?: unknown } | null)?.enabled;

  updateUploaderConfig(id, {
    label: readLabel(req.body),
    values,
    enabled: typeof enabled === 'boolean' ? enabled : undefined,
  });
  res.json(projectForUser(getUploaderConfig(id)!, userId));
});

router.delete('/:id', (req: Request, res: Response) => {
  const userId = req.user!.id;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: 'invalid id' });
    return;
  }
  const row = getUploaderConfig(id);
  if (!row || !isOwnedBy(row, userId)) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  deleteUploaderConfig(id);
  // Don't leave the user pointed at a row that's gone: resolveUploader() would
  // quietly fall back to the instance default, which is a different host than the
  // one they picked. Clearing it makes the fallback explicit in the UI instead.
  if (getUserSettings(userId)[SELECTION_KEY] === id) deleteUserSetting(userId, SELECTION_KEY);
  res.json({ ok: true });
});

export default router;
