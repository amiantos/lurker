// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The push log (#1272): one row per push attempt per user, kept 7 days, so a
// "the relay is flaky" report can be answered with what this server actually
// did. Most of the rows are 'suppressed' — a highlight that would have pushed
// but didn't, with the gate that stopped it named (maybePush in wsHub, deliver
// in pushService). The rest are one row per device with the push service's
// answer: a 201 from push.lurker.chat means the relay forwarded the push and
// APNs/FCM accepted it, which is where this server's evidence ends.
//
// Never the message text. The admin view shows every user's rows.

import db from './index.js';
import type { Statement } from 'better-sqlite3';

export const PUSH_LOG_DAYS = 7;

// Prepared once, on first use: a write per held highlight sits on the WS
// fan-out path, and better-sqlite3 re-plans anything prepared per call.
const stmts: Record<string, Statement> = {};
function stmt(key: string, sql: string): Statement {
  return (stmts[key] ??= db.prepare(sql));
}

export type PushLogOutcome = 'sent' | 'failed' | 'suppressed';

/**
 * Why a push didn't go out. The maybePush gates in the order they're checked,
 * then deliver()'s own. Spelled out here so the panes can turn each into words
 * and a reason added server-side fails typecheck in the client until it has
 * some.
 */
export type PushSuppressedReason =
  | 'visible_client'
  | 'kind_disabled'
  | 'not_favorite'
  | 'manual_away'
  | 'quiet_hours'
  | 'oversize'
  | 'relay_off'
  | 'unconfigured';

export interface PushLogRow {
  id: number;
  user_id: number;
  at: string;
  kind: string;
  network_id: number | null;
  network_name: string | null;
  target: string | null;
  nick: string | null;
  message_id: number | null;
  outcome: PushLogOutcome;
  /** The gate for a suppressed row; the sender's one-line diagnostic for a failed one. */
  reason: string | null;
  transport: string | null;
  /** The endpoint host for Web Push, a token prefix for native (pushService.describeSub). */
  device: string | null;
  /** The push service's HTTP status, when there was one. */
  status: number | null;
}

/** What a push is about — the same for every row an attempt writes. */
export interface PushLogSubject {
  kind: string;
  networkId?: number | null;
  networkName?: string | null;
  target?: string | null;
  nick?: string | null;
  messageId?: number | null;
}

export interface PushLogEntry extends PushLogSubject {
  outcome: PushLogOutcome;
  reason?: string | null;
  transport?: string | null;
  device?: string | null;
  status?: number | null;
}

export function recordPushLog(userId: number, entry: PushLogEntry, at = new Date()): void {
  stmt(
    'insert',
    `INSERT INTO push_log (user_id, at, kind, network_id, network_name, target, nick, message_id,
                           outcome, reason, transport, device, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    userId,
    at.toISOString(),
    entry.kind,
    entry.networkId ?? null,
    entry.networkName ?? null,
    entry.target ?? null,
    entry.nick ?? null,
    entry.messageId ?? null,
    entry.outcome,
    entry.reason ?? null,
    entry.transport ?? null,
    entry.device ?? null,
    entry.status ?? null,
  );
}

export function listPushLogForUser(userId: number, limit: number): PushLogRow[] {
  return stmt(
    'forUser',
    'SELECT * FROM push_log WHERE user_id = ? ORDER BY at DESC, id DESC LIMIT ?',
  ).all(userId, limit) as PushLogRow[];
}

/** Every user's rows (admin), optionally one user's, with the username joined on. */
export function listPushLog(
  limit: number,
  userId: number | null = null,
): (PushLogRow & { username: string | null })[] {
  const where = userId === null ? '' : 'WHERE l.user_id = ?';
  const params = userId === null ? [limit] : [userId, limit];
  return db
    .prepare(
      `SELECT l.*, u.username FROM push_log l LEFT JOIN users u ON u.id = l.user_id
       ${where} ORDER BY l.at DESC, l.id DESC LIMIT ?`,
    )
    .all(...params) as (PushLogRow & { username: string | null })[];
}

/** Drop rows older than PUSH_LOG_DAYS. Returns how many went. */
export function prunePushLog(now = new Date()): number {
  const cutoff = new Date(now.getTime() - PUSH_LOG_DAYS * 24 * 60 * 60 * 1000).toISOString();
  return stmt('prune', 'DELETE FROM push_log WHERE at < ?').run(cutoff).changes;
}
