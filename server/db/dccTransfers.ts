// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Persistence for the DCC download manager (#270) — one row per inbound DCC
// transfer. The IRC connection lives on the cell, so received bytes land on disk
// at destination_path while this row tracks the transfer's lifecycle for the
// download-manager UI and survives a cell restart (so a stalled transfer can be
// resumed). Nothing here touches the message tables.

import db from './index.js';

// The download-manager state machine. Two entry states:
//   - `requested`: we sent an XDCC trigger and armed acceptance for the bot's
//     reply (phase 1). Survives a slow bot queue — the row just waits.
//   - `pending_approval`: an UNSOLICITED offer awaiting the user's Accept/Reject
//     (phase 2). Phase 0 records every detected offer here, since arming doesn't
//     exist yet and nothing may auto-land.
// From an accepted offer the flow is connecting → receiving → (stalled, on a
// dropped connection or restart) → verifying → completed; or it ends
// failed / rejected / cancelled. Kept as a TS union + a TEXT column (matching the
// repo's other enum columns, e.g. peer_presence_state.state) rather than a DB
// CHECK, so the allowed values live in one documented place.
export type DccTransferState =
  | 'requested'
  | 'pending_approval'
  | 'connecting'
  | 'receiving'
  | 'stalled'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'rejected'
  | 'cancelled';

export interface DccTransferRow {
  id: number;
  user_id: number;
  network_id: number;
  peer_nick: string;
  direction: string;
  filename: string;
  advertised_size: number;
  received_bytes: number;
  destination_path: string | null;
  state: DccTransferState;
  passive: number;
  token: number | null;
  trigger_text: string | null;
  crc_expected: string | null;
  crc_actual: string | null;
  crc_status: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface InsertDccTransferFields {
  network_id: number;
  peer_nick: string;
  filename: string;
  advertised_size: number;
  state: DccTransferState;
  passive?: boolean;
  token?: number | null;
  /** The XDCC trigger we sent, kept so a stalled transfer can be re-requested on
   *  manual resume. Null for an unsolicited offer. */
  trigger_text?: string | null;
  /** CRC32 parsed from the filename (e.g. `[A1B2C3D4]`), null when absent. */
  crc_expected?: string | null;
}

const insertStmt = db.prepare(`
  INSERT INTO dcc_transfers
    (user_id, network_id, peer_nick, filename, advertised_size, state,
     passive, token, trigger_text, crc_expected)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

export function insertDccTransfer(userId: number, f: InsertDccTransferFields): number {
  const info = insertStmt.run(
    userId,
    f.network_id,
    f.peer_nick,
    f.filename,
    f.advertised_size,
    f.state,
    f.passive ? 1 : 0,
    f.token ?? null,
    f.trigger_text ?? null,
    f.crc_expected ?? null,
  );
  return Number(info.lastInsertRowid);
}

/** A single transfer, scoped to its owner (every read path is user-scoped — a
 *  transfer is private to the account that requested it). */
export function getDccTransfer(userId: number, id: number): DccTransferRow | undefined {
  return db
    .prepare('SELECT * FROM dcc_transfers WHERE user_id = ? AND id = ?')
    .get(userId, Number(id)) as DccTransferRow | undefined;
}

/** A user's transfers, newest first — backs the download-manager view. */
export function listDccTransfers(
  userId: number,
  { limit = 100 }: { limit?: number } = {},
): DccTransferRow[] {
  const lim = Math.max(1, Math.min(500, Number(limit) || 100));
  return db
    .prepare('SELECT * FROM dcc_transfers WHERE user_id = ? ORDER BY id DESC LIMIT ?')
    .all(userId, lim) as DccTransferRow[];
}

/** Transition a transfer's state, optionally stamping an error. Always bumps
 *  updated_at. The receive engine (phase 1+) drives the richer transitions;
 *  phase 0/2 use this for cancel/reject. */
export function updateDccTransferState(
  id: number,
  state: DccTransferState,
  error: string | null = null,
): void {
  db.prepare(
    `UPDATE dcc_transfers SET state = ?, error = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(state, error, Number(id));
}

/** The most recent still-waiting `requested` row for a bot on a network — used to
 *  match an inbound DCC SEND offer to a trigger the user sent (arm-on-trigger
 *  auto-accept). peer_nick collates NOCASE, so the bot's nick casing in the offer
 *  needn't match what the user typed. */
export function findArmedRequest(
  userId: number,
  networkId: number,
  peerNick: string,
): DccTransferRow | undefined {
  return db
    .prepare(
      `SELECT * FROM dcc_transfers
       WHERE user_id = ? AND network_id = ? AND peer_nick = ? AND state = 'requested'
       ORDER BY id DESC LIMIT 1`,
    )
    .get(userId, networkId, peerNick) as DccTransferRow | undefined;
}

export interface DccReceivingFields {
  /** The real filename from the offer (the `requested` row held a placeholder). */
  filename: string;
  advertised_size: number;
  destination_path: string;
  passive?: boolean;
  token?: number | null;
}

/** Promote a transfer to `receiving` once an offer is accepted, stamping the
 *  real filename/size/destination from the offer and clearing any prior error. */
export function markDccReceiving(id: number, f: DccReceivingFields): void {
  db.prepare(
    `UPDATE dcc_transfers
       SET state = 'receiving', filename = ?, advertised_size = ?, destination_path = ?,
           passive = ?, token = ?, error = NULL, updated_at = datetime('now')
     WHERE id = ?`,
  ).run(
    f.filename,
    f.advertised_size,
    f.destination_path,
    f.passive ? 1 : 0,
    f.token ?? null,
    Number(id),
  );
}

/** Checkpoint progress. Called on a throttle by the caller (never per-chunk) so
 *  the single shared SQLite connection isn't hammered. */
export function updateDccReceivedBytes(id: number, received: number): void {
  db.prepare(
    `UPDATE dcc_transfers SET received_bytes = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(received, Number(id));
}

/** Mark a transfer failed, stamping the final byte count (so a throttled
 *  progress write doesn't leave received_bytes stale) and the reason. */
export function markDccFailed(id: number, received: number, error: string): void {
  db.prepare(
    `UPDATE dcc_transfers
       SET state = 'failed', received_bytes = ?, error = ?, updated_at = datetime('now')
     WHERE id = ?`,
  ).run(received, error, Number(id));
}

/** Mark a transfer done, stamping the final byte count and completion time. */
export function markDccCompleted(id: number, received: number): void {
  db.prepare(
    `UPDATE dcc_transfers
       SET state = 'completed', received_bytes = ?, error = NULL,
           completed_at = datetime('now'), updated_at = datetime('now')
     WHERE id = ?`,
  ).run(received, Number(id));
}
