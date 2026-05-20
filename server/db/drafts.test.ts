// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Point the DB layer at a throwaway file before importing anything that
// touches it. db/index.js reads DATABASE_PATH at module-load time, so this
// must happen before the dynamic imports below.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let createUser: typeof import('./users.js').createUser;
let deleteUser: typeof import('./users.js').deleteUser;
let createNetwork: typeof import('./networks.js').createNetwork;
let upsertDraft: typeof import('./drafts.js').upsertDraft;
let clearDraft: typeof import('./drafts.js').clearDraft;
let listForUser: typeof import('./drafts.js').listForUser;

beforeAll(async () => {
  ({ createUser, deleteUser } = await import('./users.js'));
  ({ createNetwork } = await import('./networks.js'));
  ({ upsertDraft, clearDraft, listForUser } = await import('./drafts.js'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function mkNetwork(userId: number, name: string) {
  return createNetwork(userId, {
    name, host: 'irc.libera.chat', port: 6697, tls: true, nick: name,
  });
}

describe('drafts', () => {
  it('upserts and lists a draft', () => {
    const u = createUser('drafts-alice');
    const net = mkNetwork(u.id, 'libera');
    upsertDraft(u.id, net!.id, '#meta', 'hello there');
    const rows = listForUser(u.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      networkId: net!.id, target: '#meta', body: 'hello there',
    });
    expect(rows[0].updatedAt).toBeTruthy();
  });

  it('updates body in place on re-upsert', () => {
    const u = createUser('drafts-bob');
    const net = mkNetwork(u.id, 'libera');
    upsertDraft(u.id, net!.id, '#meta', 'first');
    upsertDraft(u.id, net!.id, '#meta', 'second');
    const rows = listForUser(u.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toBe('second');
  });

  it('clearDraft drops one row without disturbing siblings', () => {
    const u = createUser('drafts-carol');
    const net = mkNetwork(u.id, 'libera');
    upsertDraft(u.id, net!.id, '#a', 'A');
    upsertDraft(u.id, net!.id, '#b', 'B');
    clearDraft(u.id, net!.id, '#a');
    const rows = listForUser(u.id);
    expect(rows.map((r) => r.target)).toEqual(['#b']);
  });

  it('cascades on user deletion', () => {
    const u = createUser('drafts-dave');
    const net = mkNetwork(u.id, 'libera');
    upsertDraft(u.id, net!.id, '#meta', 'hi');
    expect(listForUser(u.id)).toHaveLength(1);
    deleteUser(u.id);
    expect(listForUser(u.id)).toEqual([]);
  });

  it('returns an empty array for a user with no drafts', () => {
    const u = createUser('drafts-eve');
    expect(listForUser(u.id)).toEqual([]);
  });
});
