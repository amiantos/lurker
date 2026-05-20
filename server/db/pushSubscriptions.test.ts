// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-pushsubs-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let createUser: typeof import('./users.js').createUser;
let mod: typeof import('./pushSubscriptions.js');
let alice: ReturnType<typeof import('./users.js').createUser>;
let bob: ReturnType<typeof import('./users.js').createUser>;

beforeAll(async () => {
  ({ createUser } = await import('./users.js'));
  mod = await import('./pushSubscriptions.js');
  alice = createUser('ps-alice');
  bob = createUser('ps-bob');
});

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('upsertSubscription', () => {
  it('inserts a new subscription and surfaces it via listAllForUser', () => {
    const out = mod.upsertSubscription(alice.id, {
      endpoint: 'https://example.test/a', p256dh: 'k1', auth: 'a1', userAgent: 'UA',
    });
    expect(out.ok).toBe(true);
    expect((out as Extract<typeof out, { ok: true }>).sub!.endpoint).toBe('https://example.test/a');
    expect(mod.listAllForUser(alice.id)).toHaveLength(1);
  });

  it('refuses to rebind a foreign-owned endpoint', () => {
    const conflict = mod.upsertSubscription(bob.id, {
      endpoint: 'https://example.test/a', p256dh: 'k2', auth: 'a2',
    });
    expect(conflict.ok).toBe(false);
    expect((conflict as Extract<typeof conflict, { ok: false }>).error).toBe('endpoint_owned_by_other_user');
  });

  it('updates p256dh/auth for the same owner', () => {
    const out = mod.upsertSubscription(alice.id, {
      endpoint: 'https://example.test/a', p256dh: 'k1-new', auth: 'a1-new', userAgent: null,
    });
    expect(out.ok).toBe(true);
    const sub = mod.getByEndpoint('https://example.test/a');
    expect(sub!.p256dh).toBe('k1-new');
    expect(sub!.auth).toBe('a1-new');
  });
});

describe('heartbeatByEndpoint', () => {
  it('returns false for foreign or missing endpoints', () => {
    expect(mod.heartbeatByEndpoint(bob.id, 'https://example.test/a')).toBe(false);
    expect(mod.heartbeatByEndpoint(alice.id, 'https://example.test/missing')).toBe(false);
  });

  it('returns true when the row exists and is owned', () => {
    expect(mod.heartbeatByEndpoint(alice.id, 'https://example.test/a')).toBe(true);
  });
});

describe('deleteByEndpoint / deleteById', () => {
  it('deleteByEndpoint scopes to the user', () => {
    mod.deleteByEndpoint(bob.id, 'https://example.test/a');
    expect(mod.getByEndpoint('https://example.test/a')).not.toBeNull();
    mod.deleteByEndpoint(alice.id, 'https://example.test/a');
    expect(mod.getByEndpoint('https://example.test/a')).toBeNull();
  });
});

describe('listEnabledForUser', () => {
  it('filters by enabled=1', async () => {
    const db = (await import('./index.js')).default;
    mod.upsertSubscription(alice.id, {
      endpoint: 'https://example.test/on', p256dh: 'k', auth: 'a',
    });
    const off = mod.upsertSubscription(alice.id, {
      endpoint: 'https://example.test/off', p256dh: 'k', auth: 'a',
    });
    db.prepare('UPDATE push_subscriptions SET enabled = 0 WHERE id = ?').run(
      (off as Extract<typeof off, { ok: true }>).sub!.id,
    );
    const enabled = mod.listEnabledForUser(alice.id);
    expect(enabled.find((s) => s.endpoint === 'https://example.test/on')).toBeTruthy();
    expect(enabled.find((s) => s.endpoint === 'https://example.test/off')).toBeFalsy();
  });
});

describe('app_meta', () => {
  it('getMeta / setMeta round-trip', () => {
    expect(mod.getMeta('vapid_public')).toBeNull();
    mod.setMeta('vapid_public', 'abc123');
    expect(mod.getMeta('vapid_public')).toBe('abc123');
    mod.setMeta('vapid_public', 'updated');
    expect(mod.getMeta('vapid_public')).toBe('updated');
  });
});
