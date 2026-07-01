// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import type { IgnoreRuleRow } from '../db/ignoredMasks.js';
import type { IgnoreInput } from './ignoreMatch.js';
import {
  compileIgnoreRules,
  evaluateIgnores,
  canonicalizeLevels,
  channelMutesUnread,
} from './ignoreMatch.js';

function r(overrides: Partial<IgnoreRuleRow> = {}): IgnoreRuleRow {
  return {
    id: 1,
    mask: null,
    channels: null,
    pattern: null,
    patternKind: 'substr',
    levels: ['ALL'],
    isExcept: false,
    expiresAt: null,
    createdAt: '',
    ...overrides,
  };
}

function input(overrides: Partial<IgnoreInput> = {}): IgnoreInput {
  return {
    nick: 'bob',
    userhost: 'bob!u@h',
    target: '#chan',
    text: 'hello',
    type: 'message',
    isDm: false,
    ...overrides,
  };
}

function evalRules(rules: IgnoreRuleRow[], inp: Partial<IgnoreInput>) {
  return evaluateIgnores(compileIgnoreRules(rules), input(inp));
}

describe('must-have #1 — NOHIGHLIGHT', () => {
  it('keeps the message visible but suppresses the highlight', () => {
    const rules = [r({ mask: 'bob', levels: ['NOHIGHLIGHT'] })];
    expect(evalRules(rules, { nick: 'bob', type: 'message' })).toEqual({
      hide: false,
      nohilight: true,
      nonotify: false,
    });
  });

  it('does not affect a different sender', () => {
    const rules = [r({ mask: 'bob', levels: ['NOHIGHLIGHT'] })];
    expect(evalRules(rules, { nick: 'alice', type: 'message' })).toEqual({
      hide: false,
      nohilight: false,
      nonotify: false,
    });
  });

  it('only applies to highlightable types (message/action), not joins', () => {
    const rules = [r({ mask: 'bob', levels: ['NOHIGHLIGHT'] })];
    expect(evalRules(rules, { type: 'action', text: 'waves' }).nohilight).toBe(true);
    expect(evalRules(rules, { type: 'join', text: '' }).nohilight).toBe(false);
  });
});

describe('must-have #2 — content regex scoped to a channel', () => {
  const rules = [
    r({
      mask: null,
      channels: ['#chan'],
      pattern: '(word1|word2)',
      patternKind: 'regex',
      levels: ['PUBLIC'],
    }),
  ];

  it('hides a matching message in the scoped channel, from anyone', () => {
    expect(
      evalRules(rules, { nick: 'anyone', target: '#chan', text: 'has word2 in it' }).hide,
    ).toBe(true);
  });

  it('does not hide in a different channel', () => {
    expect(evalRules(rules, { target: '#other', text: 'has word1 in it' }).hide).toBe(false);
  });

  it('does not hide a non-matching message', () => {
    expect(evalRules(rules, { target: '#chan', text: 'nothing here' }).hide).toBe(false);
  });
});

describe('glob masks', () => {
  it('* JOINS hides a join from anyone but not a message', () => {
    const rules = [r({ mask: null, levels: ['JOINS'] })];
    expect(evalRules(rules, { type: 'join', text: '' }).hide).toBe(true);
    expect(evalRules(rules, { type: 'message' }).hide).toBe(false);
  });

  it('*zzz* NICKS globs the nick on a nick-change', () => {
    const rules = [r({ mask: '*zzz*', levels: ['NICKS'] })];
    expect(evalRules(rules, { nick: 'fooZZZbar', type: 'nick', text: '' }).hide).toBe(true);
    expect(evalRules(rules, { nick: 'foo', type: 'nick', text: '' }).hide).toBe(false);
  });

  it('bare-nick mask is anchored (not a substring)', () => {
    const rules = [r({ mask: 'bozo', levels: ['ALL'] })];
    expect(evalRules(rules, { nick: 'Bozo' }).hide).toBe(true); // case-insensitive
    expect(evalRules(rules, { nick: 'bozoXYZ' }).hide).toBe(false); // anchored
  });
});

