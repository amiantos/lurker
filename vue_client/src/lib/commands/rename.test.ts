// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from 'vitest';
import { parseRename, RENAME_USAGE } from './rename.js';

const words = (s: string) => s.split(' ').filter(Boolean);
// The channels the user has buffers for.
const held = new Set(['#old', '&local', '!old']);
const parse = (line: string, target: string) =>
  parseRename(words(line), target, (name) => held.has(name.toLowerCase()));

describe('parseRename', () => {
  it('renames the channel it was typed in', () => {
    expect(parse('#new', '#old')).toEqual({ line: 'RENAME #old #new' });
  });

  it('carries a reason, spaces and all', () => {
    expect(parse('#new tidy up the name', '#old')).toEqual({
      line: 'RENAME #old #new :tidy up the name',
    });
  });

  it('takes the channel to rename first, from anywhere', () => {
    expect(parse('#old #new', 'bob')).toEqual({ line: 'RENAME #old #new' });
    expect(parse('#old #new typo fix', ':server:1')).toEqual({
      line: 'RENAME #old #new :typo fix',
    });
    // Named explicitly, the buffer it was typed in does not matter.
    expect(parse('#old #new', '#elsewhere')).toEqual({ line: 'RENAME #old #new' });
  });

  // The second word is where a reason starts too, and plenty of reasons start
  // with a channel sigil. Read as a name, these would rename #new to `+1`.
  it('reads a second word as the reason unless the first is a channel the user holds', () => {
    expect(parse('#new +1 clearer name', '#old')).toEqual({
      line: 'RENAME #old #new :+1 clearer name',
    });
    expect(parse('#new !!! cleanup', '#old')).toEqual({ line: 'RENAME #old #new :!!! cleanup' });
    expect(parse('#new #1 priority', '#old')).toEqual({ line: 'RENAME #old #new :#1 priority' });
  });

  it('knows all four channel sigils', () => {
    expect(parse('&lokal', '&local')).toEqual({ line: 'RENAME &local &lokal' });
    expect(parse('!old +new', 'bob')).toEqual({ line: 'RENAME !old +new' });
  });

  it('asks for a name when there is none', () => {
    expect(parse('', '#old')).toEqual({ error: RENAME_USAGE });
  });

  it('refuses a new name that is not a channel', () => {
    expect(parse('newname', '#old')).toEqual({
      error: `${RENAME_USAGE} — newname is not a channel name`,
    });
  });

  it('has nothing to rename outside a channel unless one is named', () => {
    for (const target of ['bob', ':server:1', ':system:', '=bob']) {
      expect(parse('#new', target)).toEqual({
        error: `${RENAME_USAGE} — name the channel, or run it inside one`,
      });
    }
  });

  it('refuses a list where a name belongs', () => {
    expect(parse('#new,#other', '#old')).toEqual({
      error: `${RENAME_USAGE} — a channel name cannot hold a comma`,
    });
  });
});
