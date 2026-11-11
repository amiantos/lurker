// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The search process: a child of the server that runs one search statement at
// a time on its own read-only connection (services/searchRunner.ts starts it
// and says why it is a process). It knows nothing about users or scopes: the
// server builds the statement, with the caller's own networks in it, and maps
// the rows. Keep this file free of the app's modules — it must start in
// milliseconds, since it is killed and started again whenever a search is
// abandoned mid-walk.

import Database from 'better-sqlite3';

interface Query {
  id: number;
  sql: string;
  params: Array<string | number>;
}

const file = process.argv[2];
if (!file || !process.send) {
  console.error('[search] searchProcess is started by the server, with the database path');
  process.exit(2);
}
// A reply the server is no longer there to read ends the process, quietly:
// without the callback a failed write is an unhandled 'error' and a stack
// trace in the log of a server that is shutting down.
const send = (reply: unknown) =>
  process.send!(reply, (err: Error | null) => {
    if (err) process.exit(0);
  });

const db = new Database(file, { readonly: true, fileMustExist: true });
// A checkpoint or a migration can hold the file for a moment.
db.pragma('busy_timeout = 5000');

process.on('message', (query: Query) => {
  try {
    send({ id: query.id, rows: db.prepare(query.sql).all(...query.params) });
  } catch (err) {
    send({ id: query.id, error: err instanceof Error ? err.message : String(err) });
  }
});
// The server is gone: nothing is left to answer.
process.on('disconnect', () => process.exit(0));
