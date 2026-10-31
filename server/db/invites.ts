// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import crypto from 'crypto';
import db from './index.js';
import {
  restrictionsFromStored,
  serializeAccountRestrictions,
  type AccountRestrictions,
} from '../../shared/accountRestrictions.js';

/** A row from `invite_tokens` (camelCase aliased columns). */
export interface InviteToken {
  token: string;
  createdBy: number;
  expiresAt: string | null;
  usedByUserId: number | null;
  usedAt: string | null;
  createdAt: string;
  /** The restrictions the redeeming account is born with, stored form (NULL = none). */
  restrictions: string | null;
}

/** The restrictions an invite hands the account it creates. */
export function inviteRestrictions(invite: { restrictions: string | null }): AccountRestrictions {
  return restrictionsFromStored(invite.restrictions);
}

/** InviteToken row joined with creator/redeemer usernames. */
export interface InviteTokenWithUsers extends InviteToken {
  createdByUsername: string | null;
  usedByUsername: string | null;
}

/** Result of inviteStatus(). */
export type InviteStatusResult =
  | { status: 'unknown' }
  | { status: 'consumed' }
  | { status: 'expired' }
  | { status: 'valid'; invite: InviteToken };

// 24 random bytes → 32-char base64url. Plenty of entropy for an invite link
// that's only valid until first use (or until manually revoked).
function generateToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

export function createInvite(
  createdBy: number,
  {
    expiresInDays = 7,
    restrictions,
  }: { expiresInDays?: number; restrictions?: AccountRestrictions } = {},
): InviteToken | null {
  const token = generateToken();
  const expiresAt =
    expiresInDays > 0
      ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString()
      : null;
  db.prepare(
    `
    INSERT INTO invite_tokens (token, created_by, expires_at, restrictions)
    VALUES (?, ?, ?, ?)
  `,
  ).run(
    token,
    createdBy,
    expiresAt,
    restrictions ? serializeAccountRestrictions(restrictions) : null,
  );
  return getInvite(token);
}

export function getInvite(token: string | null | undefined): InviteToken | null {
  if (!token) return null;
  return (
    (db
      .prepare(
        `
    SELECT token, created_by AS createdBy, expires_at AS expiresAt,
           used_by_user_id AS usedByUserId, used_at AS usedAt,
           created_at AS createdAt, restrictions
    FROM invite_tokens WHERE token = ?
  `,
      )
      .get(token) as InviteToken | undefined) ?? null
  );
}

export function listInvites(): InviteTokenWithUsers[] {
  return db
    .prepare(
      `
    SELECT i.token, i.created_by AS createdBy, i.expires_at AS expiresAt,
           i.used_by_user_id AS usedByUserId, i.used_at AS usedAt,
           i.created_at AS createdAt, i.restrictions,
           c.username AS createdByUsername,
           u.username AS usedByUsername
    FROM invite_tokens i
    LEFT JOIN users c ON c.id = i.created_by
    LEFT JOIN users u ON u.id = i.used_by_user_id
    ORDER BY i.created_at DESC
  `,
    )
    .all() as InviteTokenWithUsers[];
}

export function deleteInvite(token: string): boolean {
  const info = db.prepare('DELETE FROM invite_tokens WHERE token = ?').run(token);
  return info.changes > 0;
}

// An invite is spent if EITHER half of the consume is on the row. consumeInvite
// writes used_by_user_id and used_at together, so under normal operation the two
// always agree — but only the id is a foreign key, so only the id can be rewritten
// out from under us by a user deletion. Reading both means a row that loses its
// redeemer stays spent instead of turning back into a live link (#590), and it is
// the one rule the admin list and the redemption path have to agree on, so they
// share it rather than each re-deriving it.
export function isInviteSpent(row: {
  usedByUserId: number | null;
  usedAt: string | null;
}): boolean {
  return row.usedByUserId != null || row.usedAt != null;
}

// Check status without mutating. Returns one of:
//   { status: 'unknown' } — no row for this token
//   { status: 'consumed' } — already redeemed
//   { status: 'expired' } — expires_at has passed
//   { status: 'valid', invite } — usable
export function inviteStatus(token: string): InviteStatusResult {
  const invite = getInvite(token);
  if (!invite) return { status: 'unknown' };
  if (isInviteSpent(invite)) return { status: 'consumed' };
  if (invite.expiresAt && Date.parse(invite.expiresAt) < Date.now()) {
    return { status: 'expired' };
  }
  return { status: 'valid', invite };
}

// Mark an invite consumed atomically. Returns true if we won the race; false
// if it was already used or doesn't exist. The UPDATE guards on the same
// spent-ness rule isInviteSpent() reads, so two simultaneous redemptions can't
// both succeed AND a row whose redeemer was deleted can't be redeemed again.
export function consumeInvite(token: string, userId: number): boolean {
  const info = db
    .prepare(
      `
    UPDATE invite_tokens
    SET used_by_user_id = ?, used_at = datetime('now')
    WHERE token = ? AND used_by_user_id IS NULL AND used_at IS NULL
  `,
    )
    .run(userId, token);
  return info.changes > 0;
}
