// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Seed-once migration for the uploader data model (issue #510). Converts the
// pre-existing per-user `uploads.*` settings (self-host) or the env-forced hosted
// uploader into `uploader_config` rows so the rest of the system stops branching
// on isNodeMode(). Behavior is byte-identical post-migration.
//
// Takes `db` as a PARAMETER (never `import db from './index.js'`) because it runs
// *during* db/index.ts evaluation, before its default export is assigned — the
// same rule foldMutedIntoIgnoreRules follows. For that reason it also can't use
// db/uploaderConfig.ts (which binds the imported db + prepares statements at load)
// and does its own raw SQL + secret encoding here.

import type Database from 'better-sqlite3';
import { isNodeMode } from '../utils/edition.js';
import { encryptSecret } from '../utils/secretCrypto.js';
import { nodeUploadSecrets, nodeUploadLimits } from '../services/uploadProviders/nodeUpload.js';

// Must match instanceSettings.ALLOW_USER_DEFINED_KEY (that module can't be
// imported here — see header).
const ALLOW_USER_DEFINED_KEY = 'uploads.allow_user_defined';

// ─── low-level helpers (raw SQL against the passed db) ────────────────────────

function encodeSecrets(secrets: Record<string, string>): string | null {
  const keys = Object.keys(secrets).filter((k) => secrets[k]);
  if (keys.length === 0) return null;
  const compact: Record<string, string> = {};
  for (const k of keys) compact[k] = secrets[k];
  return encryptSecret(JSON.stringify(compact));
}

interface InsertRow {
  scope: 'instance' | 'user';
  owner_user_id: number | null;
  driver: string;
  label: string;
  config_json: string;
  secrets_enc: string | null;
  enabled: number;
  offered_to_users: number;
  locked: number;
  is_default: number;
}

function insertRow(db: Database.Database, row: InsertRow): number {
  const info = db
    .prepare(
      `INSERT INTO uploader_config
         (scope, owner_user_id, driver, label, config_json, secrets_enc,
          enabled, offered_to_users, locked, is_default)
       VALUES (@scope, @owner_user_id, @driver, @label, @config_json, @secrets_enc,
          @enabled, @offered_to_users, @locked, @is_default)`,
    )
    .run(row);
  return Number(info.lastInsertRowid);
}

function findInstanceRowByDriver(db: Database.Database, driver: string): number | null {
  const r = db
    .prepare(`SELECT id FROM uploader_config WHERE scope = 'instance' AND driver = ? LIMIT 1`)
    .get(driver) as { id: number } | undefined;
  return r ? r.id : null;
}

/** Insert an instance row for `driver` only if none exists yet; return its id. */
function ensureInstanceRow(
  db: Database.Database,
  opts: { driver: string; label: string; offered: boolean; isDefault: boolean },
): number {
  const existing = findInstanceRowByDriver(db, opts.driver);
  if (existing != null) return existing;
  return insertRow(db, {
    scope: 'instance',
    owner_user_id: null,
    driver: opts.driver,
    label: opts.label,
    config_json: '{}',
    secrets_enc: null,
    enabled: 1,
    offered_to_users: opts.offered ? 1 : 0,
    locked: 0,
    is_default: opts.isDefault ? 1 : 0,
  });
}

function setInstanceSettingIfAbsent(db: Database.Database, key: string, value: string): void {
  db.prepare(
    `INSERT INTO instance_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING`,
  ).run(key, value);
}

function hasInstanceDefault(db: Database.Database): boolean {
  return !!db
    .prepare(`SELECT 1 FROM uploader_config WHERE scope = 'instance' AND is_default = 1 LIMIT 1`)
    .get();
}

/**
 * Ensure the self-host built-in instance uploaders (x0 default, catbox, local
 * disk) and the allow_user_defined policy exist. Purely additive and idempotent:
 * ensureInstanceRow only inserts when a driver's row is absent, so an existing
 * row's default/label/config is never clobbered. x0 is claimed as the default
 * only when no instance default exists yet, so re-running this never conflicts
 * with the one-default unique index (and never overrides a self-hoster's chosen
 * default). Returns the x0/catbox ids the per-user conversion points at.
 */
