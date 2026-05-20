// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-hl-rules-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let createUser: typeof import('./users.js').createUser;
let createNetwork: typeof import('./networks.js').createNetwork;
let mod: typeof import('./highlightRules.js');
let db: typeof import('./index.js').default;
let user: ReturnType<typeof import('./users.js').createUser>;
let net1: ReturnType<typeof import('./networks.js').createNetwork>;
let net2: ReturnType<typeof import('./networks.js').createNetwork>;

beforeAll(async () => {
  ({ createUser } = await import('./users.js'));
  ({ createNetwork } = await import('./networks.js'));
  mod = await import('./highlightRules.js');
  ({ default: db } = await import('./index.js'));
  user = createUser('hr-alice');
  net1 = createNetwork(user.id, { name: 'libera', host: 'h', port: 6697, tls: true, nick: 'alice' });
  net2 = createNetwork(user.id, { name: 'oftc', host: 'h2', port: 6697, tls: true, nick: 'aly' });
});

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('CRUD basics', () => {
  it('createRule + getRule + updateRule + deleteRule round-trip', () => {
    const r = mod.createRule(user.id, { pattern: 'review', kind: 'plain' });
    expect(r).toMatchObject({ pattern: 'review', enabled: true, case_sensitive: false });
    expect(mod.getRule(r!.id, user.id)!.pattern).toBe('review');
    const updated = mod.updateRule(r!.id, user.id, { enabled: false });
    expect(updated!.enabled).toBe(false);
    mod.deleteRule(r!.id, user.id);
    expect(mod.getRule(r!.id, user.id)).toBeNull();
  });

  it('owner scoping — another user can\'t fetch or edit your rules', () => {
    const r = mod.createRule(user.id, { pattern: 'mine' });
    const stranger = createUser('hr-stranger');
    expect(mod.getRule(r!.id, stranger.id)).toBeNull();
    expect(mod.updateRule(r!.id, stranger.id, { enabled: false })).toBeNull();
  });
});

describe('upsertAutoNickRule', () => {
  it('creates an auto rule and attaches the network', () => {
    const rule = mod.upsertAutoNickRule(user.id, net1!.id, 'alice');
    expect(rule!.auto_managed).toBe(true);
    expect(rule!.pattern).toBe('alice');
    const links = db.prepare(`SELECT network_id FROM highlight_rule_networks WHERE rule_id = ?`).all(rule!.id) as Array<{ network_id: number }>;
    expect(links.map((l) => l.network_id)).toEqual([net1!.id]);
  });

  it('attaches additional networks that share the same nick', () => {
    // Now set net2's nick to also be 'alice' and call upsert; the existing
    // auto rule should pick up net2.
    const rule = mod.upsertAutoNickRule(user.id, net2!.id, 'alice');
    const links = db.prepare(`SELECT network_id FROM highlight_rule_networks WHERE rule_id = ? ORDER BY network_id`).all(rule!.id) as Array<{ network_id: number }>;
    expect(links.map((l) => l.network_id).sort()).toEqual([net1!.id, net2!.id].sort());
  });

  it('switching a network\'s nick detaches the old auto rule and sweeps it when orphaned', () => {
    // net1's nick changes from 'alice' to 'newbie'. After this call the
    // old auto rule for 'alice' loses net1, gains nothing for 'alice', and
    // the new auto rule for 'newbie' should appear.
    mod.upsertAutoNickRule(user.id, net1!.id, 'newbie');
    const aliceRule = mod.upsertAutoNickRule(user.id, net2!.id, 'alice'); // ensure stable
    const aliceLinks = db.prepare(`SELECT network_id FROM highlight_rule_networks WHERE rule_id = ?`).all(aliceRule!.id) as Array<{ network_id: number }>;
    expect(aliceLinks.map((l) => l.network_id)).toEqual([net2!.id]);
    const newbieRule = mod.listRules(user.id).find((r) => r.pattern === 'newbie' && r.auto_managed);
    expect(newbieRule).toBeTruthy();
    const newbieLinks = db.prepare(`SELECT network_id FROM highlight_rule_networks WHERE rule_id = ?`).all(newbieRule!.id) as Array<{ network_id: number }>;
    expect(newbieLinks.map((l) => l.network_id)).toEqual([net1!.id]);
  });

  it('skips auto-creation when a matching manual rule already exists', () => {
    const manual = mod.createRule(user.id, { pattern: 'override', kind: 'plain', case_sensitive: false });
    const out = mod.upsertAutoNickRule(user.id, net1!.id, 'override');
    // upsert returned null because a manual rule covers it.
    expect(out).toBeNull();
    // The manual rule was not converted to auto_managed.
    expect(mod.getRule(manual!.id, user.id)!.auto_managed).toBe(false);
  });

  it('null/empty nick returns null', () => {
    expect(mod.upsertAutoNickRule(user.id, net1!.id, '')).toBeNull();
    // The implementation guards !nick at runtime; cast for the type check
    expect(mod.upsertAutoNickRule(user.id, net1!.id, null as unknown as string)).toBeNull();
  });
});
