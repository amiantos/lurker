// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import {
  prefixOf,
  prefixClass,
  prefixRank,
  splitChannelToken,
  statusAudience,
  statusmsgChannel,
} from './memberPrefix.js';
import { parseModeSpec, type PrefixMode } from '../../../shared/channelModes.js';

// PREFIX as the server hands it over in modeSpec, from the raw 005 token.
function prefixFrom(token: string): PrefixMode[] {
  const m = /^\((.*)\)(.*)$/.exec(token)!;
  const pairs = [...m[1]].map((mode, i) => ({ mode, symbol: m[2][i] }));
  return parseModeSpec({ PREFIX: pairs }).prefix;
}

const LIBERA = prefixFrom('(ov)@+');
const WITH_Y = prefixFrom('(Yqaohv)!~&@%+');

describe('prefixOf', () => {
  it('returns the single highest-ranked glyph', () => {
    expect(prefixOf(['q'], null)).toBe('~');
    expect(prefixOf(['a'], null)).toBe('&');
    expect(prefixOf(['o'], null)).toBe('@');
    expect(prefixOf(['h'], null)).toBe('%');
    expect(prefixOf(['v'], null)).toBe('+');
  });

  it('picks the highest mode regardless of array order', () => {
    expect(prefixOf(['v', 'o'], null)).toBe('@');
    expect(prefixOf(['h', 'v'], null)).toBe('%');
    expect(prefixOf(['o', 'a', 'q'], null)).toBe('~');
  });

  it('returns empty for no recognised modes', () => {
    expect(prefixOf([], null)).toBe('');
    expect(prefixOf(['x', 'b'], null)).toBe('');
  });

  it('tolerates null/undefined modes', () => {
    expect(prefixOf(null, null)).toBe('');
    expect(prefixOf(undefined, LIBERA)).toBe('');
  });

  // #1032: the issue's example network.
  it("reads the glyph from the network's PREFIX", () => {
    expect(prefixOf(['Y'], WITH_Y)).toBe('!');
    expect(prefixOf(['v', 'Y'], WITH_Y)).toBe('!');
    expect(prefixOf(['q'], WITH_Y)).toBe('~');
  });

  it('shows the symbol the network uses for a letter', () => {
    expect(prefixOf(['o'], prefixFrom('(ov)*+'))).toBe('*');
  });

  it("gives no glyph for a letter the network's PREFIX doesn't have", () => {
    // On solanum `q` is a quiet list mode, not an owner prefix.
    expect(prefixOf(['q'], LIBERA)).toBe('');
  });
});

describe('prefixRank', () => {
  it('sorts by PREFIX position, members with no prefix last', () => {
    expect(prefixRank(['Y'], WITH_Y)).toBe(0);
    expect(prefixRank(['q'], WITH_Y)).toBe(1);
    expect(prefixRank(['v'], WITH_Y)).toBe(5);
    expect(prefixRank([], WITH_Y)).toBe(6);
    expect(prefixRank(['o'], LIBERA)).toBeLessThan(prefixRank(['v'], LIBERA));
    expect(prefixRank([], LIBERA)).toBe(2);
  });

  it('falls back to the conventional order before ISUPPORT', () => {
    expect(prefixRank(['q'], null)).toBe(0);
    expect(prefixRank(['v'], null)).toBe(4);
    expect(prefixRank([], null)).toBe(5);
  });
});

