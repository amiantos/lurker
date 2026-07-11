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

/** The single instance default (unique partial index guarantees at most one). */
export function getInstanceDefault(): UploaderConfigRow | null {
  return (
    (db
      .prepare(`SELECT * FROM uploader_config WHERE scope = 'instance' AND is_default = 1`)
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

export function deleteUploaderConfig(id: number): boolean {
  const info = db.prepare('DELETE FROM uploader_config WHERE id = ?').run(id);
  return info.changes > 0;
}
