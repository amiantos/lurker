// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { IgnoreRuleInput } from './ignoredMasks.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-rulescope-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let createUser: typeof import('./users.js').createUser;
let createNetwork: typeof import('./networks.js').createNetwork;
let buffers: typeof import('./buffers.js');
let ignores: typeof import('./ignoredMasks.js');
let highlights: typeof import('./highlightRules.js');
let renameBuffer: typeof import('./renameBuffer.js').renameBuffer;
let refoldNetworkBuffers: typeof import('./refoldBuffers.js').refoldNetworkBuffers;
let moveScopeEntry: typeof import('./ruleScopeRename.js').moveScopeEntry;
let counter = 0;

const MUTE = ['NOUNREAD', 'NONOTIFY'];

function rule(overrides: Partial<IgnoreRuleInput> = {}): IgnoreRuleInput {
  return {
    mask: null,
    channels: null,
    pattern: null,
    patternKind: 'substr',
    levels: MUTE,
    isExcept: false,
    expiresAt: null,
    ...overrides,
  };
}

// A fresh user with two networks per test: rules are per user, and a global
// one left behind by another test would be in every list here.
function world() {
  const user = createUser(`scope-${++counter}`);
  const mk = (name: string) =>
    createNetwork(user.id, { name, host: 'h', port: 6697, tls: true, nick: 'a' })!;
  const here = mk('here');
  const there = mk('there');
  const channel = (name: string, netId = here.id) =>
    buffers.ensureOpen(user.id, netId, name, { kind: 'channel' });
  const ignoreScopes = (networkId: number | null) =>
    (networkId == null
      ? ignores.listGlobalRules(user.id)
      : ignores.listRules({ userId: user.id, networkId })
    ).map((r) => r.channels);
  return { user, here, there, channel, ignoreScopes };
}

beforeAll(async () => {
  ({ createUser } = await import('./users.js'));
  ({ createNetwork } = await import('./networks.js'));
  buffers = await import('./buffers.js');
  ignores = await import('./ignoredMasks.js');
  highlights = await import('./highlightRules.js');
  ({ renameBuffer } = await import('./renameBuffer.js'));
  ({ refoldNetworkBuffers } = await import('./refoldBuffers.js'));
  ({ moveScopeEntry } = await import('./ruleScopeRename.js'));
});

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('moveScopeEntry', () => {
  const lower = (s: string) => s.toLowerCase();

  it('replaces the entry that is the old name and leaves the rest in place', () => {
    expect(moveScopeEntry(['#a', '#old', '#z'], '#Old', '#new', lower, true)).toEqual([
      '#a',
      '#new',
      '#z',
    ]);
  });

  it('adds the new name beside the old one when told to keep it', () => {
    expect(moveScopeEntry(['#old', '#z'], '#old', '#new', lower, false)).toEqual([
      '#old',
      '#new',
      '#z',
    ]);
  });

  it('leaves a glob alone: it is a statement about names, not this buffer', () => {
    expect(moveScopeEntry(['#old*', '#ol?'], '#old', '#new', lower, true)).toBeNull();
  });

  it('answers null when nothing names the old buffer', () => {
    expect(moveScopeEntry(['#other'], '#old', '#new', lower, true)).toBeNull();
  });

  it('does not list the new name twice when the rule already had it', () => {
    expect(moveScopeEntry(['#new', '#old'], '#old', '#NEW', lower, true)).toEqual(['#new']);
    expect(moveScopeEntry(['#old', '#new'], '#old', '#new', lower, false)).toEqual([
      '#old',
      '#new',
    ]);
  });

  it('needs nothing when the entry already reads as the new name', () => {
    // A rename that only changes case: the matcher ignores case.
    expect(moveScopeEntry(['#chan'], '#chan', '#Chan', lower, true)).toBeNull();
  });

  it('finds the entry through the network fold, not through its spelling', () => {
    const rfc1459 = (s: string) => s.toLowerCase().replace(/\[/g, '{').replace(/\]/g, '}');
    expect(moveScopeEntry(['#foo[bar]'], '#foo{bar}', '#new', rfc1459, true)).toEqual(['#new']);
  });
});

