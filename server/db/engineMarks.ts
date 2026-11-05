// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The engine catch-up mark (#1068): per network, the highest engine line seq
// this instance has fully processed, beside the socket it was counted on.
//
// The engine numbers every inbound line it delivers and re-delivers, after a
// re-attach, exactly the lines nobody acked (lineBuffer.ts). The ack is sent
// once a line's handlers — persistence included — have run, so "acked" and
// "stored" are the same fact; what this table adds is that the fact survives
// the process. The next process reads it at `attached` and skips any backlog
// line at or below it outright (IrcConnection.alreadyPersisted), instead of
// guessing from the line's content whether it has the row already.
//
// Seqs count from 1 on every socket, so a mark means nothing beside another
// socket: a fresh dial under the same network, a re-dial after the engine
// restarted. The socket id the engine names on `open` and `attached` (protocol
// minor 6) is stored with the seq, and a mark is only honoured for the socket
// it was written on. An engine that names no socket writes no mark.
//
// Written behind the rows, never ahead of them: once per delivered batch,
// beside the ack (engineTransport.ts). A process that dies between a row and
// its mark leaves the mark a batch short, and those lines come again as seqs
// above it — the content probes still cover that, as they covered everything
// before. The mark can therefore be stale but never wrong.

import db from './index.js';
import type { Statement } from 'better-sqlite3';

const stmts: Record<string, Statement> = {};
function stmt(key: string, sql: string): Statement {
  return (stmts[key] ??= db.prepare(sql));
}

export interface EngineMark {
  socket: string;
  seq: number;
}

export function getEngineMark(networkId: number): EngineMark | null {
  const row = stmt('get', 'SELECT socket, seq FROM engine_marks WHERE network_id = ?').get(
    networkId,
  ) as EngineMark | undefined;
  return row ?? null;
}

// Monotonic per socket: a write for the socket already on the row only ever
// raises the seq. Two app processes can overlap on one database for a moment
// (a rolling deploy, the old one's last batch landing after the new one's
// first), and the newer process's higher seq must not be lowered by the older
// one's late write. A write naming a different socket always replaces the row:
// the old socket's seqs are of no use beside the new socket.
export function setEngineMark(networkId: number, socket: string, seq: number): void {
  stmt(
    'set',
    `INSERT INTO engine_marks (network_id, socket, seq) VALUES (?, ?, ?)
     ON CONFLICT(network_id) DO UPDATE SET socket = excluded.socket, seq = excluded.seq
     WHERE engine_marks.socket != excluded.socket OR engine_marks.seq < excluded.seq`,
  ).run(networkId, socket, seq);
}
