// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The engine catch-up mark (#1068): per network and engine socket, the highest
// engine line seq this instance has stored a row for.
//
// The engine numbers every inbound line it delivers and re-delivers, after a
// re-attach, exactly the lines nobody acked (lineBuffer.ts). The next process
// reads the mark while that backlog arrives and skips any line at or below it
// outright (IrcConnection.alreadyPersisted), instead of guessing from the
// line's content whether it has the row already.
//
// Written WITH the rows: a line is delivered inside one transaction
// (deliverUnderMark), and the mark goes in beside whatever rows the line's
// handlers wrote, so there is no moment at which a row exists without its mark
// or a mark without its rows. Only a line that wrote a row moves it — a line
// that persists nothing is harmless to see again, and a cell's hundred idle
// networks must not each ship a WAL write per server chunk.
//
// Seqs count from 1 on every socket, so a mark means nothing beside another
// socket: a fresh dial under the same network, a re-dial after the engine
// restarted. Rows are keyed by the socket id the engine names on `open` and
// `attached` (protocol minor 6), and a row only ever rises; a process that
// outlives its claim (a rolling deploy's predecessor, finishing a batch after
// the successor attached) writes under ITS socket and can never move the
// successor's row. The rows another socket left are pruned at the next attach.
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

// Deliver one engine line and record it, atomically. `deliver` runs the
// line's handlers and says whether any of them wrote a row; if so the mark
// rises to `seq` in the same transaction. A handler that throws rolls the
// line's rows back with it, and the throw continues to the caller — the line
// then goes unacked, and comes again.
const deliverTx = db.transaction(
  (networkId: number, socket: string, seq: number, deliver: () => boolean) => {
    if (deliver()) setEngineMark(networkId, socket, seq);
  },
);
export function deliverUnderMark(
  networkId: number,
  socket: string,
  seq: number,
  deliver: () => boolean,
): void {
  deliverTx(networkId, socket, seq, deliver);
}
