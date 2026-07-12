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

/**
 * The instance uploaders ensureSelfHostInstanceRows guarantees on every boot.
 * Exported because "is this row a built-in?" has exactly one correct answer —
 * "will the reconcile put it back if I delete it?" — and the admin route needs
 * it to refuse a delete that would be pure theatre (and, for `local`, would
 * strand the files already on disk with nothing left that can reap them).
 *
 * Note this is NOT the same question as the driver's `creatable` capability:
 * `catbox` is both a seeded built-in AND a driver a user may instantiate with
 * their own userhash.
 */
export const BUILT_IN_INSTANCE_DRIVERS: readonly string[] = Object.freeze([
  'x0',
  'catbox',
  'local',
]);

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
 * default).
 */
function ensureSelfHostInstanceRows(db: Database.Database): void {
  const defaultExists = hasInstanceDefault(db);
  ensureInstanceRow(db, {
    driver: 'x0',
    label: 'x0.at',
    offered: true,
    isDefault: !defaultExists,
  });
  ensureInstanceRow(db, {
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
 * Seed the uploader model. Hosted: a single locked `hoarder` instance default
 * from env + allow_user_defined=0. Self-host: the built-in instance rows (x0
 * default, catbox, local) + allow_user_defined=1. Fully idempotent.
 *
 * The per-user conversion off the legacy `uploads.*` settings is NOT here — it
 * lives in reconcileLegacyUploadSettings, which runs every boot instead of behind
 * this version gate. See that function's header.
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

    // Self-host: ensure the built-in instance rows. The per-user conversion of
    // the legacy uploads.* settings is NOT done here — reconcileLegacyUploadSettings
    // owns it and runs every boot (see its header for why a one-shot is wrong).
    ensureSelfHostInstanceRows(db);
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

// ─── legacy `uploads.*` keys → uploader_config rows (P3, #514) ────────────────

// The four per-user settings keys the pre-#510 uploader was configured through.
// P3 deletes them from the registry, so this module owns the last leg of their
// life: materialize whatever they still hold into real rows, then drop them.
const LEGACY_KEYS = [
  'uploads.provider',
  'uploads.catbox.userhash',
  'uploads.hoarder.url',
  'uploads.hoarder.api_key',
] as const;

const LEGACY_KEY_PLACEHOLDERS = LEGACY_KEYS.map(() => '?').join(',');

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function findUserRowByDriver(db: Database.Database, userId: number, driver: string): number | null {
  const r = db
    .prepare(
      `SELECT id FROM uploader_config
        WHERE scope = 'user' AND owner_user_id = ? AND driver = ? LIMIT 1`,
    )
    .get(userId, driver) as { id: number } | undefined;
  return r ? r.id : null;
}

/**
 * Create — or refresh — the user's row for a driver from their legacy settings.
 *
 * Refresh (rather than "never clobber", the P0 seed's rule) is deliberate and is
 * the fix for the regression this migration exists to close: the settings keys
 * were the ONLY UI that could edit these credentials, so a value sitting in
 * user_settings is by definition at least as fresh as the one P0's one-shot seed
 * copied into the row. If they're identical this is a no-op; if they differ, the
 * settings value is the user's later intent and the row's is stale.
 */
function upsertUserRow(
  db: Database.Database,
  userId: number,
  spec: {
    driver: string;
    label: string;
    config: Record<string, string>;
    secrets: Record<string, string>;
  },
): number {
  const existing = findUserRowByDriver(db, userId, spec.driver);
  if (existing != null) {
    db.prepare(
      `UPDATE uploader_config
          SET config_json = ?, secrets_enc = ?, enabled = 1, updated_at = datetime('now')
        WHERE id = ?`,
    ).run(JSON.stringify(spec.config), encodeSecrets(spec.secrets), existing);
    return existing;
  }
  return insertRow(db, {
    scope: 'user',
    owner_user_id: userId,
    driver: spec.driver,
    label: spec.label,
    config_json: JSON.stringify(spec.config),
    secrets_enc: encodeSecrets(spec.secrets),
    enabled: 1,
    offered_to_users: 0,
    locked: 0,
    is_default: 0,
  });
}

function migrateUserOffLegacyKeys(db: Database.Database, userId: number): void {
  const s = getUserSettingsRaw(db, userId);
  const provider = str(s['uploads.provider']);
  const userhash = str(s['uploads.catbox.userhash']);
  const hoarderUrl = str(s['uploads.hoarder.url']);
  const hoarderKey = str(s['uploads.hoarder.api_key']);

  // Materialize every credential we find, REGARDLESS of which provider is
  // selected. We are about to delete the only copy of these values, and a user
  // who has a catbox userhash saved but is currently on x0 still owns that
  // userhash — it should show up as a configured uploader they can switch to,
  // not evaporate.
  const catboxRowId = userhash
    ? upsertUserRow(db, userId, {
        driver: 'catbox',
        label: 'catbox.moe',
        config: {},
        secrets: { userhash },
      })
    : null;
  const hoarderRowId =
    hoarderUrl && hoarderKey
      ? upsertUserRow(db, userId, {
          driver: 'hoarder',
          label: 'Hoarder',
          config: { url: hoarderUrl },
          secrets: { api_key: hoarderKey },
        })
      : null;

  // Then point their default at whatever the dropdown last said, because the
  // dropdown — not uploads.uploader_id — is what the P0 bridge actually honored.
  let targetId: number | null = null;
  switch (provider) {
    case 'catbox':
      // Their own row if they have a userhash, else the anonymous instance row.
      targetId = catboxRowId ?? findInstanceRowByDriver(db, 'catbox');
      break;
    case 'hoarder':
      // There is no instance hoarder row on self-host: if they picked hoarder
      // without complete credentials, the bridge was already silently sending
      // their uploads to x0. Falling through to the x0 default below preserves
      // that (broken) behavior rather than inventing a half-configured row.
      targetId = hoarderRowId;
      break;
    case 'x0':
    case 'local':
      targetId = findInstanceRowByDriver(db, provider);
      break;
    default:
      targetId = null;
  }

  if (targetId == null) {
    // No usable provider selection. Keep an existing pointer if they have one
    // (the P0 seed set it); otherwise fall back to the instance x0 row, which is
    // exactly where the old default-'x0' enum sent them.
    if (typeof s['uploads.uploader_id'] === 'number') return;
    targetId = findInstanceRowByDriver(db, 'x0');
  }
  if (targetId != null) setUserSettingRaw(db, userId, 'uploads.uploader_id', targetId);
}

/**
 * Fold the legacy `uploads.*` credential/selection keys into real uploader_config
 * rows and then delete them (issue #514). Runs on EVERY boot, not behind a
 * SCHEMA_VERSION gate: the version-gated one-shot is exactly the pattern that
 * wedged a dev DB during #511 (an interleaved restart bumped the version without
 * running the seed), and this migration is naturally self-terminating anyway —
 * once the keys are gone the guard SELECT returns nothing and it is a permanent
 * no-op. That also makes it self-healing against an import that reintroduces the
 * old keys from an archive predating this release.
 *
 * This is what closes the P0 hole where the keys were converted once and then
 * ignored: a user who configured Hoarder (or changed their catbox userhash)
 * *after* the P0 migration had their credential silently dropped and their
 * uploads rerouted to the x0 public host.
 *
 * Hosted never honored these keys (node mode forced the operator's uploader), so
 * there is nothing to materialize there — the keys are simply pruned.
 */
export function reconcileLegacyUploadSettings(db: Database.Database): void {
  const holders = db
    .prepare(`SELECT DISTINCT user_id FROM user_settings WHERE key IN (${LEGACY_KEY_PLACEHOLDERS})`)
    .all(...LEGACY_KEYS) as Array<{ user_id: number }>;
  if (holders.length === 0) return;

  db.transaction(() => {
    if (!isNodeMode()) {
      for (const { user_id } of holders) migrateUserOffLegacyKeys(db, user_id);
    }
    db.prepare(`DELETE FROM user_settings WHERE key IN (${LEGACY_KEY_PLACEHOLDERS})`).run(
      ...LEGACY_KEYS,
    );
  })();
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
