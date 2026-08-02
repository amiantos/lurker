// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type DatabaseType from 'better-sqlite3';

// Stand up the real schema in a temp DB (the migrate() in index.ts runs on
// first import), then exercise the extracted fold against it — an integration
// test over the actual tables, not a hand-rolled subset.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-foldcase-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let db: DatabaseType.Database;
let createUser: typeof import('./users.js').createUser;
let createNetwork: typeof import('./networks.js').createNetwork;
let insertMessage: typeof import('./messages.js').insertMessage;
let setReadState: typeof import('./bufferReads.js').setReadState;
let foldBufferCase: typeof import('./foldBufferCase.js').foldBufferCase;
let userId: number;

const T = '2026-06-01T00:00:00.000Z';

beforeAll(async () => {
  db = (await import('./index.js')).default;
  ({ createUser } = await import('./users.js'));
  ({ createNetwork } = await import('./networks.js'));
  ({ insertMessage } = await import('./messages.js'));
  ({ setReadState } = await import('./bufferReads.js'));
  ({ foldBufferCase } = await import('./foldBufferCase.js'));
  // The fold only ever runs against pre-registry DBs (the v9 migration block,
  // or the operator script whose FOLD_VALIDATED_SCHEMA_VERSION gate pins it to
  // exactly v9) — worlds where the legacy channels/closed_buffers tables still
  // exist. The live schema no longer creates them, so recreate them here as
  // the fixture environment the fold operates in.
  db.exec(`
    CREATE TABLE IF NOT EXISTS channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      network_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      joined INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      key TEXT,
      UNIQUE (network_id, name)
    );
    CREATE TABLE IF NOT EXISTS closed_buffers (
      user_id INTEGER NOT NULL,
      network_id INTEGER NOT NULL,
      target TEXT NOT NULL,
      closed_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, network_id, target)
    );
  `);
  userId = createUser('fold-alice').id;
});

// Legacy-table fixture helpers (the modules that wrapped these are gone).
function upsertChannel(networkId: number, name: string, joined: boolean, key?: string): void {
  db.prepare(
    `INSERT INTO channels (network_id, name, joined, key) VALUES (?, ?, ?, ?)
     ON CONFLICT (network_id, name) DO UPDATE SET joined = excluded.joined,
       key = COALESCE(excluded.key, channels.key)`,
  ).run(networkId, name, joined ? 1 : 0, key ?? null);
}
function listChannels(networkId: number): Array<{ name: string; key: string | null }> {
  return db
    .prepare(`SELECT name, key FROM channels WHERE network_id = ? ORDER BY name`)
    .all(networkId) as Array<{ name: string; key: string | null }>;
}

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

function freshNetwork(): number {
  return createNetwork(userId, { name: 'libera', host: 'h', port: 6697, tls: true, nick: 'a' })!.id;
}
function seed(networkId: number, target: string, count: number) {
  for (let i = 0; i < count; i++)
    insertMessage({ networkId, target, time: T, type: 'message', nick: 'x', text: 'hi' });
}
function targetCounts(networkId: number): Record<string, number> {
  const rows = db
    .prepare(`SELECT target, COUNT(*) AS n FROM messages WHERE network_id = ? GROUP BY target`)
    .all(networkId) as { target: string; n: number }[];
  return Object.fromEntries(rows.map((r) => [r.target, r.n]));
}