function ensureSelfHostInstanceRows(db: Database.Database): { x0Id: number; catboxId: number } {
  const defaultExists = hasInstanceDefault(db);
  const x0Id = ensureInstanceRow(db, {
    driver: 'x0',
    label: 'x0.at',
    offered: true,
    isDefault: !defaultExists,
  });
  const catboxId = ensureInstanceRow(db, {
    driver: 'catbox',
    label: 'catbox.moe',
    offered: true,
    isDefault: false,
  });
  // The zero-dependency self-host option (#511): files written to our own disk
  // and served back. Offered but not the default — a self-hoster opts in.
  ensureInstanceRow(db, {
    driver: 'local',
    label: 'Local disk',
    offered: true,
    isDefault: false,
  });
  setInstanceSettingIfAbsent(db, ALLOW_USER_DEFINED_KEY, '1');
  return { x0Id, catboxId };
}

function getUserSettingsRaw(db: Database.Database, userId: number): Record<string, unknown> {
  const rows = db
    .prepare('SELECT key, value FROM user_settings WHERE user_id = ?')
    .all(userId) as Array<{ key: string; value: string }>;
  const out: Record<string, unknown> = {};
  for (const r of rows) {
    try {
      out[r.key] = JSON.parse(r.value);
    } catch {
      // skip malformed rows
    }
  }
  return out;
}

