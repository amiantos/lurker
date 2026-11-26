// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { logLine, trimBlankEdges, type LogContext, type LogMessage } from './copyLog.js';
import type { ConsolidationGroup } from '../../../shared/consolidate.js';

interface Msg extends LogMessage {
  userhost?: string;
  account?: string;
}

const MARKS: Record<string, string> = { join: '-->', part: '<--', quit: '<--', kick: '<--' };

function ctx(over: Partial<LogContext<Msg>> = {}): LogContext<Msg> {
  return {
    time: (iso) => (iso ? iso.slice(11, 19) : ''),
    prefix: (m) => MARKS[m.type] ?? (m.type === 'error' ? '!!' : '--'),
    nickPrefix: () => '',
    hostSuffix: (m) => (m.userhost ? ` (${m.userhost})` : ''),
    accountSuffix: (m) => (m.account ? ` [${m.account}]` : ''),
    newMask: () => 'new@host',
    modePhrase: (g) => ` were given +${g.letter}`,
    rawModes: () => false,
    ...over,
  };
}

const T = '2026-10-05T12:04:05.000Z';

function line(m: Partial<Msg>, c = ctx()): string | null {
  return logLine({ m: { type: 'message', time: T, ...m } }, c);
}

describe('trimBlankEdges', () => {
  it('drops line breaks at the edges and nothing else', () => {
    expect(trimBlankEdges('a line\n\n\n\n\n\n')).toBe('a line');
    expect(trimBlankEdges('\n \n  a line \n \n')).toBe('a line');
    expect(trimBlankEdges('a line\n')).toBe('a line');
    expect(trimBlankEdges('one\n\ntwo\n')).toBe('one\n\ntwo');
    expect(trimBlankEdges(' word ')).toBe(' word ');
    expect(trimBlankEdges('\n\n')).toBe('');
  });
});