describe('foldBufferCase', () => {
  it('dry run reports forks without mutating', () => {
    const net = freshNetwork();
    seed(net, '#CoolChan', 3);
    seed(net, '#coolchan', 1); // stray case
    seed(net, 'Bob', 2);
    seed(net, 'bob', 1); // stray-case DM

    const report = foldBufferCase(db, { scope: 'all', dryRun: true });

    expect(report.applied).toBe(false);
    expect(report.rowsAffected.messages).toBeGreaterThan(0);
    // Both forks surface, each folding to the most-messages casing.
    const chan = report.forks.find((f) => f.networkId === net && f.lkey === '#coolchan');
    const dm = report.forks.find((f) => f.networkId === net && f.lkey === 'bob');
    expect(chan?.canonical).toBe('#CoolChan');
    expect(dm?.canonical).toBe('Bob');
    // Nothing was written — both casings still present.
    expect(targetCounts(net)).toEqual({ '#CoolChan': 3, '#coolchan': 1, Bob: 2, bob: 1 });
  });

  it('folds channel and DM forks to the most-messages casing', () => {
    const net = freshNetwork();
    seed(net, '#CoolChan', 3);
    seed(net, '#coolchan', 1);
    seed(net, 'Bob', 2);
    seed(net, 'bob', 1);

    foldBufferCase(db, { scope: 'all' });

    // Channel and DM each collapse onto the majority casing; no stray rows left.
    expect(targetCounts(net)).toEqual({ '#CoolChan': 4, Bob: 3 });
  });

  it('preserves a +k channel key when folding a case-forked channel', () => {
    const net = freshNetwork();
    // '#Secret' is the majority casing (canon); the stray '#secret' variant is
    // the one carrying the key — the merge must carry it onto the canon, not
    // drop it when the stray row is deleted.
    seed(net, '#Secret', 3);
    seed(net, '#secret', 1);
    upsertChannel(net, '#Secret', true); // canon row, no key
    upsertChannel(net, '#secret', true, 'strays-key'); // stray row holds the key

    foldBufferCase(db, { scope: 'all' });

    const chans = listChannels(net);
    expect(chans.map((c) => c.name)).toEqual(['#Secret']); // variant gone
    expect(chans[0].key).toBe('strays-key'); // key survived the merge
  });

  it('channels-only scope leaves DM forks untouched', () => {
    const net = freshNetwork();
    seed(net, '#CoolChan', 2);
    seed(net, '#coolchan', 1);
    seed(net, 'Bob', 2);
    seed(net, 'bob', 1);

    foldBufferCase(db, { scope: 'channels' });

    // The channel folds; the DM casings stay split (v9 behavior).
    expect(targetCounts(net)).toEqual({ '#CoolChan': 3, Bob: 2, bob: 1 });
  });

  it('merges buffer_reads keeping the furthest read pointer', () => {
    const net = freshNetwork();
    seed(net, '#Chan', 2);
    seed(net, '#chan', 1); // stray, lower message count -> not canonical
    setReadState(userId, net, '#Chan', 5);
    setReadState(userId, net, '#chan', 10); // further read pointer on the stray case

    foldBufferCase(db, { scope: 'all' });

    const reads = db
      .prepare(`SELECT target, last_read_message_id AS lr FROM buffer_reads WHERE network_id = ?`)
      .all(net) as { target: string; lr: number }[];
    expect(reads).toHaveLength(1);
    expect(reads[0].target).toBe('#Chan');
    expect(reads[0].lr).toBe(10); // MAX of the two merged pointers
  });

  it('still folds with report:false (the migration path), returning an empty report', () => {
    const net = freshNetwork();
    seed(net, '#CoolChan', 3);
    seed(net, '#coolchan', 1);
    seed(net, 'Bob', 2);
    seed(net, 'bob', 1);

    const report = foldBufferCase(db, { scope: 'all', report: false });

    // The merge still happens; only the human-facing summary is skipped.
    expect(targetCounts(net)).toEqual({ '#CoolChan': 4, Bob: 3 });
    expect(report.forks).toEqual([]);
    expect(report.rowsAffected).toEqual({});
  });

  it('is a no-op on an unforked database (idempotent)', () => {
    const net = freshNetwork();
    seed(net, '#solo', 3);
    seed(net, 'Carol', 2);

    const report = foldBufferCase(db, { scope: 'all' });

    expect(report.forks).toHaveLength(0);
    expect(report.rowsAffected.messages).toBe(0);
    expect(targetCounts(net)).toEqual({ '#solo': 3, Carol: 2 });
  });
});

// The `buffers` registry is the display casing every reader is handed, and the
// backlog query matches `target` EXACTLY. So on a post-registry database the
// fold must land history on the casing `buffers` holds — folding to the
// message-majority casing instead leaves the registry pointing at a name no row
// carries, and the buffer opens blank.
describe('canon defers to the buffers registry', () => {
  function addBufferRow(networkId: number, target: string): void {
    db.prepare(
      `INSERT INTO buffers (user_id, network_id, target, target_folded, kind, state)
       VALUES (?, ?, ?, ?, 'channel', 'open')`,
    ).run(userId, networkId, target, target.toLowerCase());
  }
  /** What the open-buffer path actually runs: exact match on buffers.target. */
  function backlogCount(networkId: number, registryTarget: string): number {
    return (
      db
        .prepare(`SELECT COUNT(*) AS n FROM messages WHERE network_id = ? AND target = ?`)
        .get(networkId, registryTarget) as { n: number }
    ).n;
  }

  it('folds to the registry casing even when the message majority disagrees', () => {
    const net = freshNetwork();
    addBufferRow(net, '#Foo'); // registry says '#Foo'...
    seed(net, '#Foo', 3);
    seed(net, '#foo', 900); // ...but the messages overwhelmingly say '#foo'

    const report = foldBufferCase(db, { scope: 'all' });

    expect(report.forks.find((f) => f.lkey === '#foo')?.canonical).toBe('#Foo');
    expect(targetCounts(net)).toEqual({ '#Foo': 903 });
    // The assertion that matters: the buffer the user opens is not empty.
    expect(backlogCount(net, '#Foo')).toBe(903);
  });

  it('still uses the message majority when no registry row exists', () => {
    // The schema-16 migration folds BEFORE it populates `buffers`, so this path
    // has to keep working exactly as it always did.
    const net = freshNetwork();
    seed(net, '#Bar', 1);
    seed(net, '#bar', 5);

    foldBufferCase(db, { scope: 'all' });

    expect(targetCounts(net)).toEqual({ '#bar': 6 });
  });

  it('carries per-user state onto the registry casing too', () => {
    const net = freshNetwork();
    addBufferRow(net, '#Baz');
    seed(net, '#Baz', 1);
    seed(net, '#baz', 50);
    db.prepare(
      `INSERT INTO user_drafts (user_id, network_id, target, body) VALUES (?, ?, '#baz', 'wip')`,
    ).run(userId, net);

    foldBufferCase(db, { scope: 'all' });

    const draft = db
      .prepare(`SELECT target FROM user_drafts WHERE user_id = ? AND network_id = ?`)
      .get(userId, net) as { target: string } | undefined;
    // Orphaning this under '#baz' would lose the draft — nothing looks it up.
    expect(draft?.target).toBe('#Baz');
  });
});
