// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { splitTextByTokens, segmentInlineStyle, segmentHasStyle } from './nickColor.js';

// IRC formatting control bytes used to build test fixtures.
const C = '\x03'; // colour
const RESET = '\x0f'; // reset all
const BOLD = '\x02';

// Run the formatting-only path (no nick set / colouring).
function parse(text: string) {
  return splitTextByTokens(text, null, null, null);
}

describe('splitTextByTokens — background colour', () => {
  it('keeps both foreground and background of a \\x03FG,BG run', () => {
    const segs = parse(`${C}04,08hi${C}`);
    expect(segs).toEqual([{ text: 'hi', fg: 4, bg: 8 }]);
  });

  it('leaves the background unchanged when a later code sets only a foreground', () => {
    // \x0308,02 sets fg+bg; \x0304 then recolours the text but keeps bg=2.
    const segs = parse(`${C}08,02a${C}04b`);
    expect(segs).toEqual([
      { text: 'a', fg: 8, bg: 2 },
      { text: 'b', fg: 4, bg: 2 },
    ]);
  });

  it('resets both fg and bg on a bare \\x03', () => {
    const segs = parse(`${C}04,08a${C}b`);
    expect(segs).toEqual([{ text: 'a', fg: 4, bg: 8 }, { text: 'b' }]);
  });

  it('resets both fg and bg on \\x0F', () => {
    const segs = parse(`${C}04,08a${RESET}b`);
    expect(segs).toEqual([{ text: 'a', fg: 4, bg: 8 }, { text: 'b' }]);
  });
});

describe('splitTextByTokens — spoiler detection', () => {
  it('emits a single spoiler segment when fg equals bg', () => {
    const segs = parse(`${C}01,01secret${C}`);
    expect(segs).toEqual([{ text: 'secret', spoiler: true }]);
  });

  it('treats any matching fg/bg pair as a spoiler, not just 01,01', () => {
    const segs = parse(`${C}04,04hidden${C}`);
    expect(segs).toEqual([{ text: 'hidden', spoiler: true }]);
  });

  it('does not split a URL out of a spoiler run (no leak)', () => {
    const segs = parse(`${C}01,01see https://example.com${C}`);
    expect(segs).toHaveLength(1);
    expect(segs[0]).toEqual({ text: 'see https://example.com', spoiler: true });
    expect(segs[0].url).toBeUndefined();
  });

  it('keeps active bold/italic toggles on the spoiler segment', () => {
    const segs = parse(`${BOLD}${C}01,01x${C}`);
    expect(segs).toEqual([{ text: 'x', spoiler: true, bold: true }]);
  });

  it('does not treat differing fg/bg as a spoiler', () => {
    const segs = parse(`${C}01,02x${C}`);
    expect(segs).toEqual([{ text: 'x', fg: 1, bg: 2 }]);
  });
});

describe('splitTextByTokens — channel detection', () => {
  it('splits a #channel into its own segment carrying a channel field', () => {
    expect(parse('join #general now')).toEqual([
      { text: 'join ' },
      { text: '#general', channel: '#general' },
      { text: ' now' },
    ]);
  });

  it('keeps the whole token for a ##-prefixed channel', () => {
    expect(parse('##python is great')).toEqual([
      { text: '##python', channel: '##python' },
      { text: ' is great' },
    ]);
  });

  it('matches a channel at the very start of the text', () => {
    expect(parse('#foo')).toEqual([{ text: '#foo', channel: '#foo' }]);
  });

  it('keeps dashes and dots inside a channel name', () => {
    expect(parse('try #my-cool.chan ok')).toEqual([
      { text: 'try ' },
      { text: '#my-cool.chan', channel: '#my-cool.chan' },
      { text: ' ok' },
    ]);
  });

  it('stops a channel name at a colon (RFC 2812 chanstring)', () => {
    expect(parse('ping #ops:admins now')).toEqual([
      { text: 'ping ' },
      { text: '#ops', channel: '#ops' },
      { text: ':admins now' },
    ]);
  });

  it('trims trailing sentence punctuation off a channel', () => {
    expect(parse('see (#foo).')).toEqual([
      { text: 'see (' },
      { text: '#foo', channel: '#foo' },
      { text: ').' },
    ]);
  });

  it('does not treat "C#" as a channel — the # follows a word char', () => {
    expect(parse('I write C# daily')).toEqual([{ text: 'I write C# daily' }]);
  });

  it('does not treat the "&" in "AT&T" as a channel', () => {
    expect(parse('call AT&T today')).toEqual([{ text: 'call AT&T today' }]);
  });

  it('does not treat a bare "#" as a channel', () => {
    expect(parse('a # b')).toEqual([{ text: 'a # b' }]);
  });

  it('detects an &-prefixed local channel', () => {
    expect(parse('&local rules')).toEqual([
      { text: '&local', channel: '&local' },
      { text: ' rules' },
    ]);
  });

  it('leaves a # fragment inside a URL alone', () => {
    expect(parse('docs https://example.com/page#install here')).toEqual([
      { text: 'docs ' },
      {
        url: 'https://example.com/page#install',
        text: 'https://example.com/page#install',
      },
      { text: ' here' },
    ]);
  });

  it('carries active IRC formatting onto a channel segment', () => {
    expect(parse(`${BOLD}#bold-chan`)).toEqual([
      { text: '#bold-chan', channel: '#bold-chan', bold: true },
    ]);
  });
});

describe('segmentInlineStyle / segmentHasStyle — background colour', () => {
  it('maps a background code to a backgroundColor', () => {
    expect(segmentInlineStyle({ text: 'x', fg: 4, bg: 8 }, null)).toEqual({
      color: '#ff0000',
      backgroundColor: '#ffff00',
    });
  });

  it('renders a background even when the foreground is the default (99)', () => {
    // \x0399,01 — default text on a black background.
    const style = segmentInlineStyle({ text: 'x', fg: 99, bg: 1 }, null);
    expect(style.color).toBeUndefined();
    expect(style.backgroundColor).toBe('#000000');
  });

  it('reports a background-only segment as styled', () => {
    expect(segmentHasStyle({ text: 'x', bg: 8 })).toBe(true);
    expect(segmentHasStyle({ text: 'x' })).toBe(false);
  });
});
