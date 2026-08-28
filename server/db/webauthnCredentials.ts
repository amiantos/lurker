// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import db from './index.js';

/** A row from the `webauthn_credentials` table. */
export interface WebAuthnCredentialRow {
  id: number;
  user_id: number;
  credential_id: string;
  public_key: Buffer;
  counter: number;
  transports: string | null;
  device_type: string | null;
  backed_up: number;
  label: string | null;
  created_at: string;
  last_used_at: string | null;
}

/** Projected credential shape returned to callers (camelCase). */
export interface WebAuthnCredential {
  id: number;
  userId: number;
  credentialId: string;
  publicKey: Buffer;
  counter: number;
  transports: string[];
  deviceType: string | null;
  backedUp: boolean;
  label: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

/** Fields required to insert a new credential. */
export interface InsertCredentialFields {
  userId: number;
  credentialId: string;
  publicKey: Buffer;
  counter: number;
  transports?: string[] | null;
  deviceType?: string | null;
  backedUp?: boolean;
  label?: string | null;
}

function rowToCred(row: WebAuthnCredentialRow | undefined): WebAuthnCredential | null {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    credentialId: row.credential_id,
    publicKey: row.public_key,
    counter: row.counter,
    transports: row.transports ? (JSON.parse(row.transports) as string[]) : [],
    deviceType: row.device_type || null,
    backedUp: !!row.backed_up,
    label: row.label || null,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

export function listForUser(userId: number): Array<WebAuthnCredential | null> {
  return (
    db
      .prepare('SELECT * FROM webauthn_credentials WHERE user_id = ? ORDER BY id')
      .all(userId) as WebAuthnCredentialRow[]
  ).map(rowToCred);
}

export function findByCredentialId(credentialId: string): WebAuthnCredential | null {
  return rowToCred(
    db.prepare('SELECT * FROM webauthn_credentials WHERE credential_id = ?').get(credentialId) as
      | WebAuthnCredentialRow
      | undefined,
  );
}

export function countAll(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM webauthn_credentials').get() as { n: number }).n;
}

export function countForUser(userId: number): number {
  return (
    db.prepare('SELECT COUNT(*) AS n FROM webauthn_credentials WHERE user_id = ?').get(userId) as {
      n: number;
    }
  ).n;
}

export function insertCredential({
  userId,
  credentialId,
  publicKey,
  counter,
  transports,
  deviceType,
  backedUp,
  label,
}: InsertCredentialFields): WebAuthnCredential | null {
  const stmt = db.prepare(`
    INSERT INTO webauthn_credentials
      (user_id, credential_id, public_key, counter, transports, device_type, backed_up, label)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(
    userId,
    credentialId,
    publicKey,
    counter || 0,
    transports ? JSON.stringify(transports) : null,
    deviceType || null,
    backedUp ? 1 : 0,
    label || null,
  );
  return rowToCred(
    db.prepare('SELECT * FROM webauthn_credentials WHERE id = ?').get(info.lastInsertRowid) as
      | WebAuthnCredentialRow
      | undefined,
  );
}

export function updateCounter(id: number, counter: number): void {
  db.prepare(
    `
    UPDATE webauthn_credentials
    SET counter = ?, last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `,
  ).run(counter, id);
}

export function updateLabel(id: number, userId: number, label: string | null): boolean {
  const result = db
    .prepare('UPDATE webauthn_credentials SET label = ? WHERE id = ? AND user_id = ?')
    .run(label || null, id, userId);
  return result.changes > 0;
}

/**
 * Remove every passkey on an account, returning how many went.
 *
 * For account recovery (#855), which assumes the account was taken over: a
 * passkey the attacker enrolled is a way back in that survives a password
 * change, and nothing distinguishes it from the member's own. Note this has no
 * last-credential guard, unlike deleteById — the recovery path re-establishes a
 * credential in the same transaction, so the account is never left unreachable.
 */
export function deleteAllForUser(userId: number): number {
  return db.prepare('DELETE FROM webauthn_credentials WHERE user_id = ?').run(userId).changes;
}

export function deleteById(id: number, userId: number): boolean {
  const result = db
    .prepare('DELETE FROM webauthn_credentials WHERE id = ? AND user_id = ?')
    .run(id, userId);
  return result.changes > 0;
}
