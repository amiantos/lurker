// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { aliasListLines, parseAliasArgs } from './alias.js';

describe('parseAliasArgs', () => {
  it('lists with nothing typed, or by the start of a name', () => {
    expect(parseAliasArgs('  ')).toEqual({ kind: 'list', prefix: '' });
    expect(parseAliasArgs('/W')).toEqual({ kind: 'list', prefix: 'w' });
  });

  it('defines with a name and a body, the body as typed', () => {
    expect(parseAliasArgs('/WII  /whois $1  $1')).toEqual({
      kind: 'set',
      name: 'wii',
      body: '/whois $1  $1',
    });
    expect(parseAliasArgs('pfft /msg p hi; /msg f hi')).toEqual({
      kind: 'set',
      name: 'pfft',
      body: '/msg p hi; /msg f hi',
    });
  });

  it('removes with a dash', () => {
    expect(parseAliasArgs('-wii')).toEqual({ kind: 'remove', name: 'wii' });
    expect(parseAliasArgs('-/WII')).toEqual({ kind: 'remove', name: 'wii' });
  });

  it('says what is wrong with a line it cannot read', () => {
    expect(parseAliasArgs('-wii /whois').kind).toBe('error');
    expect(parseAliasArgs('-').kind).toBe('error');
    expect(parseAliasArgs('alias /quit').kind).toBe('error');
  });

  it('removes a name it would not let you take', () => {
    expect(parseAliasArgs('-alias')).toEqual({ kind: 'remove', name: 'alias' });
    expect(parseAliasArgs('a/b /quit').kind).toBe('error');
  });
});

describe('aliasListLines', () => {
  const aliases = [
    { name: 'j2', body: '/join' },
    { name: 'wii', body: '/whois $1 $1' },
  ];

  it('lines the bodies up under a count', () => {
    expect(aliasListLines(aliases, '')).toEqual([
      'aliases (2):',
      '  /j2   /join',
      '  /wii  /whois $1 $1',
    ]);
  });

  it('narrows to a prefix', () => {
    expect(aliasListLines(aliases, 'w')).toEqual(['aliases (1):', '  /wii  /whois $1 $1']);
  });

  it('says so when there is nothing to list', () => {
    expect(aliasListLines([], '')).toEqual(['no aliases. /alias <name> <command> makes one.']);
    expect(aliasListLines(aliases, 'x')).toEqual(['no alias starts with "x".']);
  });
});