describe('rule scopes follow a rename (#719)', () => {
  it('a channel mute follows the channel to its new name', () => {
    const w = world();
    w.channel('#old');
    ignores.addRule({
      userId: w.user.id,
      networkId: w.here.id,
      rule: rule({ channels: ['#old'] }),
    });

    const result = renameBuffer(w.user.id, w.here.id, '#old', '#New')!;

    // Stored lowercased, as the menu writes a mute, so the next toggle finds it.
    expect(w.ignoreScopes(w.here.id)).toEqual([['#new']]);
    expect(result.rulesMoved).toEqual({ ignore: [w.here.id], highlight: false });
  });

  it("leaves another network's rule for the same name alone", () => {
    const w = world();
    w.channel('#old');
    ignores.addRule({
      userId: w.user.id,
      networkId: w.there.id,
      rule: rule({ channels: ['#old'] }),
    });

    const result = renameBuffer(w.user.id, w.here.id, '#old', '#new')!;

    expect(w.ignoreScopes(w.there.id)).toEqual([['#old']]);
    expect(result.rulesMoved.ignore).toEqual([]);
  });

  it('a global rule gains the new name and keeps the old one for the other networks', () => {
    const w = world();
    w.channel('#old');
    ignores.addRule({
      userId: w.user.id,
      networkId: null,
      rule: rule({ channels: ['#old', '#keep'], levels: ['JOINS'] }),
    });

    const result = renameBuffer(w.user.id, w.here.id, '#old', '#new')!;

    expect(w.ignoreScopes(null)).toEqual([['#old', '#new', '#keep']]);
    expect(result.rulesMoved.ignore).toEqual([null]);
  });

  it('leaves a glob that matched the old name as it was written', () => {
    const w = world();
    w.channel('#old');
    ignores.addRule({
      userId: w.user.id,
      networkId: w.here.id,
      rule: rule({ channels: ['#ol*'] }),
    });

    const result = renameBuffer(w.user.id, w.here.id, '#old', '#new')!;

    expect(w.ignoreScopes(w.here.id)).toEqual([['#ol*']]);
    expect(result.rulesMoved.ignore).toEqual([]);
  });

  it('moves nothing on a rename that only changes case', () => {
    const w = world();
    w.channel('#old');
    ignores.addRule({
      userId: w.user.id,
      networkId: w.here.id,
      rule: rule({ channels: ['#old'] }),
    });

    const result = renameBuffer(w.user.id, w.here.id, '#old', '#OLD')!;

    expect(result.renamed).toBe(true);
    expect(w.ignoreScopes(w.here.id)).toEqual([['#old']]);
    expect(result.rulesMoved).toEqual({ ignore: [], highlight: false });
  });

  it('a merge of two muted buffers leaves one mute, with the longer life', () => {
    const w = world();
    w.channel('#old');
    w.channel('#new');
    const kept = ignores.addRule({
      userId: w.user.id,
      networkId: w.here.id,
      rule: rule({ channels: ['#new'], expiresAt: '2099-01-01T00:00:00.000Z' }),
    });
    ignores.addRule({
      userId: w.user.id,
      networkId: w.here.id,
      rule: rule({ channels: ['#old'] }),
    });

    const result = renameBuffer(w.user.id, w.here.id, '#old', '#new')!;

    expect(result.merged).toBe(true);
    const rules = ignores.listRules({ userId: w.user.id, networkId: w.here.id });
    expect(rules).toHaveLength(1);
    // The one that was already there, now as permanent as the one it absorbed.
    expect(rules[0]).toMatchObject({ id: kept.id, channels: ['#new'], expiresAt: null });
  });

  it('does not fold two rules that differ in anything but the channel', () => {
    const w = world();
    w.channel('#old');
    w.channel('#new');
    ignores.addRule({
      userId: w.user.id,
      networkId: w.here.id,
      rule: rule({ channels: ['#new'], levels: ['NONOTIFY'] }),
    });
    ignores.addRule({
      userId: w.user.id,
      networkId: w.here.id,
      rule: rule({ channels: ['#old'] }),
    });

    renameBuffer(w.user.id, w.here.id, '#old', '#new');

    expect(ignores.listRules({ userId: w.user.id, networkId: w.here.id })).toHaveLength(2);
    expect(w.ignoreScopes(w.here.id)).toEqual([['#new'], ['#new']]);
  });

  it("a DM mute follows the peer's nick", () => {
    const w = world();
    buffers.ensureOpen(w.user.id, w.here.id, 'bob', { kind: 'dm' });
    ignores.addRule({ userId: w.user.id, networkId: w.here.id, rule: rule({ channels: ['bob'] }) });

    renameBuffer(w.user.id, w.here.id, 'bob', 'bob_away');

    expect(w.ignoreScopes(w.here.id)).toEqual([['bob_away']]);
  });

  it('a highlight rule scoped to this network alone has the entry replaced', () => {
    const w = world();
    w.channel('#old');
    const made = highlights.createRule(w.user.id, {
      pattern: 'deploy',
      channels: ['#old', '#ops'],
      networkId: w.here.id,
    })!;

    const result = renameBuffer(w.user.id, w.here.id, '#old', '#New')!;

    expect(highlights.getRule(made.id, w.user.id)!.channels).toEqual(['#new', '#ops']);
    expect(result.rulesMoved.highlight).toBe(true);
  });

  it('a highlight rule for every network keeps the old name beside the new', () => {
    const w = world();
    w.channel('#old');
    const made = highlights.createRule(w.user.id, { pattern: 'deploy', channels: ['#old'] })!;

    renameBuffer(w.user.id, w.here.id, '#old', '#new');

    expect(highlights.getRule(made.id, w.user.id)!.channels).toEqual(['#old', '#new']);
  });

  it("a highlight rule that is another network's is not touched", () => {
    const w = world();
    w.channel('#old');
    const made = highlights.createRule(w.user.id, {
      pattern: 'deploy',
      channels: ['#old'],
      networkId: w.there.id,
    })!;

    const result = renameBuffer(w.user.id, w.here.id, '#old', '#new')!;

    expect(highlights.getRule(made.id, w.user.id)!.channels).toEqual(['#old']);
    expect(result.rulesMoved.highlight).toBe(false);
  });

  it('a casemapping refold moves a mute off the spelling that was absorbed', () => {
    const w = world();
    // Two rows that only an rfc1459 fold brings together. The newer message
    // decides the survivor (refoldBuffers), so give it to one of them.
    w.channel('#foo[bar]');
    w.channel('#foo{bar}');
    ignores.addRule({
      userId: w.user.id,
      networkId: w.here.id,
      rule: rule({ channels: ['#foo[bar]'] }),
    });
    ignores.addRule({
      userId: w.user.id,
      networkId: w.here.id,
      rule: rule({ channels: ['#foo{bar}'], levels: ['JOINS'] }),
    });

    const merges = refoldNetworkBuffers(w.user.id, w.here.id, 'rfc1459');

    expect(merges).toHaveLength(1);
    const survivor = merges[0].survivorTarget.toLowerCase();
    // Both rules name the spelling that is left, whichever it was.
    expect(w.ignoreScopes(w.here.id)).toEqual([[survivor], [survivor]]);
    expect(merges[0].rulesMoved.ignore).toEqual([w.here.id]);
  });
});
