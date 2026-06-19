// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { IgnoreRuleInput } from '../db/ignoredMasks.js';
import { evaluateIgnores, type IgnoreInput } from '../../shared/ignoreMatch.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-igsvc-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let createUser: typeof import('../db/users.js').createUser;
let createNetwork: typeof import('../db/networks.js').createNetwork;
let svc: typeof import('./ignoreRulesService.js').default;
let user: ReturnType<typeof import('../db/users.js').createUser>;
let net: ReturnType<typeof import('../db/networks.js').createNetwork>;

function base(overrides: Partial<IgnoreRuleInput> = {}): IgnoreRuleInput {
  return {
    mask: 'bob',
    channels: null,
    pattern: null,
    patternKind: 'substr',
    levels: ['ALL'],
    isExcept: false,
    expiresAt: null,
    ...overrides,
  };
}

beforeAll(async () => {
  ({ createUser } = await import('../db/users.js'));
  ({ createNetwork } = await import('../db/networks.js'));
  svc = (await import('./ignoreRulesService.js')).default;
  user = createUser('igsvc-alice');
  net = createNetwork(user.id, { name: 'libera', host: 'h', port: 6697, tls: true, nick: 'a' })!;
});

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('ignoreRulesService.add validation', () => {
  it('rejects an unparseable expiry (untrusted WS payload hardening)', () => {
    expect(svc.add(user.id, net!.id, base({ expiresAt: 'not-a-date' }))).toMatchObject({
      ok: false,
    });
  });

  it('canonicalizes a valid expiry to ISO before storing', () => {
    const r = svc.add(user.id, net!.id, base({ mask: 'bobby', expiresAt: '2099-01-01T00:00:00Z' }));
    expect(r.ok).toBe(true);
    const stored = svc.list(user.id, net!.id).find((x) => x.mask === 'bobby');
    expect(stored?.expiresAt).toBe('2099-01-01T00:00:00.000Z');
  });

  it('rejects an invalid regex pattern', () => {
    expect(svc.add(user.id, net!.id, base({ pattern: '(', patternKind: 'regex' }))).toMatchObject({
      ok: false,
    });
  });

  it('rejects a rule with no valid levels', () => {
    expect(svc.add(user.id, net!.id, base({ levels: ['bogus'] }))).toMatchObject({ ok: false });
  });
});

describe('ignoreRulesService scoping + cache (#350)', () => {
  const ctxFor = (nick: string): IgnoreInput => ({
    nick,
    userhost: null,
    target: '#x',
    text: '',
    type: 'message',
    isDm: false,
  });

  it('a global rule applies on every network and invalidates already-compiled caches', () => {
    const u = createUser('igsvc-glob');
    const n1 = createNetwork(u.id, { name: 'a', host: 'h', port: 6697, tls: true, nick: 'g' })!;
    const n2 = createNetwork(u.id, { name: 'b', host: 'h2', port: 6697, tls: true, nick: 'g' })!;
    const ctx = ctxFor('globe');
    // Warm n1's cache before the rule exists — proves the global add busts it.
    expect(evaluateIgnores(svc.getCompiled(u.id, n1.id), ctx).hide).toBe(false);

    expect(svc.add(u.id, null, base({ mask: 'globe' })).ok).toBe(true);

    expect(evaluateIgnores(svc.getCompiled(u.id, n1.id), ctx).hide).toBe(true);
    expect(evaluateIgnores(svc.getCompiled(u.id, n2.id), ctx).hide).toBe(true);
  });

  it('a network-scoped rule applies only on that network', () => {
    const u = createUser('igsvc-net');
    const n1 = createNetwork(u.id, { name: 'a', host: 'h', port: 6697, tls: true, nick: 'g' })!;
    const n2 = createNetwork(u.id, { name: 'b', host: 'h2', port: 6697, tls: true, nick: 'g' })!;
    const ctx = ctxFor('localonly');
    expect(svc.add(u.id, n1.id, base({ mask: 'localonly' })).ok).toBe(true);
    expect(evaluateIgnores(svc.getCompiled(u.id, n1.id), ctx).hide).toBe(true);
    expect(evaluateIgnores(svc.getCompiled(u.id, n2.id), ctx).hide).toBe(false);
  });

  it('listGlobal returns only the global rules', () => {
    const u = createUser('igsvc-listglobal');
    const n = createNetwork(u.id, { name: 'a', host: 'h', port: 6697, tls: true, nick: 'g' })!;
    svc.add(u.id, null, base({ mask: 'g1' }));
    svc.add(u.id, n.id, base({ mask: 'netonly' }));
    expect(svc.listGlobal(u.id).map((r) => r.mask)).toEqual(['g1']);
  });

  it('removeByMask at a network scope clears the global and that network’s match', () => {
    const u = createUser('igsvc-rmmask');
    const n = createNetwork(u.id, { name: 'a', host: 'h', port: 6697, tls: true, nick: 'g' })!;
    svc.add(u.id, null, base({ mask: 'dup' }));
    svc.add(u.id, n.id, base({ mask: 'dup' }));
    expect(svc.removeByMask(u.id, n.id, 'dup')).toBe(2);
    expect(svc.listGlobal(u.id)).toHaveLength(0);
    expect(svc.list(u.id, n.id)).toHaveLength(0);
  });
});
