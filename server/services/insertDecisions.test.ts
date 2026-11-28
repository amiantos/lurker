// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Integration: the insert-time stamp decision (decideStamp) drives the real
// from_ignored / matched_rule_id columns, and the count queries honor them.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-stamp-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let createUser: typeof import('../db/users.js').createUser;
let createNetwork: typeof import('../db/networks.js').createNetwork;
let insertMessage: typeof import('../db/messages.js').insertMessage;
let countNewer: typeof import('../db/messages.js').countNewer;
let countHighlightsNewer: typeof import('../db/messages.js').countHighlightsNewer;
let ignoreRulesService: typeof import('./ignoreRulesService.js').default;
let highlightRulesService: typeof import('./highlightRulesService.js').default;
let decideStamp: typeof import('./insertDecisions.js').decideStamp;
let user: ReturnType<typeof import('../db/users.js').createUser>;
let net: ReturnType<typeof import('../db/networks.js').createNetwork>;

const TIME = '2026-06-18T00:00:00.000Z';

beforeAll(async () => {
  ({ createUser } = await import('../db/users.js'));
  ({ createNetwork } = await import('../db/networks.js'));
  ({ insertMessage, countNewer, countHighlightsNewer } = await import('../db/messages.js'));
  ignoreRulesService = (await import('./ignoreRulesService.js')).default;
  highlightRulesService = (await import('./highlightRulesService.js')).default;
  ({ decideStamp } = await import('./insertDecisions.js'));
  user = createUser('stamp-alice');
  net = createNetwork(user.id, { name: 'libera', host: 'h', port: 6697, tls: true, nick: 'a' })!;
  highlightRulesService.create(user.id, { pattern: 'hello', kind: 'plain' });
});

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

function addRule(mask: string | null, levels: string[]) {
  return ignoreRulesService.add(user.id, net!.id, {
    mask,
    channels: null,
    pattern: null,
    patternKind: 'substr',
    levels,
    isExcept: false,
    expiresAt: null,
  });
}

function stamp(event: {
  type: string;
  nick: string;
  target: string;
  text: string;
  isDm?: boolean;
}) {
  return decideStamp(
    {
      type: event.type,
      nick: event.nick,
      userhost: `${event.nick}!u@h`,
      target: event.target,
      text: event.text,
    },
    highlightRulesService.getCompiled(user.id, net!.id),
    ignoreRulesService.getCompiled(user.id, net!.id),
    !!event.isDm,
  );
}

function insert(
  target: string,
  decided: { matchedRuleId: number | null; fromIgnored: boolean },
  opts: { type?: string; nick: string; text: string },
) {
  insertMessage({
    networkId: net!.id,
    target,
    time: TIME,
    type: opts.type ?? 'message',
    nick: opts.nick,
    text: opts.text,
    matchedRuleId: decided.matchedRuleId,
    fromIgnored: decided.fromIgnored,
  });
}

describe('NOHIGHLIGHT', () => {
  it('keeps the message visible and counted but suppresses the highlight', () => {
    expect(addRule('bob', ['NOHIGHLIGHT']).ok).toBe(true);
    const decided = stamp({ type: 'message', nick: 'bob', target: '#nh', text: 'hello there' });
    expect(decided.matchedRuleId).toBeNull();
    expect(decided.fromIgnored).toBe(false);
    insert('#nh', decided, { nick: 'bob', text: 'hello there' });
    expect(countNewer(net!.id, '#nh', 0)).toBe(1);
    expect(countHighlightsNewer(net!.id, '#nh', 0)).toBe(0);
  });

  it('a non-ignored sender still highlights on the same word', () => {
    const decided = stamp({ type: 'message', nick: 'carol', target: '#nh', text: 'hello!' });
    expect(decided.matchedRuleId).not.toBeNull();
    expect(decided.fromIgnored).toBe(false);
    insert('#nh', decided, { nick: 'carol', text: 'hello!' });
    expect(countHighlightsNewer(net!.id, '#nh', 0)).toBe(1);
  });
});

// The rule the Suppress Highlights box writes (#1414): no mask, one channel.
describe('NOHIGHLIGHT for a whole channel', () => {
  it('stops anyone highlighting there, and nowhere else', () => {
    const added = ignoreRulesService.add(user.id, net!.id, {
      mask: null,
      channels: ['#quiet'],
      pattern: null,
      patternKind: 'substr',
      levels: ['NOHIGHLIGHT'],
      isExcept: false,
      expiresAt: null,
    });
    expect(added.ok).toBe(true);

    const there = stamp({ type: 'message', nick: 'carol', target: '#Quiet', text: 'hello!' });
    expect(there.matchedRuleId).toBeNull();
    expect(there.fromIgnored).toBe(false);

    const elsewhere = stamp({ type: 'message', nick: 'carol', target: '#loud', text: 'hello!' });
    expect(elsewhere.matchedRuleId).not.toBeNull();
  });
});

describe('PUBLIC hide', () => {
  it('stamps from_ignored and drops from unread', () => {
    expect(addRule('spammer', ['PUBLIC']).ok).toBe(true);
    const decided = stamp({ type: 'message', nick: 'spammer', target: '#spam', text: 'buy now' });
    expect(decided.fromIgnored).toBe(true);
    insert('#spam', decided, { nick: 'spammer', text: 'buy now' });
    expect(countNewer(net!.id, '#spam', 0)).toBe(0);
  });
});

describe('JOINS hide — non-countable events are not server-stamped', () => {
  it('does not stamp from_ignored on a join (client hides it; no count to feed)', () => {
    expect(addRule('joiner', ['JOINS']).ok).toBe(true);
    const before = countNewer(net!.id, '#nh', 0);
    const decided = stamp({ type: 'join', nick: 'joiner', target: '#nh', text: '' });
    // Joins aren't a COUNTABLE_TYPE, so decideStamp skips ignore evaluation
    // entirely — the row stays from_ignored=0 and the client filters it live.
    expect(decided.fromIgnored).toBe(false);
    insert('#nh', decided, { type: 'join', nick: 'joiner', text: '' });
    expect(countNewer(net!.id, '#nh', 0)).toBe(before);
  });
});
