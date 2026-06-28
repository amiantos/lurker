// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { parseRelayCommand } from './relay.js';

describe('parseRelayCommand', () => {
  it('treats no args as list', () => {
    expect(parseRelayCommand('')).toEqual({ kind: 'list' });
    expect(parseRelayCommand('   ')).toEqual({ kind: 'list' });
  });

  it('parses explicit list (and ls alias)', () => {
    expect(parseRelayCommand('list')).toEqual({ kind: 'list' });
    expect(parseRelayCommand('ls')).toEqual({ kind: 'list' });
  });

  it('parses add with no custom pattern', () => {
    expect(parseRelayCommand('add relaybot')).toEqual({
      kind: 'add',
      nick: 'relaybot',
      pattern: '',
    });
  });

  it('parses add with a custom template, preserving internal spaces', () => {
    expect(parseRelayCommand('add bridge <{nick}> {message}')).toEqual({
      kind: 'add',
      nick: 'bridge',
      pattern: '<{nick}> {message}',
    });
  });

  it('strips one pair of surrounding quotes from the pattern', () => {
    expect(parseRelayCommand('add bridge "[{source}] <{nick}> {message}"')).toEqual({
      kind: 'add',
      nick: 'bridge',
      pattern: '[{source}] <{nick}> {message}',
    });
  });

  it('accepts mark/set as aliases for add', () => {
    expect(parseRelayCommand('mark b')).toEqual({ kind: 'add', nick: 'b', pattern: '' });
    expect(parseRelayCommand('set b')).toEqual({ kind: 'add', nick: 'b', pattern: '' });
  });

  it('parses remove and its aliases', () => {
    for (const verb of ['remove', 'rm', 'del', 'delete', 'unmark']) {
      expect(parseRelayCommand(`${verb} relaybot`)).toEqual({ kind: 'remove', nick: 'relaybot' });
    }
  });

  it('errors on add/remove without a nick', () => {
    expect(parseRelayCommand('add')).toMatchObject({ kind: 'error' });
    expect(parseRelayCommand('remove')).toMatchObject({ kind: 'error' });
  });

  it('errors on an unknown subcommand', () => {
    const out = parseRelayCommand('frobnicate bot');
    expect(out.kind).toBe('error');
  });
});