describe('logLine', () => {
  it('writes chat lines the way IRC logs do', () => {
    expect(line({ nick: 'alice', text: 'hello' })).toBe('[12:04:05] <alice> hello');
    expect(line({ type: 'action', nick: 'bob', text: 'waves' })).toBe('[12:04:05] * bob waves');
    expect(line({ type: 'notice', nick: 'ChanServ', text: 'hi' })).toBe('[12:04:05] -ChanServ- hi');
  });

  it('drops formatting codes and keeps a spoiler as markup', () => {
    expect(line({ nick: 'alice', text: '\x02bold\x02 and \x0304red\x03' })).toBe(
      '[12:04:05] <alice> bold and red',
    );
    expect(line({ nick: 'alice', text: 'it was \x0301,01the butler\x03' })).toBe(
      '[12:04:05] <alice> it was ||the butler||',
    );
  });

  it('keeps a line’s whitespace, and the address a reply was said with', () => {
    expect(line({ nick: 'alice', text: '    return x;' })).toBe('[12:04:05] <alice>     return x;');
    expect(line({ nick: 'bob', text: 'yes, ship it', addressedText: 'alice: yes, ship it' })).toBe(
      '[12:04:05] <bob> alice: yes, ship it',
    );
  });

  it('puts the mode prefix on a message’s nick, and on nothing else', () => {
    const c = ctx({ nickPrefix: (m) => (m.nick === 'alice' ? '@' : '') });
    expect(line({ nick: 'alice', text: 'hello' }, c)).toBe('[12:04:05] <@alice> hello');
    expect(line({ nick: 'bob', text: 'hello' }, c)).toBe('[12:04:05] <bob> hello');
    expect(line({ type: 'action', nick: 'alice', text: 'waves' }, c)).toBe(
      '[12:04:05] * alice waves',
    );
    expect(line({ type: 'notice', nick: 'alice', text: 'psst' }, c)).toBe(
      '[12:04:05] -alice- psst',
    );
    expect(line({ type: 'join', nick: 'alice' }, c)).toBe('[12:04:05] --> alice joined');
  });

  it('names the rank a line was sent to, with the channel (#1408)', () => {
    const to = { nick: 'alice', statusmsg: '@', target: '#chan' };
    expect(line({ ...to, text: 'ops only' })).toBe('[12:04:05] <alice:@#chan> ops only');
    expect(line({ ...to, type: 'notice', text: 'psst' })).toBe('[12:04:05] -alice:@#chan- psst');
    expect(line({ ...to, text: 'hi' }, ctx({ nickPrefix: () => '+' }))).toBe(
      '[12:04:05] <+alice:@#chan> hi',
    );
  });

  it('leaves the brackets off when the reader shows no timestamps', () => {
    expect(line({ nick: 'alice', text: 'hello' }, ctx({ time: () => '' }))).toBe('<alice> hello');
  });

  it('names where a relayed line is from, and what became of a deleted one', () => {
    expect(line({ nick: 'dave', text: 'pushed', relaySource: 'github' })).toBe(
      '[12:04:05] <dave> [github] pushed',
    );
    expect(
      line({ nick: 'alice', text: '', redaction: { by: 'op', time: T, reason: 'spam' } }),
    ).toBe('[12:04:05] <alice> message deleted by op: spam');
  });

  it('writes events with their mark and the suffixes the list shows', () => {
    expect(line({ type: 'join', nick: 'carol', account: 'carol_', userhost: 'c@host' })).toBe(
      '[12:04:05] --> carol [carol_] (c@host) joined',
    );
    expect(line({ type: 'part', nick: 'carol', text: 'bye' })).toBe(
      '[12:04:05] <-- carol left (bye)',
    );
    expect(line({ type: 'quit', nick: 'carol' })).toBe('[12:04:05] <-- carol quit');
    expect(line({ type: 'kick', nick: 'op', kicked: 'troll', text: 'out' })).toBe(
      '[12:04:05] <-- troll kicked by op (out)',
    );
    expect(line({ type: 'nick', nick: 'carol', newNick: 'caz' })).toBe(
      '[12:04:05] -- carol is now caz',
    );
    expect(line({ type: 'chghost', nick: 'carol' })).toBe(
      '[12:04:05] -- carol changed host to new@host',
    );
    expect(line({ type: 'invite', nick: 'op', invited: 'dave' })).toBe(
      '[12:04:05] -- op invited dave',
    );
    expect(line({ type: 'topic', nick: 'op', text: 'new \x02topic\x02' })).toBe(
      '[12:04:05] -- topic set by op: new topic',
    );
    expect(line({ type: 'error', text: 'No such nick' })).toBe('[12:04:05] !! No such nick');
  });

  it('narrates a mode change as the list does', () => {
    const out = line({
      type: 'mode',
      nick: 'op',
      modes: [{ mode: '+o', param: 'dave', kind: 'prefix' }] as never,
    });
    expect(out).toMatch(/^\[12:04:05\] -- op .*dave$/);
  });

  it('writes the mode string when the list shows one (consolidation off)', () => {
    const out = line(
      {
        type: 'mode',
        nick: 'op',
        modes: [{ mode: '+o', param: 'dave', kind: 'prefix' }] as never,
      },
      ctx({ rawModes: () => true }),
    );
    expect(out).toBe('[12:04:05] -- op set +o dave');
  });

  it('writes a folded run of events in the list’s words', () => {
    const groups: ConsolidationGroup[] = [
      { kind: 'joined', visible: [{ nick: 'a' }, { nick: 'b' }, { nick: 'c' }], hidden: 0 },
      { kind: 'left', visible: [{ nick: 'd' }, { nick: 'e' }], hidden: 2 },
      { kind: 'renamed', visible: [{ from: 'f', to: 'g' }], hidden: 0 },
      { kind: 'modeGranted', visible: [{ nick: 'h' }, { nick: 'i' }], hidden: 0, letter: 'q' },
    ];
    expect(logLine({ consolidation: true, groups, time: T }, ctx())).toBe(
      '[12:04:05] -- a, b and c joined; d, e, and 2 others left; f → g; h and i were given +q',
    );
  });

  it('keeps the day line and drops the markers a log has no line for', () => {
    expect(logLine({ divider: 'date', dateStr: 'Mon Oct 5 2026' }, ctx())).toBe(
      '--- Mon Oct 5 2026 ---',
    );
    for (const divider of ['unread', 'away', 'back', 'cleared']) {
      expect(logLine({ divider }, ctx())).toBeNull();
    }
  });
});
