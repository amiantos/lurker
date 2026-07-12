// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The admin half of uploader management (#514, absorbing #299): instance-scoped
// uploaders — the ones the operator stands up for everybody — plus the two policy
// levers that decide what users get.
//
//   • is_default        the uploader a new account silently inherits (#299's whole
//                       point: uploads work from first use, no onboarding step).
//   • offered_to_users  whether an instance uploader shows up in a user's picker
//                       at all, or is admin-only.
//   • allow_user_defined  the lockdown switch: may users stand up their OWN
//                       uploaders? Flipping it off blocks NEW personal uploaders
//                       and hides the add button; it deliberately does NOT disable
//                       the ones people already have (§10 open decision, resolved
//                       here as "don't strand a self-hoster who flips the switch").
//
// Mounted under the admin router, so requireAuth + requireAdmin already apply.
//
// Node edition refuses the lot: a hosted cell's uploader is the locked row that
// reconcileHostedUploaderFromEnv re-derives from the operator env on every boot,
// so anything written here would be silently reverted on the next deploy. Same
// reasoning (and same 409) as the pause routes in admin.ts.

import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  getUploaderConfig,
  listInstanceUploaders,
  createUploaderConfig,
  updateUploaderConfig,
  deleteUploaderConfig,
  setInstanceDefault,
  toDetail,
} from '../db/uploaderConfig.js';
import { allowUserDefinedUploaders, setAllowUserDefinedUploaders } from '../db/instanceSettings.js';
import { BUILT_IN_INSTANCE_DRIVERS } from '../db/uploaderConfigSeed.js';
import { getDriver, driverIds } from '../services/uploadProviders/index.js';
import { isNodeMode } from '../utils/edition.js';

const router = Router();

const MAX_LABEL_LEN = 64;
const MAX_VALUE_LEN = 2048;

/** Every instance uploader route is refused on a hosted cell — see header. */
function refuseOnNode(res: Response): boolean {
  if (!isNodeMode()) return false;
  res.status(409).json({ error: 'the uploader is managed by the control plane in node edition' });
  return true;
}

function creatableDrivers() {
  return driverIds
    .map((id) => getDriver(id)!)
    .filter((d) => d.capabilities.creatable)
    .map((d) => ({ driver: d.driver, label: d.label, configSchema: d.configSchema }));
}

