// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-api-tokens-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let createUser: typeof import('./users.js').createUser;
let deleteUser: typeof import('./users.js').deleteUser;
let createToken: typeof import('./apiTokens.js').createToken;
let findActiveByHash: typeof import('./apiTokens.js').findActiveByHash;
let hashToken: typeof import('./apiTokens.js').hashToken;
let listForUser: typeof import('./apiTokens.js').listForUser;
let revoke: typeof import('./apiTokens.js').revoke;
let touchLastUsed: typeof import('./apiTokens.js').touchLastUsed;

beforeAll(async () => {
  ({ createUser, deleteUser } = await import('./users.js'));
  ({
    createToken,
    findActiveByHash,
    hashToken,
    listForUser,
    revoke,
    touchLastUsed,
  } = await import('./apiTokens.js'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('apiTokens', () => {
  it('createToken returns a raw token that is base64url and findable by hash', () => {
    const u = createUser('tok-alice');
    const created = createToken({ userId: u.id, name: 'desktop', scope: 'read' });
    expect(created.token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(created.scope).toBe('read');
    const row = findActiveByHash(hashToken(created.token));
    expect(row).toMatchObject({ id: created.id, userId: u.id, scope: 'read', name: 'desktop' });
  });

  it('rejects invalid scope and empty name', () => {
    const u = createUser('tok-bob');
    expect(() => createToken({ userId: u.id, name: 'x', scope: 'admin' })).toThrow(/invalid scope/i);
    expect(() => createToken({ userId: u.id, name: '   ', scope: 'read' })).toThrow(/name/i);
  });

  it('listForUser returns metadata only (no token, no hash) newest-first', () => {
    const u = createUser('tok-carol');
    createToken({ userId: u.id, name: 'first', scope: 'read' });
    createToken({ userId: u.id, name: 'second', scope: 'read-write' });
    const list = listForUser(u.id);
    expect(list.map((r) => r.name)).toEqual(['second', 'first']);
    for (const row of list) {
      expect(row).not.toHaveProperty('token');
      expect(row).not.toHaveProperty('token_hash');
      expect(row).not.toHaveProperty('tokenHash');
    }
  });

  it('revoke filters the token from findActiveByHash but keeps the row in listForUser', () => {
    const u = createUser('tok-dave');
    const t = createToken({ userId: u.id, name: 'temp', scope: 'read' });
    expect(findActiveByHash(hashToken(t.token))).not.toBeNull();
    expect(revoke(t.id, u.id)).toBe(true);
    expect(findActiveByHash(hashToken(t.token))).toBeNull();
    // Historical record still shown in admin list with revokedAt populated.
    const list = listForUser(u.id);
    const row = list.find((r) => r.id === t.id);
    expect(row!.revokedAt).not.toBeNull();
  });

  it('revoke is scoped to the owning user (cannot revoke someone else\'s token)', () => {
    const owner = createUser('tok-eve');
    const intruder = createUser('tok-intruder');
    const t = createToken({ userId: owner.id, name: 'ev', scope: 'read' });
    expect(revoke(t.id, intruder.id)).toBe(false);
    expect(findActiveByHash(hashToken(t.token))).not.toBeNull();
  });

  it('touchLastUsed populates last_used_at on first call', () => {
    const u = createUser('tok-frank');
    const t = createToken({ userId: u.id, name: 'cli', scope: 'read' });
    expect(findActiveByHash(hashToken(t.token))!.lastUsedAt).toBeNull();
    touchLastUsed(t.id);
    expect(findActiveByHash(hashToken(t.token))!.lastUsedAt).not.toBeNull();
  });

  it('cascades on user delete', () => {
    const u = createUser('tok-gina');
    const t = createToken({ userId: u.id, name: 'doomed', scope: 'read' });
    expect(findActiveByHash(hashToken(t.token))).not.toBeNull();
    deleteUser(u.id);
    expect(findActiveByHash(hashToken(t.token))).toBeNull();
    expect(listForUser(u.id)).toEqual([]);
  });

  it('two tokens never collide on token_hash (sanity check on randomness)', () => {
    const u = createUser('tok-helen');
    const a = createToken({ userId: u.id, name: 'a', scope: 'read' });
    const b = createToken({ userId: u.id, name: 'b', scope: 'read' });
    expect(a.token).not.toBe(b.token);
    expect(hashToken(a.token)).not.toBe(hashToken(b.token));
  });
});
