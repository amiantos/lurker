// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { User } from '../db/users.js';
import type { Network } from '../db/networks.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-hl-rules-service-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let highlightRulesService: typeof import('./highlightRulesService.js').default;
let createUser: typeof import('../db/users.js').createUser;
let createNetwork: typeof import('../db/networks.js').createNetwork;
let user: User;
let net: Network;

beforeAll(async () => {
  ({ createUser } = await import('../db/users.js'));
  ({ createNetwork } = await import('../db/networks.js'));
  highlightRulesService = (await import('./highlightRulesService.js')).default;
  user = createUser('hrs-alice');
  net = createNetwork(user.id, { name: 'libera', host: 'h', port: 6697, tls: true, nick: 'a' }) as Network;
});

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('create', () => {
  it('validates pattern presence + length', () => {
    expect(highlightRulesService.create(user.id, { pattern: '' }).ok).toBe(false);
    expect(highlightRulesService.create(user.id, { pattern: 'x'.repeat(300) }).ok).toBe(false);
    expect(highlightRulesService.create(user.id, { pattern: 'review' }).ok).toBe(true);
  });

  it('validates kind', () => {
    const res = highlightRulesService.create(user.id, { pattern: 'x', kind: 'fuzzy' });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toMatch(/plain, glob, or regex/);
  });

  it('rejects an invalid regex up front', () => {
    const res = highlightRulesService.create(user.id, { pattern: '[bad', kind: 'regex' });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toMatch(/invalid regex/);
  });
});

describe('update', () => {
  it('404s on unknown rules', () => {
    const res = highlightRulesService.update(999999, user.id, { enabled: false });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.status).toBe(404);
  });

  it('refuses to edit pattern/kind/case_sensitive on an auto-managed rule', () => {
    const auto = highlightRulesService.upsertAutoNickRule(user.id, net.id, 'alice')!;
    expect(highlightRulesService.update(auto.id, user.id, { pattern: 'new' }).ok).toBe(false);
    expect(highlightRulesService.update(auto.id, user.id, { kind: 'regex' }).ok).toBe(false);
    expect(highlightRulesService.update(auto.id, user.id, { case_sensitive: true }).ok).toBe(false);
    // enabled IS allowed on auto rules.
    expect(highlightRulesService.update(auto.id, user.id, { enabled: false }).ok).toBe(true);
  });

  it('validates regex on update when kind changes to regex', () => {
    const created = highlightRulesService.create(user.id, { pattern: 'plain', kind: 'plain' });
    const ruleId = created.ok ? created.rule!.id : 0;
    const res = highlightRulesService.update(ruleId, user.id, { kind: 'regex', pattern: '[bad' });
    expect(res.ok).toBe(false);
  });
});

describe('remove', () => {
  it('404 on unknown', () => {
    expect(highlightRulesService.remove(999999, user.id).ok).toBe(false);
  });

  it('refuses to remove an auto-managed rule directly', () => {
    const auto = highlightRulesService.upsertAutoNickRule(user.id, net.id, 'auto-only')!;
    const res = highlightRulesService.remove(auto.id, user.id);
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toMatch(/auto-managed/);
  });
});

describe('getCompiled (caching)', () => {
  it('returns a compiled engine and caches across calls until invalidated', () => {
    const before = highlightRulesService.getCompiled(user.id);
    const cached = highlightRulesService.getCompiled(user.id);
    expect(cached).toBe(before);
    // Create a new rule → cache invalidated.
    highlightRulesService.create(user.id, { pattern: 'fresh' });
    const after = highlightRulesService.getCompiled(user.id);
    expect(after).not.toBe(before);
  });
});

describe('upsertAutoNickRule', () => {
  it('returns null for empty nick', () => {
    expect(highlightRulesService.upsertAutoNickRule(user.id, net.id, '')).toBeNull();
  });
});