function validateValues(
  driverId: string,
  values: Record<string, unknown>,
  { partial }: { partial: boolean },
): string | null {
  const driver = getDriver(driverId);
  if (!driver) return `unknown upload driver: ${driverId}`;
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

function bool(body: unknown, key: string): boolean | undefined {
  const v = (body as Record<string, unknown> | null)?.[key];
  return typeof v === 'boolean' ? v : undefined;
}

/** Built-ins are re-created by reconcileBuiltInUploaders on the next boot anyway,
 *  so deleting one is theatre — and deleting `local` would strand the bytes
 *  already on disk with nothing left that knows how to reap them. Disable-only.
 *  Deliberately NOT keyed off the driver's `creatable` capability: catbox is both
 *  a seeded built-in and a driver users may instantiate with their own userhash. */
function isBuiltIn(driverId: string): boolean {
  return BUILT_IN_INSTANCE_DRIVERS.includes(driverId);
}

router.get('/', (_req: Request, res: Response) => {
  res.json({
    uploaders: listInstanceUploaders().map((row) => {
      const detail = { ...toDetail(row), builtIn: isBuiltIn(row.driver) };
      // A LOCKED row is the hosted operator's, configured from their environment
      // and re-derived on every boot. Its endpoint isn't a cell tenant's business
      // even when that tenant happens to hold the admin role on their cell — and
      // nothing can edit it anyway (PATCH 409s). Name and flags only.
      if (row.locked === 1) return { ...detail, config: {}, secretsSet: {} };
      return detail;
    }),
    allowUserDefined: allowUserDefinedUploaders(),
    drivers: creatableDrivers(),
    // The client hides the whole management surface on a hosted cell rather than
    // offering buttons that will 409.
    managed: isNodeMode(),
  });
});

router.post('/', (req: Request, res: Response) => {
  if (refuseOnNode(res)) return;
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
  const values = readValues(req.body);
  if (!values) {
    res.status(400).json({ error: 'values must be an object' });
    return;
  }
  const invalid = validateValues(driverId, values, { partial: false });
  if (invalid) {
    res.status(400).json({ error: invalid });
    return;
  }
  const id = createUploaderConfig({
    scope: 'instance',
    driver: driverId,
    label: readLabel(req.body),
    values,
    offeredToUsers: bool(req.body, 'offeredToUsers') ?? true,
  });
  res.status(201).json(toDetail(getUploaderConfig(id)!));
});

router.patch('/:id', (req: Request, res: Response) => {
  if (refuseOnNode(res)) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: 'invalid id' });
    return;
  }
  const row = getUploaderConfig(id);
  if (!row || row.scope !== 'instance') {
    res.status(404).json({ error: 'not found' });
    return;
  }
  if (row.locked === 1) {
    res
      .status(409)
      .json({ error: 'this uploader is managed by the operator and cannot be edited' });
    return;
  }
  const values = readValues(req.body);
  if (!values) {
    res.status(400).json({ error: 'values must be an object' });
    return;
  }
  const invalid = validateValues(row.driver, values, { partial: true });
  if (invalid) {
    res.status(400).json({ error: invalid });
    return;
  }
  // Disabling the default would leave every account that hasn't picked an
  // uploader with nothing to resolve to — uploads would start failing across the
  // instance. Same reasoning (and same 409) as refusing to delete it: reassign the
  // default first.
  if (row.is_default === 1 && bool(req.body, 'enabled') === false) {
    res.status(409).json({ error: 'choose another default before disabling this uploader' });
    return;
  }
  updateUploaderConfig(id, {
    label: readLabel(req.body),
    values,
    enabled: bool(req.body, 'enabled'),
    offeredToUsers: bool(req.body, 'offeredToUsers'),
  });
  res.json(toDetail(getUploaderConfig(id)!));
});

/** Make this the instance default — what a brand-new account uploads through
 *  without ever visiting settings (#299). */
router.put('/:id/default', (req: Request, res: Response) => {
  if (refuseOnNode(res)) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: 'invalid id' });
    return;
  }
  const row = getUploaderConfig(id);
  if (!row || row.scope !== 'instance') {
    res.status(404).json({ error: 'not found' });
    return;
  }
  // A disabled default resolves to nothing, which would break uploads for every
  // account that hasn't picked an uploader — the exact silent breakage this
  // whole milestone exists to remove.
  if (row.enabled !== 1) {
    res.status(409).json({ error: 'enable this uploader before making it the default' });
    return;
  }
  setInstanceDefault(id);
  res.json({ ok: true });
});

router.delete('/:id', (req: Request, res: Response) => {
  if (refuseOnNode(res)) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: 'invalid id' });
    return;
  }
  const row = getUploaderConfig(id);
  if (!row || row.scope !== 'instance') {
    res.status(404).json({ error: 'not found' });
    return;
  }
  if (isBuiltIn(row.driver)) {
    res.status(409).json({ error: 'built-in uploaders can be disabled, but not deleted' });
    return;
  }
  if (row.is_default === 1) {
    res.status(409).json({ error: 'choose another default before deleting this uploader' });
    return;
  }
  deleteUploaderConfig(id);
  res.json({ ok: true });
});

/** The lockdown switch (design decision 2). */
router.put('/policy', (req: Request, res: Response) => {
  if (refuseOnNode(res)) return;
  const allow = bool(req.body, 'allowUserDefined');
  if (allow === undefined) {
    res.status(400).json({ error: 'allowUserDefined must be a boolean' });
    return;
  }
  setAllowUserDefinedUploaders(allow);
  res.json({ ok: true, allowUserDefined: allow });
});

export default router;
