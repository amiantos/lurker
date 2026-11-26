// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { NICKMETA_USAGE, parseNickMetaCommand, type NickMetaContext } from './nickMetadata.js';

const ctx: NickMetaContext = {
  paletteSize: 4,
  snap: (hex) => (hex === '#ff0000' ? 2 : -1),
  knowsZone: (zone) => zone === 'Europe/Berlin',
};
const parse = (line: string) => parseNickMetaCommand(line, ctx);

describe('/nickmeta', () => {
  it('lists with a nick alone, and says how with nothing', () => {
    expect(parse('bob')).toEqual({ op: 'list', nick: 'bob' });
    expect(parse('  ')).toEqual({ error: NICKMETA_USAGE });
  });

  it('sets a display name with its spaces, or hides theirs', () => {
    expect(parse('bob name Robert  the Third')).toEqual({
      op: 'set',
      nick: 'bob',
      key: 'display-name',
      value: 'Robert  the Third',
    });
    expect(parse('bob displayname HIDE')).toMatchObject({ key: 'display-name', value: null });
    expect(parse('bob name')).toEqual({ error: NICKMETA_USAGE });
  });

  it('only ever hides an avatar', () => {
    expect(parse('bob avatar hide')).toEqual({
      op: 'set',
      nick: 'bob',
      key: 'avatar',
      value: null,
    });
    expect(parse('bob avatar https://example.org/a.png')).toHaveProperty('error');
  });

  it('takes a colour as a palette number from 1, or a hex snapped to the palette', () => {
    expect(parse('bob color 1')).toMatchObject({ key: 'color', value: '0' });
    expect(parse('bob colour 4')).toMatchObject({ key: 'color', value: '3' });
    expect(parse('bob color #ff0000')).toMatchObject({ key: 'color', value: '2' });
    for (const bad of ['0', '5', 'red', '#nothex']) {
      expect(parse(`bob color ${bad}`)).toHaveProperty('error');
    }
  });

  it('takes a time zone the browser knows', () => {
    expect(parse('bob tz Europe/Berlin')).toEqual({
      op: 'set',
      nick: 'bob',
      key: 'lurker.chat/tz',
      value: 'Europe/Berlin',
    });
    expect(parse('bob timezone Berlin')).toHaveProperty('error');
  });

  it('resets a field with a leading dash', () => {
    expect(parse('bob -color')).toEqual({ op: 'reset', nick: 'bob', key: 'color' });
    expect(parse('bob -tz')).toEqual({ op: 'reset', nick: 'bob', key: 'lurker.chat/tz' });
    expect(parse('bob -shoe')).toHaveProperty('error');
    expect(parse('bob shoe 4')).toHaveProperty('error');
  });
});
