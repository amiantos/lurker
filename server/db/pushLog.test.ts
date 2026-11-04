// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The push log's storage (#1272): what a row keeps, who can list what, the
// week-long prune, and that a deleted user takes their rows with them.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb } from '../test-utils/testApp.js';

const ctx = setupTestDb('db-push-log');

let log: typeof import('./pushLog.js');
let users: typeof import('./users.js');
let db: typeof import('./index.js').default;

beforeAll(async () => {
  log = await import('./pushLog.js');
  users = await import('./users.js');
  db = (await import('./index.js')).default;
});

afterAll(() => ctx.cleanup());

beforeEach(() => {
  db.prepare('DELETE FROM push_log').run();
});

const subject = {
  kind: 'highlight',
  networkId: 3,
  networkName: 'Libera',
  target: '#lurker',
  nick: 'alice',
  messageId: 9002,
};

describe('recordPushLog / listPushLogForUser', () => {
  it('keeps what the push was about and what became of it, newest first', () => {
    const u = users.createUser('pushlog-a');
    log.recordPushLog(u.id, { ...subject, outcome: 'suppressed', reason: 'visible_client' });
    log.recordPushLog(u.id, {
      ...subject,
      outcome: 'sent',
      transport: 'webpush',
      device: 'push.lurker.chat',
      status: 201,
    });
    const rows = log.listPushLogForUser(u.id, 10);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      outcome: 'sent',
      transport: 'webpush',
      device: 'push.lurker.chat',
      status: 201,
      reason: null,
    });
    expect(rows[1]).toMatchObject({
      kind: 'highlight',
      network_id: 3,
      network_name: 'Libera',
      target: '#lurker',
      nick: 'alice',
      message_id: 9002,
      outcome: 'suppressed',
      reason: 'visible_client',
      status: null,
    });
    // Never the message text: there is no column for it.
    expect(Object.keys(rows[0])).not.toContain('text');
  });

  it("lists one user's rows only, and honors the limit", () => {
    const a = users.createUser('pushlog-b');
    const b = users.createUser('pushlog-c');
    for (let i = 0; i < 3; i++) {
      log.recordPushLog(a.id, { ...subject, outcome: 'suppressed', reason: 'no_devices' });
    }
    log.recordPushLog(b.id, { ...subject, outcome: 'suppressed', reason: 'no_devices' });
    expect(log.listPushLogForUser(a.id, 10)).toHaveLength(3);
    expect(log.listPushLogForUser(a.id, 2)).toHaveLength(2);
    expect(log.listPushLogForUser(b.id, 10)).toHaveLength(1);
  });
});

describe('paging with before', () => {
  it('serves the rows below a cursor, for one user and for everyone', () => {
    const u = users.createUser('pushlog-h');
    for (let i = 0; i < 5; i++) {
      log.recordPushLog(u.id, { ...subject, outcome: 'suppressed', reason: 'quiet_hours' });
    }
    const top = log.listPushLogForUser(u.id, 2);
    expect(top).toHaveLength(2);
    const next = log.listPushLogForUser(u.id, 2, top[1].id);
    expect(next).toHaveLength(2);
    expect(next[0].id).toBeLessThan(top[1].id);
    const last = log.listPushLogForUser(u.id, 2, next[1].id);
    expect(last).toHaveLength(1);
    expect(log.listPushLogForUser(u.id, 2, last[0].id)).toEqual([]);
    const adminNext = log.listPushLog(2, u.id, top[1].id);
    expect(adminNext.map((r) => r.id)).toEqual(next.map((r) => r.id));
  });
});

describe('listPushLog (admin)', () => {
  it('spans every user with the username joined on, or one user when asked', () => {
    const a = users.createUser('pushlog-d');
    const b = users.createUser('pushlog-e');
    log.recordPushLog(a.id, { ...subject, outcome: 'suppressed', reason: 'quiet_hours' });
    log.recordPushLog(b.id, { ...subject, outcome: 'suppressed', reason: 'manual_away' });
    const all = log.listPushLog(10);
    expect(all.map((r) => r.username).toSorted()).toEqual(['pushlog-d', 'pushlog-e']);
    expect(log.listPushLog(10, b.id)).toMatchObject([{ username: 'pushlog-e' }]);
  });
});

describe('prunePushLog', () => {
  it('drops rows older than a week and keeps the rest', () => {
    const u = users.createUser('pushlog-f');
    const now = new Date('2026-11-04T12:00:00.000Z');
    const eightDays = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000);
    const sixDays = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000);
    log.recordPushLog(u.id, { ...subject, outcome: 'suppressed', reason: 'no_devices' }, eightDays);
    log.recordPushLog(u.id, { ...subject, outcome: 'suppressed', reason: 'no_devices' }, sixDays);
    expect(log.prunePushLog(now)).toBe(1);
    const left = log.listPushLogForUser(u.id, 10);
    expect(left).toHaveLength(1);
    expect(left[0].at).toBe(sixDays.toISOString());
  });
});

describe('a deleted user', () => {
  it('takes their push log with them', () => {
    const u = users.createUser('pushlog-g');
    log.recordPushLog(u.id, { ...subject, outcome: 'suppressed', reason: 'no_devices' });
    expect(users.deleteUser(u.id)).toBe(true);
    expect(log.listPushLogForUser(u.id, 10)).toHaveLength(0);
  });
});
