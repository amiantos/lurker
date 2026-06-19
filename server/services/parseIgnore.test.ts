// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { parseIgnoreArgs, durationToExpiry } from '../../shared/parseIgnore.js';

const NOW = Date.parse('2026-06-18T00:00:00.000Z');
const p = (s: string) => parseIgnoreArgs(s, NOW);

describe('parseIgnoreArgs — masks & levels', () => {
  it('bare nick defaults to ALL', () => {
    expect(p('bob')).toMatchObject({ mask: 'bob', levels: ['ALL'], channels: null, pattern: null });
  });

  it('NOHIGHLIGHT level (must-have #1), Lurker spelling + irssi aliases', () => {
    // Lurker's native term (and its plural) plus irssi's NOHILIGHT all resolve
    // to the canonical NOHIGHLIGHT.
    expect(p('bob NOHIGHLIGHT')).toMatchObject({ mask: 'bob', levels: ['NOHIGHLIGHT'] });
    expect(p('bob NOHIGHLIGHTS').levels).toEqual(['NOHIGHLIGHT']);
    expect(p('bob NOHILIGHT').levels).toEqual(['NOHIGHLIGHT']);
  });

  it('* mask normalizes to null (anyone)', () => {
    expect(p('* JOINS')).toMatchObject({ mask: null, levels: ['JOINS'] });
  });

  it('keeps a glob mask verbatim', () => {
    expect(p('*zzz* NICKS')).toMatchObject({ mask: '*zzz*', levels: ['NICKS'] });
  });

  it('accepts singular/plural level aliases', () => {
    expect(p('bob publics').levels).toEqual(['PUBLIC']);
    expect(p('bob join part').levels).toEqual(['JOINS', 'PARTS']);
  });
});

describe('parseIgnoreArgs — content + channel (must-have #2)', () => {
  it('-regexp -pattern (...) #channel', () => {
    expect(p('-regexp -pattern (word1|word2) #channel')).toMatchObject({
      mask: null,
      channels: ['#channel'],
      pattern: '(word1|word2)',
      patternKind: 'regex',
      levels: ['ALL'],
    });
  });

  it('-full with a quoted multi-word pattern', () => {
    expect(p('-full -pattern "two words" PUBLIC')).toMatchObject({
      pattern: 'two words',
      patternKind: 'full',
      levels: ['PUBLIC'],
    });
  });

  it('default pattern kind is substring', () => {
    expect(p('-pattern spam').patternKind).toBe('substr');
  });
});

describe('parseIgnoreArgs — subtractive levels', () => {
  it('ALL -PUBLIC -ACTIONS expands then removes', () => {
    const r = p('#irssi ALL -PUBLIC -ACTIONS');
    expect(r.channels).toEqual(['#irssi']);
    expect(r.levels).not.toContain('PUBLIC');
    expect(r.levels).not.toContain('ACTIONS');
    expect(r.levels).toContain('JOINS');
    expect(r.levels).toContain('MSGS');
  });
});

describe('parseIgnoreArgs — flags & errors', () => {
  it('-except sets the whitelist flag', () => {
    expect(p('-except *!*@*.irssi.org CTCPS')).toMatchObject({
      mask: '*!*@*.irssi.org',
      isExcept: true,
      levels: ['CTCPS'],
    });
  });

  it('-time computes expiresAt from now', () => {
    expect(p('-time 5days christmas PUBLICS')).toMatchObject({
      mask: 'christmas',
      levels: ['PUBLIC'],
      expiresAt: '2026-06-23T00:00:00.000Z',
    });
    expect(p('-time 300 mike').expiresAt).toBe('2026-06-18T00:05:00.000Z');
  });

  it('rejects an absurd -time instead of overflowing Date (no RangeError)', () => {
    expect(p('-time 99999999999999999999 bob').error).toMatch(/time/);
  });

  it('rejects -replies as unsupported', () => {
    expect(p('-replies *!*@*.irssi.org ALL').error).toMatch(/replies/);
  });

  it('rejects an unknown flag and a missing -pattern value', () => {
    expect(p('-bogus bob').error).toMatch(/unknown flag/);
    expect(p('bob -pattern').error).toMatch(/pattern/);
  });
});

describe('parseIgnoreArgs — scope (#350)', () => {
  it('defaults to global (scopeNetwork false)', () => {
    expect(p('bob').scopeNetwork).toBe(false);
  });

  it('-network / -net scope to the current network', () => {
    expect(p('-network bob').scopeNetwork).toBe(true);
    expect(p('-net bob NOHIGHLIGHT').scopeNetwork).toBe(true);
  });

  it('-global is the explicit default', () => {
    expect(p('-global bob').scopeNetwork).toBe(false);
  });

  it('scope flags do not leak into the other dimensions', () => {
    expect(p('-network bob JOINS')).toMatchObject({
      mask: 'bob',
      levels: ['JOINS'],
      scopeNetwork: true,
    });
  });
});

describe('durationToExpiry (#350) — shared by the settings pane', () => {
  it('computes an ISO expiry from a duration string', () => {
    expect(durationToExpiry('7 days', NOW)).toBe('2026-06-25T00:00:00.000Z');
    expect(durationToExpiry('300', NOW)).toBe('2026-06-18T00:05:00.000Z');
  });

  it('returns null for an unparseable or empty duration', () => {
    expect(durationToExpiry('soon', NOW)).toBeNull();
    expect(durationToExpiry('', NOW)).toBeNull();
  });
});
