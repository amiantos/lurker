// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-webauthn-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let createUser: typeof import('./users.js').createUser;
let mod: typeof import('./webauthnCredentials.js');
let alice: ReturnType<typeof import('./users.js').createUser>;
let bob: ReturnType<typeof import('./users.js').createUser>;

beforeAll(async () => {
  ({ createUser } = await import('./users.js'));
  mod = await import('./webauthnCredentials.js');
  alice = createUser('wa-alice');
  bob = createUser('wa-bob');
});

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

function makeCred(
  userId: number,
  idSuffix = 'a',
  label: string | null = null,
): ReturnType<typeof import('./webauthnCredentials.js').insertCredential> {
  return mod.insertCredential({
    userId,
    credentialId: `cred-${idSuffix}-${userId}`,
    publicKey: Buffer.from([1, 2, 3, 4]),
    counter: 0,
    transports: ['internal'],
    deviceType: 'multiDevice',
    backedUp: true,
    label,
  });
}

describe('insertCredential / listForUser / findByCredentialId', () => {
  it('round-trips a credential row', () => {
    const c = makeCred(alice.id, 'a', 'phone')!;
    expect(c).toMatchObject({
      userId: alice.id, label: 'phone', deviceType: 'multiDevice', backedUp: true,
    });
    expect(c.transports).toEqual(['internal']);
    expect(mod.findByCredentialId(c.credentialId)!.id).toBe(c.id);
  });

  it('listForUser scopes by user id', () => {
    makeCred(bob.id, 'b1');
    makeCred(bob.id, 'b2');
    expect(mod.listForUser(alice.id)).toHaveLength(1);
    expect(mod.listForUser(bob.id)).toHaveLength(2);
  });

  it('credential_id is globally unique (UNIQUE constraint)', () => {
    expect(() => mod.insertCredential({
      userId: alice.id,
      credentialId: `cred-a-${alice.id}`,
      publicKey: Buffer.from([1]),
      counter: 0,
      transports: [],
      deviceType: 'singleDevice',
      backedUp: false,
      label: null,
    })).toThrow(/UNIQUE constraint failed/);
  });
});

describe('countAll / countForUser', () => {
  it('reflect inserts and per-user scoping', () => {
    const before = mod.countAll();
    expect(mod.countForUser(bob.id)).toBe(2);
    makeCred(bob.id, 'b3');
    expect(mod.countAll()).toBe(before + 1);
    expect(mod.countForUser(bob.id)).toBe(3);
  });
});

describe('updateCounter / updateLabel / deleteById', () => {
  it('updateCounter bumps the counter and last_used_at', () => {
    const c = makeCred(alice.id, 'a2')!;
    mod.updateCounter(c.id, 5);
    expect(mod.findByCredentialId(c.credentialId)!.counter).toBe(5);
  });

  it('updateLabel scopes to the owner', () => {
    const c = makeCred(alice.id, 'a3', 'old')!;
    expect(mod.updateLabel(c.id, alice.id, 'new')).toBe(true);
    expect(mod.findByCredentialId(c.credentialId)!.label).toBe('new');
    // Wrong user — no change.
    expect(mod.updateLabel(c.id, bob.id, 'hacked')).toBe(false);
    expect(mod.findByCredentialId(c.credentialId)!.label).toBe('new');
  });

  it('deleteById is owner-scoped too', () => {
    const c = makeCred(alice.id, 'a4')!;
    expect(mod.deleteById(c.id, bob.id)).toBe(false);
    expect(mod.findByCredentialId(c.credentialId)).not.toBeNull();
    expect(mod.deleteById(c.id, alice.id)).toBe(true);
    expect(mod.findByCredentialId(c.credentialId)).toBeNull();
  });
});
