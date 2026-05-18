// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: Elastic-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-sessions-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let sessions;
let createUser;
let db;

beforeAll(async () => {
  sessions = await import('./sessions.js');
  ({ createUser } = await import('./users.js'));
  ({ default: db } = await import('./index.js'));
});

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('createSession / findSession / deleteSession', () => {
  it('round-trips a session token', () => {
    const u = createUser('s-alice');
    const { token, expiresAt } = sessions.createSession(u.id);
    expect(typeof token).toBe('string');
    expect(Date.parse(expiresAt)).toBeGreaterThan(Date.now());
    const row = sessions.findSession(token);
    expect(row).toMatchObject({ user_id: u.id, token });
  });

  it('findSession returns null for unknown tokens', () => {
    expect(sessions.findSession('nope')).toBeNull();
    expect(sessions.findSession('')).toBeNull();
    expect(sessions.findSession(null)).toBeNull();
  });

  it('deleteSession removes the row', () => {
    const u = createUser('s-bob');
    const { token } = sessions.createSession(u.id);
    sessions.deleteSession(token);
    expect(sessions.findSession(token)).toBeNull();
  });

  it('deleteSession is a no-op on missing tokens', () => {
    expect(() => sessions.deleteSession('')).not.toThrow();
    expect(() => sessions.deleteSession(null)).not.toThrow();
  });

  it('findSession lazily deletes expired rows', () => {
    const u = createUser('s-expired');
    const { token } = sessions.createSession(u.id);
    // Force expiry into the past.
    db.prepare(`UPDATE sessions SET expires_at = ? WHERE token = ?`)
      .run(new Date(Date.now() - 60_000).toISOString(), token);
    expect(sessions.findSession(token)).toBeNull();
    // And the row is gone from disk.
    expect(db.prepare(`SELECT 1 FROM sessions WHERE token = ?`).get(token)).toBeUndefined();
  });
});

describe('purgeExpiredSessions', () => {
  it('deletes all expired rows but keeps fresh ones', () => {
    const u = createUser('s-purge');
    const { token: keep } = sessions.createSession(u.id);
    const { token: stale1 } = sessions.createSession(u.id);
    const { token: stale2 } = sessions.createSession(u.id);
    // Use a same-day past ISO timestamp. This is the case the original purge
    // SQL silently mis-handled (lexical compare of ISO 8601 vs SQLite-local
    // format leaves 'T' > ' ' so same-day rows looked "newer" than now).
    // Both formats now round-trip through datetime() in the query.
    db.prepare(`UPDATE sessions SET expires_at = ? WHERE token IN (?, ?)`)
      .run(new Date(Date.now() - 1000).toISOString(), stale1, stale2);
    sessions.purgeExpiredSessions();
    expect(sessions.findSession(keep)).toBeTruthy();
    expect(db.prepare(`SELECT 1 FROM sessions WHERE token = ?`).get(stale1)).toBeUndefined();
    expect(db.prepare(`SELECT 1 FROM sessions WHERE token = ?`).get(stale2)).toBeUndefined();
  });
});

describe('FK cascade', () => {
  it('deleting a user wipes their sessions', () => {
    const u = createUser('s-cascade');
    sessions.createSession(u.id);
    sessions.createSession(u.id);
    db.prepare(`DELETE FROM users WHERE id = ?`).run(u.id);
    const remaining = db.prepare(`SELECT 1 FROM sessions WHERE user_id = ?`).all(u.id);
    expect(remaining).toEqual([]);
  });
});