function setUserSettingRaw(
  db: Database.Database,
  userId: number,
  key: string,
  value: unknown,
): void {
  db.prepare(
    `INSERT INTO user_settings (user_id, key, value, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(userId, key, JSON.stringify(value));
}

// ─── hosted config (shared by seed + reconcile) ───────────────────────────────

// The locked hosted uploader's config, derived from the operator env. `url` is a
// non-secret driver field; `api_key` is the secret. The pipeline policy (remote
// thumbnails, SVG rejection, operator caps) rides in config_json under `policy.*`
// so the resolver can pick it up without it leaking into the driver's own fields.
function hostedConfigFromEnv(): { config_json: string; secrets_enc: string | null } {
  const { url, api_key } = nodeUploadSecrets();
  const limits = nodeUploadLimits();
  const config: Record<string, string> = {
    url,
    'policy.hostsThumbnails': '1',
    'policy.rasterOnly': '1',
    'policy.maxMb': String(limits.maxMb),
    'policy.maxDim': String(limits.maxDim),
    'policy.quality': String(limits.quality),
  };
  return {
    config_json: JSON.stringify(config),
    secrets_enc: encodeSecrets({ api_key }),
  };
}

function findHostedRow(db: Database.Database): number | null {
  const r = db
    .prepare(
      `SELECT id FROM uploader_config WHERE scope = 'instance' AND locked = 1 AND driver = 'hoarder' LIMIT 1`,
    )
    .get() as { id: number } | undefined;
  return r ? r.id : null;
}

// ─── the migration ────────────────────────────────────────────────────────────

/**
 * Seed the uploader model once. Hosted: a single locked `hoarder` instance
 * default from env + allow_user_defined=0. Self-host: instance x0 (default) +
 * catbox rows, allow_user_defined=1, and each user's existing uploads.* settings
 * converted into a user row with uploads.uploader_id pointed at it. Idempotent —
 * skips rows/users already converted, so a re-run is a no-op.
 */
export function seedUploaderConfig(db: Database.Database): void {
  const run = db.transaction(() => {
    if (isNodeMode()) {
      if (findHostedRow(db) == null) {
        const { config_json, secrets_enc } = hostedConfigFromEnv();
        insertRow(db, {
          scope: 'instance',
          owner_user_id: null,
          driver: 'hoarder',
          label: 'Hosted uploader',
          config_json,
          secrets_enc,
          enabled: 1,
          offered_to_users: 1,
          locked: 1,
          is_default: 1,
        });
      }
      setInstanceSettingIfAbsent(db, ALLOW_USER_DEFINED_KEY, '0');
      return;
    }

    // Self-host: ensure the built-in instance rows, then run the one-time
    // per-user conversion of existing uploads.* settings.
    const { x0Id, catboxId } = ensureSelfHostInstanceRows(db);

    const users = db.prepare('SELECT id FROM users').all() as Array<{ id: number }>;
    for (const { id: userId } of users) {
      convertUser(db, userId, x0Id, catboxId);
    }
  });
  run();
}

/**
 * Ensure the built-in instance uploaders exist on every boot (idempotent),
 * independent of the version-gated one-time seed. This is what lets a
 * newly-added built-in (e.g. the #511 local disk driver) reach an already-
 * migrated DB: bumping SCHEMA_VERSION to re-run the one-shot seed is fragile —
 * an interleaved boot can bump the version without the row — so the built-ins
 * self-heal here instead. Self-host only; the hosted locked uploader is
 * reconciled from env by reconcileHostedUploaderFromEnv.
 */
export function reconcileBuiltInUploaders(db: Database.Database): void {
  if (isNodeMode()) return;
  db.transaction(() => {
    ensureSelfHostInstanceRows(db);
  })();
}

function convertUser(db: Database.Database, userId: number, x0Id: number, catboxId: number): void {
  const settings = getUserSettingsRaw(db, userId);

  // Already converted (has a user row or an explicit uploader_id) → leave alone.
  const hasUserRow = db
    .prepare(`SELECT 1 FROM uploader_config WHERE scope = 'user' AND owner_user_id = ? LIMIT 1`)
    .get(userId);
  if (hasUserRow || settings['uploads.uploader_id'] != null) return;

  const provider =
    typeof settings['uploads.provider'] === 'string'
      ? (settings['uploads.provider'] as string)
      : 'x0';
  const userhash =
    typeof settings['uploads.catbox.userhash'] === 'string'
      ? (settings['uploads.catbox.userhash'] as string)
      : '';
  const hoarderUrl =
    typeof settings['uploads.hoarder.url'] === 'string'
      ? (settings['uploads.hoarder.url'] as string)
      : '';
  const hoarderKey =
    typeof settings['uploads.hoarder.api_key'] === 'string'
      ? (settings['uploads.hoarder.api_key'] as string)
      : '';

  let targetId: number;
  if (provider === 'catbox' && userhash) {
    // Configured catbox → a user row carrying the userhash secret.
    targetId = insertRow(db, {
      scope: 'user',
      owner_user_id: userId,
      driver: 'catbox',
      label: 'catbox.moe',
      config_json: '{}',
      secrets_enc: encodeSecrets({ userhash }),
      enabled: 1,
      offered_to_users: 0,
      locked: 0,
      is_default: 0,
    });
  } else if (provider === 'hoarder' && hoarderUrl && hoarderKey) {
    // Configured self-host hoarder → a user row (url public, api_key secret).
    targetId = insertRow(db, {
      scope: 'user',
      owner_user_id: userId,
      driver: 'hoarder',
      label: 'Hoarder',
      config_json: JSON.stringify({ url: hoarderUrl }),
      secrets_enc: encodeSecrets({ api_key: hoarderKey }),
      enabled: 1,
      offered_to_users: 0,
      locked: 0,
      is_default: 0,
    });
  } else {
    // Anonymous catbox or x0 (or unconfigured) → point at the seeded instance row.
    targetId = provider === 'catbox' ? catboxId : x0Id;
  }

  setUserSettingRaw(db, userId, 'uploads.uploader_id', targetId);
}

/**
 * Re-sync the locked hosted uploader from env on every boot. Idempotent no-op on
 * self-host. Since the config now lives in the DB row (not read from env at
 * upload time), this is what makes a deploy that rotates LURKER_NODE_UPLOAD_API_KEY
 * or changes the caps still take effect. If the seed hasn't created the row yet
 * (a boot before the migration ran), it's a no-op — the seed will create it.
 */
export function reconcileHostedUploaderFromEnv(db: Database.Database): void {
  if (!isNodeMode()) return;
  const rowId = findHostedRow(db);
  if (rowId == null) return;
  const { config_json, secrets_enc } = hostedConfigFromEnv();
  db.prepare(
    `UPDATE uploader_config SET config_json = ?, secrets_enc = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(config_json, secrets_enc, rowId);
}
