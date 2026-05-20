// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-users-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let users: typeof import('./users.js');

beforeAll(async () => {
  users = await import('./users.js');
});

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('createUser / findUser', () => {
  it('creates a user with default role=user', async () => {
    const u = users.createUser('plain-user');
    expect(u.username).toBe('plain-user');
    expect(u.role).toBe('user');
    expect(users.findUserById(u.id)).toMatchObject({ username: 'plain-user', role: 'user' });
    expect(users.findUserByUsername('plain-user')!.id).toBe(u.id);
  });

  it('creates a user with role=admin when requested', () => {
    const u = users.createUser('admin-user', { role: 'admin' });
    expect(u.role).toBe('admin');
  });

  it('username uniqueness is enforced by the schema', () => {
    users.createUser('dupe-target');
    expect(() => users.createUser('dupe-target')).toThrow(/UNIQUE constraint failed/);
  });
});

describe('countUsers / countAdmins', () => {
  it('reflects the current population', () => {
    const before = users.countUsers();
    const beforeAdmins = users.countAdmins();
    users.createUser('count-1');
    users.createUser('count-admin', { role: 'admin' });
    expect(users.countUsers()).toBe(before + 2);
    expect(users.countAdmins()).toBe(beforeAdmins + 1);
  });
});

describe('password hashes', () => {
  it('userHasPassword reflects setPasswordHash', () => {
    const u = users.createUser('pwd-test');
    expect(users.userHasPassword(u.id)).toBe(false);
    users.setPasswordHash(u.id, 'scrypt$32768$8$1$xxx$yyy');
    expect(users.userHasPassword(u.id)).toBe(true);
    expect(users.getPasswordHash(u.id)).toMatch(/^scrypt\$/);
    users.setPasswordHash(u.id, null);
    expect(users.userHasPassword(u.id)).toBe(false);
  });
});

describe('listUsers', () => {
  it('orders by id ascending', () => {
    const list = users.listUsers();
    const ids = list.map((u) => u.id);
    const sorted = [...ids].sort((a, b) => a - b);
    expect(ids).toEqual(sorted);
  });
});

describe('deleteUser', () => {
  it('returns true for a real id, false for a phantom', () => {
    const u = users.createUser('delete-me');
    expect(users.deleteUser(u.id)).toBe(true);
    expect(users.findUserById(u.id)).toBeUndefined();
    expect(users.deleteUser(99999)).toBe(false);
  });
});

describe('touchUserLastSeen', () => {
  it('is idempotent within the 60-second throttle window', () => {
    const u = users.createUser('touch-test');
    users.touchUserLastSeen(u.id);
    const firstTouch = users.findUserById(u.id)!.last_seen_at;
    expect(firstTouch).toBeTruthy();
    users.touchUserLastSeen(u.id);
    expect(users.findUserById(u.id)!.last_seen_at).toBe(firstTouch);
  });
});
