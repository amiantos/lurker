// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import {
  ensureChannelPrefix,
  isChannelTarget,
  isSinglePeerTarget,
  channelReadings,
  parseChannelNames,
  stripChannelPrefix,
} from './channels.js';

describe('isChannelTarget (#724)', () => {
  it('accepts all four RFC 2811 prefixes, not just #', () => {
    // The whole point: `#`-only is the bug this replaced, in ~30 client sites.
    expect(isChannelTarget('#lurker')).toBe(true);
    expect(isChannelTarget('&local')).toBe(true);
    expect(isChannelTarget('+nomodes')).toBe(true);
    expect(isChannelTarget('!ABCDEsafe')).toBe(true);
  });

  it('rejects nicks', () => {
    expect(isChannelTarget('bob')).toBe(false);
    expect(isChannelTarget('bob_')).toBe(false);
    // A nick may legally contain a prefix character — only position one counts.
    expect(isChannelTarget('a#b')).toBe(false);
    expect(isChannelTarget('nick+tag')).toBe(false);
  });

  it('rejects the `:`-prefixed sentinels', () => {
    // `:server:` / `:system:` are real buffers but neither channel nor DM, and the callers that
    // ask this question rely on them answering false.
    expect(isChannelTarget(':server:1')).toBe(false);
    expect(isChannelTarget(':system:')).toBe(false);
  });

  it('is safe on absent and empty input', () => {
    expect(isChannelTarget('')).toBe(false);
    expect(isChannelTarget(null)).toBe(false);
    expect(isChannelTarget(undefined)).toBe(false);
  });
});

// What a DCC offer may go to (#1086): one person, never a channel by any route.
describe('isSinglePeerTarget', () => {
  it('takes a nick', () => {
    for (const nick of ['bob', 'Bob[m]', 'b0b', '^_^', 'a|b']) {
      expect(isSinglePeerTarget(nick)).toBe(true);
    }
  });

  it('refuses a channel, a STATUSMSG channel, a list, and anything a line splits on', () => {
    for (const t of ['#room', '&local', '+modeless', '!12345safe', '@#room', '%+room', '~&x']) {
      expect(isSinglePeerTarget(t)).toBe(false);
    }
    for (const t of ['bob,#room', 'bob,carol', 'bob carol', 'bob\r', '', '$$*', '$#*.net']) {
      expect(isSinglePeerTarget(t)).toBe(false);
    }
  });
});

describe('channelReadings', () => {
  it('peels STATUSMSG prefixes one at a time, keeping every channel reading', () => {
    expect(channelReadings('#room')).toEqual(['#room']);
    expect(channelReadings('@#room')).toEqual(['#room']);
    expect(channelReadings('%+room')).toEqual(['+room']);
    expect(channelReadings('+#room')).toEqual(['+#room', '#room']);
    expect(channelReadings('~&x')).toEqual(['&x']);
  });

  it('is empty for a nick, a mask or nothing', () => {
    for (const t of ['bob', '@bob', '$$*', '']) expect(channelReadings(t)).toEqual([]);
  });
});

describe('stripChannelPrefix', () => {
  it('strips every leading sigil, not only #', () => {
    expect(stripChannelPrefix('#lurker')).toBe('lurker');
    expect(stripChannelPrefix('&local')).toBe('local');
    expect(stripChannelPrefix('##double')).toBe('double');
    expect(stripChannelPrefix('+plus')).toBe('plus');
  });

  it('leaves a nick alone', () => {
    expect(stripChannelPrefix('bob')).toBe('bob');
  });

  it('sorts &local next to #local rather than under punctuation', () => {
    // The sidebar/quick-switcher sort key. `&local` used to keep its sigil and file under `&`.
    expect(stripChannelPrefix('&local')).toBe(stripChannelPrefix('#local'));
  });
});

describe('ensureChannelPrefix', () => {
  it('prepends # to a bare name', () => {
    expect(ensureChannelPrefix('lurker')).toBe('#lurker');
  });

  it('leaves any RFC 2811 channel prefix untouched', () => {
    expect(ensureChannelPrefix('#chan')).toBe('#chan');
    expect(ensureChannelPrefix('&local')).toBe('&local');
    expect(ensureChannelPrefix('+modeless')).toBe('+modeless');
    expect(ensureChannelPrefix('!12345chan')).toBe('!12345chan');
  });

  it('does not validate — a lone prefix or empty string passes through / gets prefixed', () => {
    // Prefix-only concern: input validation (empty, whitespace, lone prefix)
    // stays with the caller, so these are intentionally not rejected here.
    expect(ensureChannelPrefix('#')).toBe('#');
    expect(ensureChannelPrefix('')).toBe('#');
  });
});

describe('parseChannelNames (sweep L17)', () => {
  it('gives every name a # when none has a prefix', () => {
    expect(parseChannelNames('lurker, linux')).toStrictEqual(['#lurker', '#linux']);
    expect(parseChannelNames('lurker linux')).toStrictEqual(['#lurker', '#linux']);
    expect(parseChannelNames(['lurker', 'linux go'])).toStrictEqual(['#lurker', '#linux', '#go']);
  });

  it('takes the list as typed once any name has a prefix, so a key is never made a channel', () => {
    expect(parseChannelNames('#secret hunter2')).toStrictEqual(['#secret', 'hunter2']);
    expect(parseChannelNames('#a,#b ka,kb')).toStrictEqual(['#a', '#b', 'ka', 'kb']);
    // A lone prefix still marks the list as IRC syntax, though it's dropped (Codex on L17).
    expect(parseChannelNames('# hunter2')).toStrictEqual(['hunter2']);
    expect(parseChannelNames('&local +modeless !12345chan')).toStrictEqual([
      '&local',
      '+modeless',
      '!12345chan',
    ]);
  });

  it('drops blanks and a lone prefix, and keeps the first spelling of a repeat', () => {
    expect(parseChannelNames(' lurker ,, Lurker  LURKER ')).toStrictEqual(['#lurker']);
    expect(parseChannelNames('#, #dev')).toStrictEqual(['#dev']);
    expect(parseChannelNames('lurker #lurker')).toStrictEqual(['lurker', '#lurker']);
  });

  it('reads nothing from anything but a string or an array of strings', () => {
    expect(parseChannelNames(undefined)).toStrictEqual([]);
    expect(parseChannelNames(42)).toStrictEqual([]);
    expect(parseChannelNames([42, 'lurker'])).toStrictEqual(['#lurker']);
  });
});
