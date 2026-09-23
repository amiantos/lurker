// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { parseModeSpec } from '../../../shared/channelModes.js';
import { modeChanges, modeRows, topicBytes, type LiveModes } from './channelModeForm.js';
import { patchModeList } from './modeListPatch.js';

// solanum's shape.
const SPEC = parseModeSpec({
  CHANMODES: ['eIbq', 'k', 'flj', 'CFLMPQRSTcgimnprstuz'],
  PREFIX: [
    { mode: 'o', symbol: '@' },
    { mode: 'v', symbol: '+' },
  ],
});
const LIVE: LiveModes = { modes: 'ntkl', params: { l: '50' } };
const on = (value = '') => ({ on: true, value });
const off = { on: false, value: '' };

describe('modeRows', () => {
  it('draws flags and param modes, never list or prefix modes, well-known first', () => {
    const rows = modeRows(SPEC);
    const letters = rows.map((r) => r.letter);
    expect(letters).not.toContain('b');
    expect(letters).not.toContain('o');
    expect(rows.find((r) => r.letter === 'k')?.kind).toBe('key');
    expect(rows.find((r) => r.letter === 'l')?.kind).toBe('param');
    expect(rows.find((r) => r.letter === 'C')).toEqual({ letter: 'C', kind: 'flag', name: null });
    const firstUnnamed = rows.findIndex((r) => r.name === null);
    expect(rows.slice(firstUnnamed).every((r) => r.name === null)).toBe(true);
  });
});

describe('modeChanges', () => {
  it('sends only what the draft changed', () => {
    expect(modeChanges(SPEC, LIVE, { m: on(), t: off, n: on() })).toEqual({
      changes: [
        { sign: '+', letter: 'm' },
        { sign: '-', letter: 't' },
      ],
    });
  });

  it('diffs against the live state, so a row someone else changed meanwhile is left alone', () => {
    // The draft set +m; meanwhile another op set it too. Nothing to send.
    expect(modeChanges(SPEC, { ...LIVE, modes: 'ntklm' }, { m: on() })).toEqual({ changes: [] });
  });

  it('sets, changes and clears a limit', () => {
    const noLimit = { modes: 'nt', params: {} };
    expect(modeChanges(SPEC, noLimit, { l: on('20') })).toEqual({
      changes: [{ sign: '+', letter: 'l', param: '20' }],
    });
    expect(modeChanges(SPEC, LIVE, { l: on('60') })).toEqual({
      changes: [{ sign: '+', letter: 'l', param: '60' }],
    });
    expect(modeChanges(SPEC, LIVE, { l: on('50') })).toEqual({ changes: [] });
    expect(modeChanges(SPEC, LIVE, { l: off })).toEqual({ changes: [{ sign: '-', letter: 'l' }] });
  });

  it('needs a value to set a param mode', () => {
    expect(modeChanges(SPEC, { modes: '', params: {} }, { l: on('') })).toEqual({
      error: 'Enter a value for +l',
    });
    expect(modeChanges(SPEC, LIVE, { l: on('5 0') })).toEqual({ error: "+l can't contain spaces" });
  });

  it('keeps, replaces and removes the key', () => {
    // On with nothing typed: the key it has stays.
    expect(modeChanges(SPEC, LIVE, { k: on('') })).toEqual({ changes: [] });
    // A new key goes out after the old one comes off (467 otherwise).
    expect(modeChanges(SPEC, LIVE, { k: on('hunter3') })).toEqual({
      changes: [
        { sign: '-', letter: 'k' },
        { sign: '+', letter: 'k', param: 'hunter3' },
      ],
    });
    // The field pre-filled with the key we joined with, untouched: keep it.
    const known = { modes: 'ntk', params: { k: 'hunter2' } };
    expect(modeChanges(SPEC, known, { k: on('hunter2') })).toEqual({ changes: [] });
    // Off: the server fills in -k's param.
    expect(modeChanges(SPEC, LIVE, { k: off })).toEqual({ changes: [{ sign: '-', letter: 'k' }] });
    expect(modeChanges(SPEC, { modes: 'nt', params: {} }, { k: on('') })).toEqual({
      error: 'Enter a key',
    });
  });

  it('names the value when unsetting a mode that always takes one', () => {
    const spec = parseModeSpec({ CHANMODES: ['b', 'kL', 'l', 'nt'], PREFIX: [] });
    expect(modeChanges(spec, { modes: 'L', params: { L: '#overflow' } }, { L: off })).toEqual({
      changes: [{ sign: '-', letter: 'L', param: '#overflow' }],
    });
  });

  it('ignores a draft row for a letter the network lacks', () => {
    expect(modeChanges(SPEC, LIVE, { Z: on() })).toEqual({ changes: [] });
  });
});

describe('topicBytes', () => {
  it('counts bytes, as TOPICLEN does', () => {
    expect(topicBytes('abc')).toBe(3);
    expect(topicBytes('héllo')).toBe(6);
    expect(topicBytes('🦀')).toBe(4);
  });
});

const row = (mode: string, param: string, nick = 'op', kind = 'list') => ({
  nick,
  time: '2026-09-23T10:00:00.000Z',
  modes: [{ mode, param, kind }],
});

describe('patchModeList', () => {
  const ENTRIES = [{ mask: '*!*@old', setBy: 'x', setAt: null }];

  it('adds a new mask with its setter and time, and removes one case-insensitively', () => {
    expect(patchModeList(ENTRIES, [row('+b', '*!*@new'), row('-b', '*!*@OLD')], 'b')).toEqual([
      { mask: '*!*@new', setBy: 'op', setAt: '2026-09-23T10:00:00.000Z' },
    ]);
  });

  it("leaves other lists' and non-list changes alone, and doesn't add a mask twice", () => {
    expect(
      patchModeList(
        ENTRIES,
        [row('+e', '*!*@x'), row('+o', 'alice', 'op', 'prefix'), row('+b', '*!*@OLD')],
        'b',
      ),
    ).toEqual(ENTRIES);
  });
});
