// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-bufreads-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let createUser: typeof import('./users.js').createUser;
let createNetwork: typeof import('./networks.js').createNetwork;
let bufferReads: typeof import('./bufferReads.js');
let user: ReturnType<typeof import('./users.js').createUser>;
let net: ReturnType<typeof import('./networks.js').createNetwork>;

beforeAll(async () => {
  ({ createUser } = await import('./users.js'));
  ({ createNetwork } = await import('./networks.js'));
  bufferReads = await import('./bufferReads.js');
  user = createUser('br-alice');
  net = createNetwork(user.id, { name: 'libera', host: 'h', port: 6697, tls: true, nick: 'a' });
});

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('setReadState / getReadState', () => {
  it('returns 0 when no row exists', () => {
    expect(bufferReads.getReadState(user.id, net!.id, '#empty')).toBe(0);
  });

  it('round-trips and returns the persisted value', () => {
    const out = bufferReads.setReadState(user.id, net!.id, '#x', 42);
    expect(out).toBe(42);
    expect(bufferReads.getReadState(user.id, net!.id, '#x')).toBe(42);
  });

  it("clamps to MAX(existing, requested) so older reads can't move the pointer back", () => {
    bufferReads.setReadState(user.id, net!.id, '#mono', 100);
    const out = bufferReads.setReadState(user.id, net!.id, '#mono', 50);
    expect(out).toBe(100);
    expect(bufferReads.getReadState(user.id, net!.id, '#mono')).toBe(100);
  });

  it('treats non-positive or non-finite ids as no-ops', () => {
    bufferReads.setReadState(user.id, net!.id, '#bad', 10);
    expect(bufferReads.setReadState(user.id, net!.id, '#bad', 0)).toBe(10);
    expect(bufferReads.setReadState(user.id, net!.id, '#bad', -5)).toBe(10);
    expect(bufferReads.setReadState(user.id, net!.id, '#bad', NaN)).toBe(10);
  });
});

describe('system buffer read pointer (null network_id, #355)', () => {
  it('round-trips and clamps with a NULL network_id', () => {
    expect(bufferReads.getReadState(user.id, null, ':system:')).toBe(0);
    expect(bufferReads.setReadState(user.id, null, ':system:', 30)).toBe(30);
    expect(bufferReads.getReadState(user.id, null, ':system:')).toBe(30);
    // Clamp: an older read can't move the pointer back.
    expect(bufferReads.setReadState(user.id, null, ':system:', 10)).toBe(30);
  });

  it('upserts a single row rather than duplicating (coalesced unique index)', async () => {
    const u = createUser('br-sys-dedupe');
    bufferReads.setReadState(u.id, null, ':system:', 5);
    bufferReads.setReadState(u.id, null, ':system:', 9);
    const db = (await import('./index.js')).default;
    const row = db
      .prepare(
        "SELECT COUNT(*) AS n FROM buffer_reads WHERE user_id = ? AND network_id IS NULL AND target = ':system:'",
      )
      .get(u.id) as { n: number };
    expect(row.n).toBe(1);
    expect(bufferReads.getReadState(u.id, null, ':system:')).toBe(9);
  });

  it('is independent of a network buffer with the same target name', () => {
    const u = createUser('br-sys-iso');
    const n = createNetwork(u.id, { name: 'lib', host: 'h', port: 6697, tls: true, nick: 'a' });
    bufferReads.setReadState(u.id, null, ':system:', 100);
    bufferReads.setReadState(u.id, n!.id, ':system:', 7);
    expect(bufferReads.getReadState(u.id, null, ':system:')).toBe(100);
    expect(bufferReads.getReadState(u.id, n!.id, ':system:')).toBe(7);
  });
});

describe('listReadStateForUser', () => {
  it('returns a map keyed by network::target', () => {
    bufferReads.setReadState(user.id, net!.id, '#a', 7);
    bufferReads.setReadState(user.id, net!.id, '#b', 9);
    const map = bufferReads.listReadStateForUser(user.id);
    expect(map[`${net!.id}::#a`]).toBe(7);
    expect(map[`${net!.id}::#b`]).toBe(9);
  });
});

