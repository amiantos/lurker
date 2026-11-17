// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Last write wins by when the text was TYPED. A device that was offline
// delivers its draft late: it must not go over one written elsewhere since, or
// bring back a draft that was cleared (sent) from another device. A write made
// against the current revision always stands, whatever the clocks say.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb } from '../test-utils/testApp.js';

const testDb = setupTestDb('drafts-service');

let service: typeof import('./draftsService.js').default;
let listForUser: typeof import('../db/drafts.js').listForUser;
let userId: number;
let networkId: number;
let n = 0;

beforeAll(async () => {
  const { createUser } = await import('../db/users.js');
  const { createNetwork } = await import('../db/networks.js');
  service = (await import('./draftsService.js')).default;
  ({ listForUser } = await import('../db/drafts.js'));
  userId = createUser('drafts-alice').id;
  networkId = createNetwork(userId, { name: 'n', host: 'h', nick: 'alice' })!.id;
});
afterAll(() => testDb.cleanup());

// A fresh buffer per test, with a draft another device just wrote.
async function buffer(): Promise<{ target: string; rev: number }> {
  const target = `#chan${++n}`;
  (await import('../db/buffers.js')).ensureOpen(userId, networkId, target);
  const first = service.set(userId, networkId, target, 'first', null);
  if (!first.ok) throw new Error('seed write refused');
  return { target, rev: first.rev };
}
const stored = (target: string) => listForUser(userId).find((d) => d.target === target)?.body;
const MINUTE = 60_000;

describe('a draft write and its guard', () => {
  it('stands against the current revision, however old the text', async () => {
    const { target, rev } = await buffer();
    const out = service.set(userId, networkId, target, 'typed offline', null, null, {
      base: rev,
      ageMs: 60 * MINUTE,
    });
    expect(out).toMatchObject({ ok: true });
    expect(stored(target)).toBe('typed offline');
    expect(out.ok && out.rev).not.toBe(rev);
  });

  it('is refused when someone else wrote since and its text is older', async () => {
    const { target, rev } = await buffer();
    const theirs = service.set(userId, networkId, target, 'written elsewhere', null);
    const out = service.set(userId, networkId, target, 'typed offline', null, null, {
      base: rev,
      ageMs: 5 * MINUTE,
    });
    expect(out).toMatchObject({
      ok: false,
      error: 'stale',
      rev: theirs.ok && theirs.rev,
      current: { body: 'written elsewhere' },
    });
    expect(stored(target)).toBe('written elsewhere');
  });

  it('stands when someone else wrote since but its text is newer', async () => {
    const { target, rev } = await buffer();
    // The other device's write arrives late too, typed ten minutes ago.
    service.set(userId, networkId, target, 'older, elsewhere', null, null, { ageMs: 10 * MINUTE });
    const out = service.set(userId, networkId, target, 'newer, here', null, null, {
      base: rev,
      ageMs: MINUTE,
    });
    expect(out).toMatchObject({ ok: true });
    expect(stored(target)).toBe('newer, here');
  });

  it('does not bring back a draft cleared elsewhere since', async () => {
    const { target, rev } = await buffer();
    service.clear(userId, networkId, target);
    const out = service.set(userId, networkId, target, 'first, again', null, null, {
      base: rev,
      ageMs: 5 * MINUTE,
    });
    expect(out).toMatchObject({ ok: false, error: 'stale', current: undefined });
    expect(stored(target)).toBeUndefined();
  });

  it('does not clear a draft written elsewhere since', async () => {
    const { target, rev } = await buffer();
    service.set(userId, networkId, target, 'written elsewhere', null);
    const out = service.clear(userId, networkId, target, null, { base: rev, ageMs: 5 * MINUTE });
    expect(out).toMatchObject({ ok: false, error: 'stale' });
    expect(stored(target)).toBe('written elsewhere');
  });

  it('always takes a write with no guard, as from a client that sends none', async () => {
    const { target } = await buffer();
    service.set(userId, networkId, target, 'written elsewhere', null);
    expect(service.set(userId, networkId, target, 'unguarded', null)).toMatchObject({ ok: true });
    expect(stored(target)).toBe('unguarded');
  });

  it('gives the snapshot each draft’s revision', async () => {
    const { target, rev } = await buffer();
    const entry = (service.snapshotForUser(userId) as { target: string; rev: number }[]).find(
      (d) => d.target === target,
    );
    expect(entry?.rev).toBe(rev);
  });

  it('answers unknown-buffer for a name with no buffer', () => {
    expect(service.set(userId, networkId, '#nowhere', 'x', null)).toEqual({
      ok: false,
      error: 'unknown-buffer',
    });
  });
});