describe('PUBLIC vs MSGS split', () => {
  it('PUBLIC matches channel messages only', () => {
    const rules = [r({ mask: 'bob', levels: ['PUBLIC'] })];
    expect(evalRules(rules, { type: 'message', isDm: false }).hide).toBe(true);
    expect(evalRules(rules, { type: 'message', isDm: true, target: 'bob' }).hide).toBe(false);
  });

  it('MSGS matches DM messages only', () => {
    const rules = [r({ mask: 'bob', levels: ['MSGS'] })];
    expect(evalRules(rules, { type: 'message', isDm: true, target: 'bob' }).hide).toBe(true);
    expect(evalRules(rules, { type: 'message', isDm: false }).hide).toBe(false);
  });
});

describe('ALL coverage', () => {
  const rules = [r({ mask: 'bob', levels: ['ALL'] })];

  it('hides every ignorable type', () => {
    for (const type of [
      'message',
      'action',
      'notice',
      'join',
      'part',
      'quit',
      'nick',
      'kick',
      'mode',
      'topic',
    ]) {
      expect(evalRules(rules, { type, text: 'x' }).hide).toBe(true);
    }
  });

  it('does not hide system/self rows', () => {
    for (const type of ['motd', 'error', 'names', 'usermode']) {
      expect(evalRules(rules, { type }).hide).toBe(false);
    }
  });
});

describe('-except longest-mask-wins', () => {
  const rules = [
    r({ id: 1, mask: '*!*@spam', levels: ['ALL'] }),
    r({ id: 2, mask: 'bob!*@spam', levels: ['ALL'], isExcept: true }),
  ];

  it('the longer except mask wins (bob stays visible)', () => {
    expect(evalRules(rules, { nick: 'bob', userhost: 'bob!u@spam' }).hide).toBe(false);
  });

  it('others on the host are still hidden', () => {
    expect(evalRules(rules, { nick: 'eve', userhost: 'eve!u@spam' }).hide).toBe(true);
  });
});

describe('expiry', () => {
  it('a lapsed rule never matches', () => {
    const rules = [r({ mask: 'bob', levels: ['ALL'], expiresAt: '2000-01-01T00:00:00.000Z' })];
    expect(evalRules(rules, {}).hide).toBe(false);
  });

  it('a future rule still matches', () => {
    const rules = [r({ mask: 'bob', levels: ['ALL'], expiresAt: '2999-01-01T00:00:00.000Z' })];
    expect(evalRules(rules, {}).hide).toBe(true);
  });
});

describe('URL stripping', () => {
  const rules = [r({ mask: null, pattern: 'spam', patternKind: 'substr', levels: ['PUBLIC'] })];

  it('does not match a word that appears only inside a URL', () => {
    expect(evalRules(rules, { text: 'see https://spam.example here' }).hide).toBe(false);
  });

  it('still matches the word outside a URL', () => {
    expect(evalRules(rules, { text: 'this is spam' }).hide).toBe(true);
  });
});

describe('canonicalizeLevels', () => {
  it('normalizes aliases and drops unknown tokens, in canonical order', () => {
    expect(canonicalizeLevels(['publics', 'join'])).toEqual(['PUBLIC', 'JOINS']);
    expect(canonicalizeLevels(['bogus', 'ALL'])).toEqual(['ALL']);
    expect(canonicalizeLevels(['nohilite'])).toEqual(['NOHIGHLIGHT']);
  });

  it('canonicalizes the mute modifier aliases (issue #359)', () => {
    expect(canonicalizeLevels(['no_act'])).toEqual(['NOUNREAD']);
    expect(canonicalizeLevels(['noact'])).toEqual(['NOUNREAD']);
    expect(canonicalizeLevels(['nonotify'])).toEqual(['NONOTIFY']);
    expect(canonicalizeLevels(['NONOTIFY', 'NOUNREAD'])).toEqual(['NOUNREAD', 'NONOTIFY']);
  });
});