describe('prefixClass', () => {
  it("names the colour tier, never the glyph's character", () => {
    expect(prefixClass(['q'], null)).toBe('mode-owner');
    expect(prefixClass(['a'], null)).toBe('mode-admin');
    expect(prefixClass(['o'], null)).toBe('mode-op');
    expect(prefixClass(['h'], null)).toBe('mode-halfop');
    expect(prefixClass(['v'], null)).toBe('mode-voice');
    expect(prefixClass([], null)).toBe('');
  });

  it('keeps op coloured as op on a two-rank network', () => {
    expect(prefixClass(['o'], LIBERA)).toBe('mode-op');
    expect(prefixClass(['v'], LIBERA)).toBe('mode-voice');
    // Another symbol for op is still op.
    expect(prefixClass(['o'], prefixFrom('(ov)*+'))).toBe('mode-op');
  });

  it('colours an unknown letter like the nearest known rank above it', () => {
    // Nothing outranks Y: the owner tier, whatever its symbol.
    expect(prefixClass(['Y'], WITH_Y)).toBe('mode-owner');
    expect(prefixClass(['Y'], prefixFrom('(Yqaohv)@!~*%+'))).toBe('mode-owner');
    expect(prefixClass(['X'], prefixFrom('(qaoXhv)~&@*%+'))).toBe('mode-op');
    expect(prefixClass(['Z'], prefixFrom('(ovZ)@+-'))).toBe('mode-voice');
  });
});

describe('splitChannelToken', () => {
  it('peels rank symbols off a channel', () => {
    expect(splitChannelToken('@#chan', null)).toEqual({ prefix: '@', name: '#chan' });
    expect(splitChannelToken('@+#chan', null)).toEqual({ prefix: '@+', name: '#chan' });
    expect(splitChannelToken('@%#ops', null)).toEqual({ prefix: '@%', name: '#ops' });
    expect(splitChannelToken('~@&ops', null)).toEqual({ prefix: '~@', name: '&ops' });
    expect(splitChannelToken('#chan', null)).toEqual({ prefix: '', name: '#chan' });
  });

  it("uses the network's symbols", () => {
    expect(splitChannelToken('!#chan', WITH_Y)).toEqual({ prefix: '!', name: '#chan' });
    // Without the network's PREFIX `!` is just a channel type.
    expect(splitChannelToken('!#chan', null)).toEqual({ prefix: '', name: '!#chan' });
  });

  it('never peels the channel type itself', () => {
    expect(splitChannelToken('&ops', null)).toEqual({ prefix: '', name: '&ops' });
    expect(splitChannelToken('@&ops', null)).toEqual({ prefix: '@', name: '&ops' });
    expect(splitChannelToken('+chan', null)).toEqual({ prefix: '', name: '+chan' });
    expect(splitChannelToken('!chan', WITH_Y)).toEqual({ prefix: '', name: '!chan' });
  });
});

describe('statusAudience', () => {
  it('names the rank a symbol reaches, and that those above it are in', () => {
    expect(statusAudience('@', null)).toBe('sent only to ops and above');
    expect(statusAudience('+', null)).toBe('sent only to voiced users and above');
    expect(statusAudience('%', null)).toBe('sent only to halfops and above');
  });

  it('has nobody above the top rank', () => {
    expect(statusAudience('~', null)).toBe('sent only to owners');
    expect(statusAudience('@', prefixFrom('(ov)@+'))).toBe('sent only to ops');
  });

  it('falls back to the symbol for a rank it has no word for', () => {
    expect(statusAudience('!', WITH_Y)).toBe('sent only to !');
    expect(statusAudience('?', null)).toBe('sent only to ? and above');
  });
});

describe('statusmsgChannel', () => {
  it('reads one of the network’s STATUSMSG symbols in front of a channel', () => {
    expect(statusmsgChannel('@#chan', '@+')).toBe('#chan');
    expect(statusmsgChannel('+&local', '@+')).toBe('&local');
  });

  it('is nothing for a channel, a nick, or a symbol the network does not take', () => {
    expect(statusmsgChannel('#chan', '@+')).toBeNull();
    expect(statusmsgChannel('+chan', '@+')).toBeNull();
    expect(statusmsgChannel('@bob', '@+')).toBeNull();
    expect(statusmsgChannel('%#chan', '@+')).toBeNull();
    expect(statusmsgChannel('@#chan', '')).toBeNull();
    expect(statusmsgChannel('', '@+')).toBeNull();
  });
});
