// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The messages_fts AFTER UPDATE trigger (messages_au).
//
// The trigger is guarded on `text`/`id` so that a buffer rename — which rewrites
// `messages.target` in bulk and touches neither indexed column — doesn't pay a
// full FTS delete+reinsert per row. These tests pin both halves of that: the
// guard is actually installed (an already-migrated DB has to be upgraded off the
// unguarded v3 definition), and skipping the reindex cannot desync the index.
//
// Two different assertions, because neither alone is enough:
//
//   - Explicit match assertions catch a guard that skips a reindex it needed.
//     This is the one that does the work. Verified against the obvious wrong
//     guard: with `old.text <> new.text`, a row whose text goes NULL keeps
//     matching its old text, and these assertions fail.
//
//   - `integrity-check` catches structural damage to the index. It is NOT a
//     content-agreement check — measured, it returns OK on the `<>` desync
//     above — so it backstops the match assertions rather than replacing them.

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-fts-trigger-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let db: typeof import('./index.js').default;
let createUser: typeof import('./users.js').createUser;
let createNetwork: typeof import('./networks.js').createNetwork;
let insertMessage: typeof import('./messages.js').insertMessage;
let networkId: number;

/** Throws if messages_fts disagrees with the messages table. */
function integrityCheck(): void {
  db.exec(`INSERT INTO messages_fts(messages_fts) VALUES('integrity-check')`);
}

/** Message ids whose text matches `q`, via the FTS index. */
function ftsMatches(q: string): number[] {
  return (
    db
      .prepare(`SELECT rowid FROM messages_fts WHERE messages_fts MATCH ? ORDER BY rowid`)
      .all(q) as Array<{ rowid: number }>
  ).map((r) => r.rowid);
}

function add(target: string, text: string): number {
  return Number(
    insertMessage({
      networkId,
      target,
      time: new Date().toISOString(),
      type: 'message',
      nick: 'alice',
      text,
    }).id,
  );
}

beforeAll(async () => {
  ({ default: db } = await import('./index.js'));
  ({ createUser } = await import('./users.js'));
  ({ createNetwork } = await import('./networks.js'));
  ({ insertMessage } = await import('./messages.js'));
  const user = createUser('fts-trigger-user');
  const network = createNetwork(user.id, {
    name: 'libera',
    host: 'irc.libera.chat',
    nick: 'alice',
  });
  if (!network) throw new Error('fixture: createNetwork returned undefined');
  networkId = network.id;
});

describe('messages_au trigger definition', () => {
  it('is installed with the text/id guard', () => {
    const row = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'messages_au'`)
      .get() as { sql: string } | undefined;
    expect(row?.sql).toBeTruthy();
    // The whole point of the guard — without a WHEN clause the trigger fires on
    // every column update, including a target-only rename.
    expect(row?.sql).toMatch(/WHEN old\.text IS NOT new\.text OR old\.id IS NOT new\.id/);
  });
});

describe('renaming a buffer (target-only update)', () => {
  it('leaves the FTS index consistent and still searchable', () => {
    const a = add('#old', 'renameable haddock');
    const b = add('#old', 'another haddock here');
    const c = add('#other', 'unrelated haddock');

    expect(ftsMatches('renameable')).toEqual([a]);

    db.prepare(`UPDATE messages SET target = ? WHERE network_id = ? AND target = ?`).run(
      '#new',
      networkId,
      '#old',
    );

    // Rows moved...
    const moved = db
      .prepare(`SELECT COUNT(*) AS n FROM messages WHERE network_id = ? AND target = ?`)
      .get(networkId, '#new') as { n: number };
    expect(moved.n).toBe(2);

    // ...and the index the trigger deliberately skipped is still correct.
    integrityCheck();
    expect(ftsMatches('renameable')).toEqual([a]);
    // All three still match, each exactly once — the renamed rows kept their
    // index entries and no duplicate was left behind. Row identity is by id, so
    // the moved rows are found under the new target without being reindexed.
    expect(ftsMatches('haddock')).toEqual([a, b, c]);
  });
});

describe('updates that DO change indexed columns', () => {
  it('reindexes when text changes', () => {
    const id = add('#edit', 'original wobbegong');
    expect(ftsMatches('wobbegong')).toContain(id);

    db.prepare(`UPDATE messages SET text = ? WHERE id = ?`).run('replaced pilchard', id);

    expect(ftsMatches('wobbegong')).not.toContain(id);
    expect(ftsMatches('pilchard')).toContain(id);
    integrityCheck();
  });

  it('reindexes when text becomes NULL and back', () => {
    // `IS NOT` rather than `<>` in the guard exists for exactly this: `NULL <>
    // NULL` is NULL (falsy), so a `<>` guard would skip these transitions and
    // strand the old text in the index.
    const id = add('#edit', 'nullable barramundi');
    expect(ftsMatches('barramundi')).toContain(id);

    db.prepare(`UPDATE messages SET text = NULL WHERE id = ?`).run(id);
    expect(ftsMatches('barramundi')).not.toContain(id);
    integrityCheck();

    db.prepare(`UPDATE messages SET text = ? WHERE id = ?`).run('barramundi returns', id);
    expect(ftsMatches('barramundi')).toContain(id);
    integrityCheck();
  });

  it('still removes index entries on delete', () => {
    const id = add('#gone', 'deletable tilapia');
    expect(ftsMatches('tilapia')).toContain(id);

    db.prepare(`DELETE FROM messages WHERE id = ?`).run(id);

    expect(ftsMatches('tilapia')).not.toContain(id);
    integrityCheck();
  });
});
