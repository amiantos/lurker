// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// CRUD for `uploader_config` — the first-class "configured uploader" (issue
// #510): a named instance of an upload driver with its settings filled in. The
// secret fields (per the driver's configSchema) are encrypted at rest into
// `secrets_enc` with the same secretCrypto envelope that protects network creds
// (plaintext no-op on self-host without LURKER_SECRET_KEY); non-secret fields go
// in `config_json`. Secrets are decrypted server-side only, at upload time, and
// never reach a client — the client-safe projection is `{ id, driver, label }`.
//
// NOTE: loaded post-boot (by the resolver / route), so importing `db` is safe.
// The seed migration (db/uploaderConfigSeed.ts) runs *during* db/index.ts
// evaluation and therefore does NOT use this module — it writes rows via raw SQL
// against its `db` parameter to avoid the import cycle.

import db from './index.js';
import { encryptSecret, decryptSecret } from '../utils/secretCrypto.js';
import { getDriver, splitConfigBySchema } from '../services/uploadProviders/index.js';

export interface UploaderConfigRow {
  id: number;
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
  created_at: string;
  updated_at: string;
}

/** Client-safe projection — never carries config values or secrets. */
export interface UploaderConfigSummary {
  id: number;
  driver: string;
  label: string;
}

/**
 * The projection for someone entitled to *edit* a row (its owner, or an admin on
 * an instance row). Carries the non-secret config values so a form can be
 * populated, plus `secretsSet` — which secret fields currently hold a value —
 * so the form can render "•••••• (set)" without the value ever leaving the
 * server. `secrets_enc` itself is never projected under any circumstances.
 *
 * A `locked` row (the hosted default) is deliberately still summarizable but not
 * detailable: routes refuse to hand out its config at all, secret or not, since
 * the operator's endpoint is not the tenant's business.
 */
export interface UploaderConfigDetail extends UploaderConfigSummary {
  scope: 'instance' | 'user';
  config: Record<string, string>;
  secretsSet: Record<string, boolean>;
  enabled: boolean;
  offeredToUsers: boolean;
  locked: boolean;
  isDefault: boolean;
}

// ─── secret encoding (pure; no db) ────────────────────────────────────────────

/** JSON-encode the secret fields and wrap them in a secretCrypto envelope.
 *  Returns null when there are no secrets (so the column stays NULL). */
export function encodeSecrets(secrets: Record<string, string>): string | null {
  if (!secrets || Object.keys(secrets).length === 0) return null;
  return encryptSecret(JSON.stringify(secrets));
}

/** Inverse of encodeSecrets: decrypt + parse back to a flat object. A malformed
 *  or undecryptable envelope (e.g. after a LURKER_SECRET_KEY rotation with no
 *  re-wrap) degrades to no-secrets rather than throwing — the caller then gets a
 *  clean "uploader unconfigured" 4xx/503 instead of a 500, and no ciphertext is
 *  handed to a driver. */
