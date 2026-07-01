// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type BetterSqlite3 from 'better-sqlite3';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let db: BetterSqlite3.Database;
let createUser: typeof import('./users.js').createUser;
let createNetwork: typeof import('./networks.js').createNetwork;
let listRules: typeof import('./ignoredMasks.js').listRules;
let foldMutedIntoIgnoreRules: typeof import('./migrateMutedFold.js').foldMutedIntoIgnoreRules;

beforeAll(async () => {
  db = (await import('./index.js')).default;
  ({ createUser } = await import('./users.js'));
  ({ createNetwork } = await import('./networks.js'));
  ({ listRules } = await import('./ignoredMasks.js'));
  ({ foldMutedIntoIgnoreRules } = await import('./migrateMutedFold.js'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function mkNetwork(userId: number, name: string) {
  return createNetwork(userId, {
    name,
    host: 'irc.libera.chat',
    port: 6697,
    tls: true,
    nick: name,
  });
}

function setRawMuted(userId: number, networkId: number, target: string, notifyAlways: number) {
  db.prepare(
    `INSERT INTO channel_notify_settings (user_id, network_id, target, notify_always, muted, updated_at)
     VALUES (?, ?, ?, ?, 1, datetime('now'))`,
  ).run(userId, networkId, target, notifyAlways);
}

function mutedFlag(userId: number, networkId: number, target: string): number | undefined {
  return (
    db
      .prepare(
        `SELECT muted FROM channel_notify_settings WHERE user_id=? AND network_id=? AND target=?`,
      )
      .get(userId, networkId, target) as { muted: number } | undefined
  )?.muted;
}

describe('foldMutedIntoIgnoreRules (issue #359 migration)', () => {
  it('converts a muted channel into a NOUNREAD+NONOTIFY ignore rule and drops the row', () => {
    const u = createUser('mig-alice');
    const net = mkNetwork(u.id, 'libera')!;
    setRawMuted(u.id, net.id, '#Radio', 0); // mixed case, notify_always off

    const converted = foldMutedIntoIgnoreRules(db);
    expect(converted).toBeGreaterThanOrEqual(1);

    const rules = listRules({ userId: u.id, networkId: net.id });
    const muteRule = rules.find((r) => r.channels?.[0] === '#radio');
    expect(muteRule).toBeTruthy();
    expect(muteRule!.mask).toBeNull();
    expect(muteRule!.isExcept).toBe(false);
    expect([...muteRule!.levels].sort()).toEqual(['NONOTIFY', 'NOUNREAD']);
    // notify_always was off, so the now-empty settings row is gone entirely.
    expect(mutedFlag(u.id, net.id, '#Radio')).toBeUndefined();
  });

  it('preserves notify_always: clears muted, keeps the row, creates NO suppressor rule', () => {
    const u = createUser('mig-bob');
    const net = mkNetwork(u.id, 'libera')!;
    setRawMuted(u.id, net.id, '#keep', 1); // notify_always on

    foldMutedIntoIgnoreRules(db);
    expect(mutedFlag(u.id, net.id, '#keep')).toBe(0); // row kept, muted cleared
    // notify_always is the explicit opt-in to push; muting it would contradict it,
    // so no NONOTIFY/NOUNREAD rule is created for this channel.
    const muteRule = listRules({ userId: u.id, networkId: net.id }).find(
      (r) => r.channels?.[0] === '#keep',
    );
    expect(muteRule).toBeUndefined();
  });

  it('is idempotent — a second run finds nothing and adds no duplicate rule', () => {
    const u = createUser('mig-carol');
    const net = mkNetwork(u.id, 'libera')!;
    setRawMuted(u.id, net.id, '#once', 0);

    expect(foldMutedIntoIgnoreRules(db)).toBeGreaterThanOrEqual(1);
    expect(foldMutedIntoIgnoreRules(db)).toBe(0); // nothing left to convert
    const ruleCount = listRules({ userId: u.id, networkId: net.id }).filter(
      (r) => r.channels?.[0] === '#once',
    ).length;
    expect(ruleCount).toBe(1);
  });
});
