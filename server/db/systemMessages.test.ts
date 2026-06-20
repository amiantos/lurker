// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Throwaway DB before importing the layer (db/index.js reads DATABASE_PATH at
// module-load time). Mirrors drafts.test.ts.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let createUser: typeof import('./users.js').createUser;
let deleteUser: typeof import('./users.js').deleteUser;
let systemMessages: typeof import('./systemMessages.js').default;

beforeAll(async () => {
  ({ createUser, deleteUser } = await import('./users.js'));
  systemMessages = (await import('./systemMessages.js')).default;
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function line(over: Partial<Parameters<typeof systemMessages.insert>[0]> = {}) {
  return systemMessages.insert({
    ts: new Date().toISOString(),
    level: 'info',
    scope: 'lurker',
    source: 'server',
    text: 'hi',
    ...over,
  });
}

describe('systemMessages', () => {
  it('insert returns the row with an autoincrement id', () => {
    const row = line({ text: 'first' });
    expect(row.id).toBeGreaterThan(0);
    expect(row.text).toBe('first');
    expect(row.userId).toBeNull();
  });

  it('recent merges global + the user own lines in ascending id order', () => {
    const u = createUser('sys-alice');
    const other = createUser('sys-otto');
    const g = line({ text: 'global', userId: null });
    const mine = line({ text: 'mine', userId: u.id });
    line({ text: 'theirs', userId: other.id });

    const rows = systemMessages.recent(u.id);
    const texts = rows.map((r) => r.text);
    expect(texts).toContain('global');
    expect(texts).toContain('mine');
    // Another user's per-user line must not leak.
    expect(texts).not.toContain('theirs');
    // Ascending id ordering.
    const ids = rows.map((r) => r.id);
    expect(ids).toEqual(ids.toSorted((a, b) => a - b));
    expect(rows.find((r) => r.text === 'global')!.id).toBe(g.id);
    expect(rows.find((r) => r.text === 'mine')!.id).toBe(mine.id);
  });

  it('round-trips a JSON fields blob', () => {
    const u = createUser('sys-fields');
    line({ userId: u.id, fields: { nick: 'bob', count: 3 } });
    const row = systemMessages.recent(u.id).at(-1)!;
    expect(row.fields).toEqual({ nick: 'bob', count: 3 });
  });

  it('prunes a user ring beyond the per-user cap', () => {
    const u = createUser('sys-floody');
    for (let i = 0; i < 520; i++) line({ userId: u.id, text: `m${i}` });
    const mine = systemMessages.recent(u.id).filter((r) => r.userId === u.id);
    // Capped at 500; the newest survive, the oldest are pruned.
    expect(mine.length).toBe(500);
    expect(mine.some((r) => r.text === 'm519')).toBe(true);
    expect(mine.some((r) => r.text === 'm0')).toBe(false);
  });

  it('dropUser forgets only that user lines', () => {
    const u = createUser('sys-drop');
    line({ text: 'keepme-global', userId: null });
    line({ userId: u.id, text: 'dropme' });
    expect(systemMessages.recent(u.id).some((r) => r.text === 'dropme')).toBe(true);
    systemMessages.dropUser(u.id);
    const after = systemMessages.recent(u.id);
    expect(after.some((r) => r.text === 'dropme')).toBe(false);
    // Global lines are untouched.
    expect(after.some((r) => r.text === 'keepme-global')).toBe(true);
  });

  it('cascades per-user rows on account deletion', () => {
    const u = createUser('sys-cascade');
    line({ userId: u.id, text: 'cascade-me' });
    deleteUser(u.id);
    expect(systemMessages.recent(u.id).some((r) => r.text === 'cascade-me')).toBe(false);
  });
});

describe('countNotableNewer (unread classification, #355)', () => {
  it('counts admin/control-plane + warn/error, not routine info, newer than the pointer', () => {
    const u = createUser('sys-unread');
    const base = line({ userId: u.id, text: 'baseline' }).id; // pointer starts here
    line({ userId: u.id, text: 'routine join', level: 'info', source: 'server' }); // not notable
    line({ userId: u.id, text: 'a warning', level: 'warn', source: 'server' }); // notable
    line({ text: 'admin notice', level: 'info', source: 'admin' }); // notable, global
    line({ userId: u.id, text: 'an error', level: 'error', source: 'server' }); // notable

    expect(systemMessages.countNotableNewer(u.id, base)).toBe(3);
    // After reading everything, zero.
    const top = systemMessages.recent(u.id).at(-1)!.id;
    expect(systemMessages.countNotableNewer(u.id, top)).toBe(0);
  });

  it("doesn't count another user's per-user notable lines, but does count globals", () => {
    const u = createUser('sys-unread-a');
    const other = createUser('sys-unread-b');
    const before = systemMessages.countNotableNewer(u.id, 0);
    line({ userId: other.id, text: 'their error', level: 'error' }); // per-user to `other`
    expect(systemMessages.countNotableNewer(u.id, 0)).toBe(before); // doesn't leak
    line({ text: 'global error', level: 'error' }); // global (userId null)
    expect(systemMessages.countNotableNewer(u.id, 0)).toBe(before + 1);
  });
});