export function decodeSecrets(enc: string | null): Record<string, string> {
  if (!enc) return {};
  try {
    const json = decryptSecret(enc);
    if (!json) return {};
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function parseConfigJson(configJson: string): Record<string, string> {
  try {
    const parsed = JSON.parse(configJson || '{}');
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

// ─── reads ────────────────────────────────────────────────────────────────────

export function getUploaderConfig(id: number): UploaderConfigRow | null {
  return (
    (db.prepare('SELECT * FROM uploader_config WHERE id = ?').get(id) as
      | UploaderConfigRow
      | undefined) ?? null
  );
}

export function listInstanceUploaders(): UploaderConfigRow[] {
  return db
    .prepare(`SELECT * FROM uploader_config WHERE scope = 'instance' ORDER BY id`)
    .all() as UploaderConfigRow[];
}

export function listUserUploaders(userId: number): UploaderConfigRow[] {
  return db
    .prepare(`SELECT * FROM uploader_config WHERE scope = 'user' AND owner_user_id = ? ORDER BY id`)
    .all(userId) as UploaderConfigRow[];
}

/**
 * The single instance default (unique partial index guarantees at most one).
 *
 * `enabled = 1` is part of the query, not an afterthought: this row is the
 * fallback for every account that hasn't chosen an uploader, and it's reached in
 * resolveUploader WITHOUT going through isAllowed() (it's the default — being
 * offered to you is the whole point). Without this clause, an admin who disables
 * the default keeps every one of those accounts silently uploading through it.
 * Returning null instead surfaces as "no usable uploader" (decision 15), which is
 * the honest answer.
 */
export function getInstanceDefault(): UploaderConfigRow | null {
  return (
    (db
      .prepare(
        `SELECT * FROM uploader_config WHERE scope = 'instance' AND is_default = 1 AND enabled = 1`,
      )
      .get() as UploaderConfigRow | undefined) ?? null
  );
}

/** Merge a row's non-secret config with its decrypted secrets into the flat
 *  object a driver's upload() expects. Server-side only. */
export function resolvedConfig(row: UploaderConfigRow): Record<string, string> {
  return { ...parseConfigJson(row.config_json), ...decodeSecrets(row.secrets_enc) };
}

export function toSummary(row: UploaderConfigRow): UploaderConfigSummary {
  return { id: row.id, driver: row.driver, label: row.label };
}

/** Editor projection (see UploaderConfigDetail). Unknown driver → config fields
 *  can't be classified, so nothing is projected: an orphaned row is summarizable
 *  but not editable. */
export function toDetail(row: UploaderConfigRow): UploaderConfigDetail {
  const drv = getDriver(row.driver);
  const stored = parseConfigJson(row.config_json);
  const secrets = decodeSecrets(row.secrets_enc);
  const config: Record<string, string> = {};
  const secretsSet: Record<string, boolean> = {};
  for (const field of drv?.configSchema ?? []) {
    // The schema is the allowlist in both directions: a `secret` field only ever
    // yields a boolean, and a stale non-secret key left in config_json by an
    // older schema is dropped rather than surfaced.
    if (field.type === 'secret') secretsSet[field.key] = Boolean(secrets[field.key]);
    else config[field.key] = stored[field.key] ?? '';
  }
  return {
    ...toSummary(row),
    scope: row.scope,
    config,
    secretsSet,
    enabled: row.enabled === 1,
    offeredToUsers: row.offered_to_users === 1,
    locked: row.locked === 1,
    isDefault: row.is_default === 1,
  };
}

// ─── writes ─────────────────────────────────────────────────────────────────

export interface CreateUploaderConfigParams {
  scope: 'instance' | 'user';
  ownerUserId?: number | null;
  driver: string;
  label?: string;
  // Flat config, secrets included — split by the driver's schema before storage.
  values?: Record<string, string>;
  enabled?: boolean;
  offeredToUsers?: boolean;
  locked?: boolean;
  isDefault?: boolean;
}

const insertStmt = db.prepare(`
  INSERT INTO uploader_config
    (scope, owner_user_id, driver, label, config_json, secrets_enc,
     enabled, offered_to_users, locked, is_default)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

export function createUploaderConfig(p: CreateUploaderConfigParams): number {
  const drv = getDriver(p.driver);
  if (!drv) throw new Error(`unknown upload driver: ${p.driver}`);
  // A user-scoped row without an owner is orphaned — the resolver's allowed-set
  // can never match it (owner_user_id NULL !== any userId). Fail fast.
  if (p.scope === 'user' && p.ownerUserId == null) {
    throw new Error('a user-scoped uploader requires ownerUserId');
  }
  const { config, secrets } = splitConfigBySchema(drv, p.values ?? {});
  const info = insertStmt.run(
    p.scope,
    p.scope === 'user' ? (p.ownerUserId ?? null) : null,
    p.driver,
    p.label ?? drv.label,
    JSON.stringify(config),
    encodeSecrets(secrets),
    p.enabled === false ? 0 : 1,
    p.offeredToUsers ? 1 : 0,
    p.locked ? 1 : 0,
    p.isDefault ? 1 : 0,
  );
  return Number(info.lastInsertRowid);
}

export interface UpdateUploaderConfigParams {
  label?: string;
  // Partial flat config. A key that is absent is left alone (this is a PATCH, not
  // a PUT) — which is what lets a client edit an S3 bucket name without holding,
  // or retyping, the secret key.
  values?: Record<string, string>;
  enabled?: boolean;
  offeredToUsers?: boolean;
}

/**
 * Patch a row's label / config / enabled / offered flags. Returns false when the
 * row is gone.
 *
 * SECRET SEMANTICS — the whole reason this isn't a plain UPDATE: the client never
 * receives a secret, so it cannot send one back on an edit. An omitted secret
 * field, or one sent as the empty string, therefore means "keep what's stored",
 * never "clear it". (Clearing a secret means deleting the uploader; every secret
 * in every driver's schema today is `required`, so a cleared one would be a
 * broken row anyway.) Non-secret fields follow ordinary PATCH rules: present →
 * written (empty string clears), absent → untouched.
 */
export function updateUploaderConfig(id: number, p: UpdateUploaderConfigParams): boolean {
  const row = getUploaderConfig(id);
  if (!row) return false;
  const drv = getDriver(row.driver);
  if (!drv) throw new Error(`unknown upload driver: ${row.driver}`);

  const { config, secrets } = splitConfigBySchema(drv, p.values ?? {});
  const mergedConfig = { ...parseConfigJson(row.config_json), ...config };
  const mergedSecrets = { ...decodeSecrets(row.secrets_enc) };
  for (const [k, v] of Object.entries(secrets)) {
    if (v !== '') mergedSecrets[k] = v;
  }

  db.prepare(
    `UPDATE uploader_config
        SET label = ?, config_json = ?, secrets_enc = ?, enabled = ?, offered_to_users = ?,
            updated_at = datetime('now')
      WHERE id = ?`,
  ).run(
    p.label ?? row.label,
    JSON.stringify(mergedConfig),
    encodeSecrets(mergedSecrets),
    p.enabled === undefined ? row.enabled : p.enabled ? 1 : 0,
    p.offeredToUsers === undefined ? row.offered_to_users : p.offeredToUsers ? 1 : 0,
    id,
  );
  return true;
}

/**
 * Make one instance row THE instance default, clearing any incumbent. Done in a
 * transaction because `idx_uploader_config_one_default` is a unique partial index
 * — setting the new flag before clearing the old one would trip it. Returns false
 * if the row is missing or user-scoped (a user's default is their
 * `uploads.uploader_id` setting, not a column).
 */
export function setInstanceDefault(id: number): boolean {
  const row = getUploaderConfig(id);
  if (!row || row.scope !== 'instance') return false;
  db.transaction(() => {
    db.prepare(
      `UPDATE uploader_config SET is_default = 0, updated_at = datetime('now')
        WHERE scope = 'instance' AND is_default = 1 AND id != ?`,
    ).run(id);
    db.prepare(
      `UPDATE uploader_config SET is_default = 1, updated_at = datetime('now') WHERE id = ?`,
    ).run(id);
  })();
  return true;
}

export function deleteUploaderConfig(id: number): boolean {
  const info = db.prepare('DELETE FROM uploader_config WHERE id = ?').run(id);
  return info.changes > 0;
}
