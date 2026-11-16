// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from 'vitest';
import { parseRename, RENAME_USAGE } from './rename.js';

const words = (s: string) => s.split(' ').filter(Boolean);

describe('parseRename', () => {
  it('renames the channel it was typed in', () => {
    expect(parseRename(words('#new'), '#old')).toEqual({ line: 'RENAME #old #new' });
  });

  it('carries a reason, spaces and all', () => {
    expect(parseRename(words('#new tidy up the name'), '#old')).toEqual({
      line: 'RENAME #old #new :tidy up the name',
    });
  });

  it('takes the channel to rename first, from anywhere', () => {
    expect(parseRename(words('#old #new'), 'bob')).toEqual({ line: 'RENAME #old #new' });
    expect(parseRename(words('#old #new typo fix'), ':server:1')).toEqual({
      line: 'RENAME #old #new :typo fix',
    });
    // Named explicitly, the buffer it was typed in does not matter.
    expect(parseRename(words('#old #new'), '#elsewhere')).toEqual({ line: 'RENAME #old #new' });
  });

  it('knows all four channel sigils', () => {
    expect(parseRename(words('&lokal'), '&local')).toEqual({ line: 'RENAME &local &lokal' });
    expect(parseRename(words('!old +new'), 'bob')).toEqual({ line: 'RENAME !old +new' });
  });

  it('asks for a name when there is none', () => {
    expect(parseRename([], '#old')).toEqual({ error: RENAME_USAGE });
  });

  it('refuses a new name that is not a channel', () => {
    expect(parseRename(words('newname'), '#old')).toEqual({
      error: `${RENAME_USAGE} — newname is not a channel name`,
    });
  });

  it('has nothing to rename outside a channel unless one is named', () => {
    for (const target of ['bob', ':server:1', ':system:', '=bob']) {
      expect(parseRename(words('#new'), target)).toEqual({
        error: `${RENAME_USAGE} — name the channel, or run it inside one`,
      });
    }
  });

  it('refuses a list where a name belongs', () => {
    expect(parseRename(words('#new,#other'), '#old')).toEqual({
      error: `${RENAME_USAGE} — a channel name cannot hold a comma`,
    });
  });
});