describe('NOUNREAD / NONOTIFY modifier levels (issue #359)', () => {
  it('a NONOTIFY rule mutes notifications but keeps the message visible', () => {
    const v = evalRules([r({ channels: ['#chan'], levels: ['NOUNREAD', 'NONOTIFY'] })], {
      target: '#chan',
    });
    expect(v).toEqual({ hide: false, nohilight: false, nonotify: true });
  });

  it('NOUNREAD alone produces no per-message verdict (badge-only, via channelMutesUnread)', () => {
    // NOUNREAD is not a per-message verdict field — its only effect is the
    // whole-buffer badge downgrade tested in the channelMutesUnread block below.
    expect(
      evalRules([r({ channels: ['#chan'], levels: ['NOUNREAD'] })], { target: '#chan' }),
    ).toEqual({ hide: false, nohilight: false, nonotify: false });
  });

  it('NONOTIFY vetoes NON-highlightable types too (notices/joins) — quietest wins', () => {
    // A muted channel/network must silence a notify_always notice/join, not just
    // messages — so nonotify is NOT bounded to highlightable types.
    const rules = [r({ channels: ['#chan'], levels: ['NONOTIFY'] })];
    expect(evalRules(rules, { target: '#chan', type: 'notice', text: 'hi' }).nonotify).toBe(true);
    expect(evalRules(rules, { target: '#chan', type: 'join', text: '' }).nonotify).toBe(true);
    expect(evalRules(rules, { target: '#chan', type: 'action', text: 'waves' }).nonotify).toBe(
      true,
    );
  });

  it('respects channel scope — a different channel is unaffected', () => {
    const rules = [r({ channels: ['#chan'], levels: ['NONOTIFY'] })];
    expect(evalRules(rules, { target: '#other' }).nonotify).toBe(false);
  });

  it('is sender-scopable via a mask (that person everywhere)', () => {
    const rules = [r({ mask: 'bob', levels: ['NONOTIFY'] })];
    expect(evalRules(rules, { nick: 'bob' }).nonotify).toBe(true);
    expect(evalRules(rules, { nick: 'alice' }).nonotify).toBe(false);
  });

  it('honors -except (a longer except mask un-mutes)', () => {
    const rules = [
      r({ id: 1, mask: null, channels: ['#chan'], levels: ['NONOTIFY'] }),
      r({ id: 2, mask: 'boss', channels: ['#chan'], levels: ['NONOTIFY'], isExcept: true }),
    ];
    expect(evalRules(rules, { nick: 'rando', target: '#chan' }).nonotify).toBe(true);
    expect(evalRules(rules, { nick: 'boss', target: '#chan' }).nonotify).toBe(false);
  });
});

describe('channelMutesUnread (issue #359)', () => {
  it('is true for a whole-channel NOUNREAD rule', () => {
    expect(
      channelMutesUnread(
        compileIgnoreRules([r({ channels: ['#chan'], levels: ['NOUNREAD'] })]),
        '#chan',
      ),
    ).toBe(true);
  });

  it('is true for a network-wide rule (channels null) on any buffer', () => {
    const compiled = compileIgnoreRules([r({ channels: null, mask: null, levels: ['NOUNREAD'] })]);
    expect(channelMutesUnread(compiled, '#anything')).toBe(true);
    expect(channelMutesUnread(compiled, 'somenick')).toBe(true); // DM buffer too
  });

  it('is false in an unrelated channel', () => {
    expect(
      channelMutesUnread(
        compileIgnoreRules([r({ channels: ['#chan'], levels: ['NOUNREAD'] })]),
        '#other',
      ),
    ).toBe(false);
  });

  it('does not fire for a masked (per-sender) NOUNREAD rule', () => {
    expect(
      channelMutesUnread(
        compileIgnoreRules([r({ mask: 'bob', channels: ['#chan'], levels: ['NOUNREAD'] })]),
        '#chan',
      ),
    ).toBe(false);
  });

  it('does not fire for a NONOTIFY-only rule', () => {
    expect(
      channelMutesUnread(
        compileIgnoreRules([r({ channels: ['#chan'], levels: ['NONOTIFY'] })]),
        '#chan',
      ),
    ).toBe(false);
  });

  it('ignores except rules', () => {
    expect(
      channelMutesUnread(
        compileIgnoreRules([r({ channels: ['#chan'], levels: ['NOUNREAD'], isExcept: true })]),
        '#chan',
      ),
    ).toBe(false);
  });
});
