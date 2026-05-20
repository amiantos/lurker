// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { User } from '../db/users.js';
import type { Network } from '../db/networks.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-verb-registry-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let createUser: typeof import('../db/users.js').createUser;
let createNetwork: typeof import('../db/networks.js').createNetwork;
let registerVerb: typeof import('./verbRegistry.js').registerVerb;
let callVerb: typeof import('./verbRegistry.js').callVerb;
let listVerbs: typeof import('./verbRegistry.js').listVerbs;
let getVerb: typeof import('./verbRegistry.js').getVerb;
let __resetForTests: typeof import('./verbRegistry.js').__resetForTests;

beforeAll(async () => {
  ({ createUser } = await import('../db/users.js'));
  ({ createNetwork } = await import('../db/networks.js'));
  ({ registerVerb, callVerb, listVerbs, getVerb, __resetForTests } =
    await import('./verbRegistry.js'));
});

beforeEach(() => {
  __resetForTests();
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('verbRegistry', () => {
  it('registerVerb + getVerb round-trips', () => {
    registerVerb({
      name: 'noop',
      description: 'does nothing',
      scope: 'read',
      input: { type: 'object' },
      handler: () => 'ok',
    });
    expect(getVerb('noop')!.description).toBe('does nothing');
  });

  it('registerVerb rejects duplicates, invalid scope, missing handler', () => {
    registerVerb({ name: 'dup', scope: 'read', handler: () => null });
    expect(() => registerVerb({ name: 'dup', scope: 'read', handler: () => null })).toThrow(/duplicate verb/);
    expect(() => registerVerb({ name: 'bad', scope: 'admin', handler: () => null })).toThrow(/invalid scope/);
    expect(() => registerVerb({ name: 'no-handler', scope: 'read' } as Parameters<typeof registerVerb>[0])).toThrow(/handler required/);
  });

  it('callVerb throws unknown_verb when the name is not registered', () => {
    let caughtErr: unknown;
    try {
      callVerb('ghost', { userId: 1, scope: 'read', transport: 'ws' }, {});
    } catch (err) {
      caughtErr = err;
    }
    expect((caughtErr as { code?: string }).code).toBe('unknown_verb');
  });

  it('callVerb enforces scope: read-write verbs reject read scope', () => {
    registerVerb({
      name: 'mutate',
      scope: 'read-write',
      handler: () => 'wrote',
    });
    expect(() => callVerb('mutate', { userId: 1, scope: 'read', transport: 'ws' }, {})).toThrow(/scope insufficient/);
    expect(callVerb('mutate', { userId: 1, scope: 'read-write', transport: 'ws' }, {})).toBe('wrote');
  });

  it('callVerb rejects unknown networkId at the boundary (other-user ownership leak)', () => {
    const owner = createUser('vr-owner') as User;
    const intruder = createUser('vr-intruder') as User;
    const net = createNetwork(owner.id, {
      name: 'libera', host: 'h', port: 6697, tls: true, nick: 'o',
    }) as Network;
    registerVerb({
      name: 'read-net',
      scope: 'read',
      handler: (_ctx, input) => ({ saw: input.networkId }),
    });
    // Owner can call against their own network.
    expect(callVerb('read-net', { userId: owner.id, scope: 'read', transport: 'ws' }, { networkId: net.id }))
      .toEqual({ saw: net.id });
    // Intruder cannot.
    let caughtErr: unknown;
    try {
      callVerb('read-net', { userId: intruder.id, scope: 'read', transport: 'ws' }, { networkId: net.id });
    } catch (err) {
      caughtErr = err;
    }
    expect((caughtErr as { code?: string }).code).toBe('unknown_network');
  });

  it('listVerbs filters read-write verbs from a read-only caller', () => {
    registerVerb({ name: 'r', description: 'r', scope: 'read', handler: () => null });
    registerVerb({ name: 'w', description: 'w', scope: 'read-write', handler: () => null });
    const readSet = listVerbs('read').map((v) => v.name);
    const rwSet = listVerbs('read-write').map((v) => v.name);
    expect(readSet).toEqual(['r']);
    expect(rwSet.sort()).toEqual(['r', 'w']);
  });

  it('listVerbs entries carry the inputSchema declared at registration', () => {
    const schema = { type: 'object', properties: { x: { type: 'integer' } } };
    registerVerb({ name: 'sch', description: 'with schema', scope: 'read', input: schema, handler: () => null });
    const entry = listVerbs('read').find((v) => v.name === 'sch');
    expect(entry!.inputSchema).toEqual(schema);
  });

  it('callVerb rejects missing required fields declared in the input schema', () => {
    registerVerb({
      name: 'req-net',
      scope: 'read',
      input: { type: 'object', properties: { networkId: { type: 'integer' } }, required: ['networkId'] },
      handler: () => 'should-not-run',
    });
    let caughtErr: unknown;
    try {
      callVerb('req-net', { userId: 1, scope: 'read', transport: 'ws' }, {});
    } catch (err) {
      caughtErr = err;
    }
    expect((caughtErr as { code?: string }).code).toBe('invalid_input');
    expect((caughtErr as Error).message).toMatch(/networkId/);
  });

  it('the required-field check fires before the ownership check (so missing networkId is invalid_input, not unknown_network)', () => {
    // Reproduces Copilot review comment: omitting networkId entirely used to
    // bypass the ownership branch and let the handler see NaN. Now the
    // registry rejects it cleanly with a distinguishable error code.
    registerVerb({
      name: 'needs-net',
      scope: 'read',
      input: { type: 'object', properties: { networkId: { type: 'integer' } }, required: ['networkId'] },
      handler: () => 'never',
    });
    let caughtErr: unknown;
    try {
      callVerb('needs-net', { userId: 1, scope: 'read', transport: 'ws' }, { somethingElse: 'x' });
    } catch (err) {
      caughtErr = err;
    }
    expect((caughtErr as { code?: string }).code).toBe('invalid_input');
  });
});