describe('setClearedState / getClearedState', () => {
  it('returns the no-clear state when no row exists', () => {
    const state = bufferReads.getClearedState(user.id, net!.id, '#never-cleared');
    expect(state).toEqual({ clearedBeforeId: 0, clearedAt: null });
  });

  it('persists boundary id and timestamp, and round-trips', () => {
    const ts = '2026-05-26T12:00:00.000Z';
    const out = bufferReads.setClearedState(user.id, net!.id, '#c', 42, ts);
    expect(out).toEqual({ clearedBeforeId: 42, clearedAt: ts });
    expect(bufferReads.getClearedState(user.id, net!.id, '#c')).toEqual({
      clearedBeforeId: 42,
      clearedAt: ts,
    });
  });

  it('does not clobber the read pointer when /clear writes to a row that also tracks read state', () => {
    bufferReads.setReadState(user.id, net!.id, '#mixed', 80);
    bufferReads.setClearedState(user.id, net!.id, '#mixed', 80, '2026-05-26T12:00:00.000Z');
    expect(bufferReads.getReadState(user.id, net!.id, '#mixed')).toBe(80);
    expect(bufferReads.getClearedState(user.id, net!.id, '#mixed').clearedBeforeId).toBe(80);
  });

  it('does not clobber the clear marker when setReadState writes to the same row', () => {
    bufferReads.setClearedState(user.id, net!.id, '#mixed2', 50, '2026-05-26T12:00:00.000Z');
    bufferReads.setReadState(user.id, net!.id, '#mixed2', 90);
    expect(bufferReads.getClearedState(user.id, net!.id, '#mixed2')).toEqual({
      clearedBeforeId: 50,
      clearedAt: '2026-05-26T12:00:00.000Z',
    });
  });

  it('boundary id <= 0 clears the marker (used by /clear off)', () => {
    bufferReads.setClearedState(user.id, net!.id, '#undo', 25, '2026-05-26T12:00:00.000Z');
    const out = bufferReads.setClearedState(user.id, net!.id, '#undo', 0, null);
    expect(out).toEqual({ clearedBeforeId: 0, clearedAt: null });
    expect(bufferReads.getClearedState(user.id, net!.id, '#undo')).toEqual({
      clearedBeforeId: 0,
      clearedAt: null,
    });
  });

  it('overwrites an existing marker when /clear runs again', () => {
    bufferReads.setClearedState(user.id, net!.id, '#again', 10, '2026-05-26T11:00:00.000Z');
    const out = bufferReads.setClearedState(
      user.id,
      net!.id,
      '#again',
      30,
      '2026-05-26T12:00:00.000Z',
    );
    expect(out).toEqual({ clearedBeforeId: 30, clearedAt: '2026-05-26T12:00:00.000Z' });
  });
});

describe('listClearedStateForUser', () => {
  it('returns only buffers with an active clear marker', () => {
    bufferReads.setClearedState(user.id, net!.id, '#has', 100, '2026-05-26T12:00:00.000Z');
    bufferReads.setReadState(user.id, net!.id, '#read-only', 5);
    const map = bufferReads.listClearedStateForUser(user.id);
    expect(map[`${net!.id}::#has`]).toEqual({
      clearedBeforeId: 100,
      clearedAt: '2026-05-26T12:00:00.000Z',
    });
    expect(map[`${net!.id}::#read-only`]).toBeUndefined();
  });

  it('drops a buffer after its clear is undone', () => {
    bufferReads.setClearedState(user.id, net!.id, '#vanish', 7, '2026-05-26T12:00:00.000Z');
    bufferReads.setClearedState(user.id, net!.id, '#vanish', 0, null);
    const map = bufferReads.listClearedStateForUser(user.id);
    expect(map[`${net!.id}::#vanish`]).toBeUndefined();
  });
});
