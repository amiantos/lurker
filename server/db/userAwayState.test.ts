// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-away-state-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let createUser: typeof import('./users.js').createUser;
let mod: typeof import('./userAwayState.js');
let user: ReturnType<typeof import('./users.js').createUser>;

beforeAll(async () => {
  ({ createUser } = await import('./users.js'));
  mod = await import('./userAwayState.js');
  user = createUser('away-alice');
});

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('writeAwayMarker / getUserAwayState', () => {
  it('round-trips the away cycle', () => {
    expect(mod.getUserAwayState(user.id)).toBeNull();
    mod.writeAwayMarker(user.id, {
      awayDatetime: '2026-05-17T10:00:00Z',
      awayMessage: 'lunch',
      autoSet: false,
    });
    expect(mod.getUserAwayState(user.id)).toMatchObject({
      away_datetime: '2026-05-17T10:00:00Z',
      back_datetime: null,
      away_message: 'lunch',
      auto_set: 0,
    });
  });

  it('a new /away clears any prior back_datetime', () => {
    mod.writeBackMarker(user.id, '2026-05-17T11:00:00Z');
    expect(mod.getUserAwayState(user.id)!.back_datetime).toBe('2026-05-17T11:00:00Z');
    mod.writeAwayMarker(user.id, {
      awayDatetime: '2026-05-17T12:00:00Z',
      awayMessage: 'second',
      autoSet: true,
    });
    expect(mod.getUserAwayState(user.id)).toMatchObject({
      away_datetime: '2026-05-17T12:00:00Z',
      back_datetime: null,
      auto_set: 1,
    });
  });
});

describe('writeBackMarker', () => {
  it('only fills in back_datetime, leaving the rest of the cycle', () => {
    mod.writeBackMarker(user.id, '2026-05-17T13:00:00Z');
    expect(mod.getUserAwayState(user.id)).toMatchObject({
      away_datetime: '2026-05-17T12:00:00Z',
      back_datetime: '2026-05-17T13:00:00Z',
      away_message: 'second',
      auto_set: 1,
    });
  });
});
