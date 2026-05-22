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
