// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The engine catch-up mark (#1068): per network and engine socket, the highest
// engine line seq this instance has stored a message row for.
//
// The engine numbers every inbound line it delivers and re-delivers, after a
// re-attach, exactly the lines nobody acked (lineBuffer.ts). The next process
// reads the mark while that backlog arrives and skips any line at or below it
// outright (IrcConnection.alreadyPersisted), instead of guessing from the
// line's content whether it has the row already.
//
// Written WITH the row, never near it: storeUnderMark runs the insert and the
// mark in one transaction, so there is no moment at which the row exists
// without its mark or — the one that would lose a line — the mark without its
// row. A caught insert failure moves nothing. Only a line that stores a
// message row moves the mark: a line that stores none is harmless to see
// again, and a cell's hundred idle networks must not each pay a write per
// server chunk.
//
// Seqs count from 1 on every socket, so a mark means nothing beside another
// socket. Rows are keyed by the socket id the engine names on `open` and
// `attached` (protocol minor 6), and the two ways app processes overlap on one
// database differ in which row they share:
// - A takeover (a rolling deploy) hands the SAME socket to the successor. Both
//   write the one row, which only ever rises, and the predecessor may still be
//   finishing its last batch while the successor's backlog — the same lines —
//   arrives. storeUnderMark re-reads the mark under the write lock before
//   inserting, so whichever process gets there second stores nothing.
// - A fresh dial (the socket died, or the engine restarted) names a NEW socket.
//   A late write from the predecessor lands in the old socket's own row and can
//   never touch the new one. The rows other sockets left are pruned at attach.
// An engine that names no socket writes no mark.

import db from './index.js';

const getStmt = db.prepare('SELECT seq FROM engine_marks WHERE network_id = ? AND socket = ?');
const setStmt = db.prepare(
  `INSERT INTO engine_marks (network_id, socket, seq) VALUES (?, ?, ?)
   ON CONFLICT(network_id, socket) DO UPDATE SET seq = excluded.seq
   WHERE engine_marks.seq < excluded.seq`,
);
const pruneStmt = db.prepare('DELETE FROM engine_marks WHERE network_id = ? AND socket IS NOT ?');

/** The highest seq stored on this socket, or null if nothing was. */
export function getEngineMark(networkId: number, socket: string): number | null {
  const row = getStmt.get(networkId, socket) as { seq: number } | undefined;
  return row?.seq ?? null;
}

export function setEngineMark(networkId: number, socket: string, seq: number): void {
  setStmt.run(networkId, socket, seq);
}

/** Forget every socket's mark but `keep`'s (all of them for null): a socket the
 *  app is not on again is a socket whose seqs will never be delivered again. */
export function pruneEngineMarks(networkId: number, keep: string | null): void {
  pruneStmt.run(networkId, keep);
}

// Store the row a line produced and raise the mark to the line's seq, in one
// transaction — immediate, so the write lock is held from the re-check on:
// a read-then-write under a deferred BEGIN fails with BUSY_SNAPSHOT when
// another connection (a predecessor, Litestream) commits in between, and
// busy_timeout never gets a say (db/index.ts has the same rule for boot).
// Null, and nothing stored, when the mark has reached `seq` meanwhile: the
// predecessor stored this line. A throw from `insert` rolls back and
// continues to the caller, with the mark where it was.
const storeTx = db.transaction(
  <T>(networkId: number, socket: string, seq: number, insert: () => T): T | null => {
    if (seq <= (getEngineMark(networkId, socket) ?? 0)) return null;
    const row = insert();
    setEngineMark(networkId, socket, seq);
    return row;
  },
);
export function storeUnderMark<T>(
  networkId: number,
  socket: string,
  seq: number,
  insert: () => T,
): T | null {
  return storeTx.immediate(networkId, socket, seq, insert) as T | null;
}
