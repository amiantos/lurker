// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import {
  nickColor,
  splitTextByTokens,
  segmentInlineStyle,
  segmentHasStyle,
  MIRC_PALETTE_FALLBACK,
} from './nickColor.js';
import { getOption } from '../../../shared/settingsRegistry.js';

// IRC formatting control bytes used to build test fixtures.
const C = '\x03'; // colour
const HEX = '\x04'; // truecolour
const REV = '\x16'; // reverse
const RESET = '\x0f'; // reset all
const BOLD = '\x02';

// Run the formatting-only path (no nick set / colouring).
function parse(text: string) {
  return splitTextByTokens(text, null, null, null);
}

describe('MIRC_PALETTE_FALLBACK', () => {
  // Every slot is a literal, and this is the test that keeps it that way.
  //
  // It has been narrowed once already, to "no var(--bg)", on the theory that
  // theme references were right for the mono-ish slots and only the background
  // could ever match its own surface. That theory is wrong, and this is the
  // second time round: a run carries its OWN background, so var(--fg) collides
  // just as thoroughly the moment a sender writes `\x0300,01`. Worse, slot 0
  // can BE the background (`\x0301,00`), and then a foreground reference paints
  // the box.
  //
  // So: no var(), no color-mix(), nothing that has to be resolved against a
  // surface to know what it is. A colour code names a colour. If the named
  // colour is invisible on the reader's canvas, that is the sender's doing and
  // it is allowed to look that way.
  it('is entirely literal colours', () => {
    for (const [i, entry] of MIRC_PALETTE_FALLBACK.entries()) {
      expect(entry, `slot ${i}`).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('has all 16 slots', () => {
    expect(MIRC_PALETTE_FALLBACK).toHaveLength(16);
  });

  // Two copies exist: this one (the render-time fallback) and the registry
  // default the user's customisable palette starts from. They are the same
  // palette, and a drift between them means chat renders one way until the user
  // opens Settings and a different way afterwards.
  it('matches the look.color.mirc_colors registry default exactly', () => {
    const opt = getOption('look.color.mirc_colors');
    expect(opt?.default).toEqual([...MIRC_PALETTE_FALLBACK]);
  });
});

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
  it('emits a single spoiler segment when fg equals bg, preserving the chosen colour', () => {
    const segs = parse(`${C}01,01secret${C}`);
    expect(segs).toEqual([{ text: 'secret', spoiler: true, fg: 1 }]);
  });

  it('treats any matching fg/bg pair as a spoiler, not just 01,01', () => {
    const segs = parse(`${C}04,04hidden${C}`);
    expect(segs).toEqual([{ text: 'hidden', spoiler: true, fg: 4 }]);
  });

  it('does not split a URL out of a spoiler run (no leak)', () => {
    const segs = parse(`${C}01,01see https://example.com${C}`);
    expect(segs).toHaveLength(1);
    expect(segs[0]).toEqual({ text: 'see https://example.com', spoiler: true, fg: 1 });
    expect(segs[0].url).toBeUndefined();
  });

  it('keeps active bold/italic toggles on the spoiler segment', () => {
    const segs = parse(`${BOLD}${C}01,01x${C}`);
    expect(segs).toEqual([{ text: 'x', spoiler: true, fg: 1, bold: true }]);
  });

  it('does not treat differing fg/bg as a spoiler', () => {
    const segs = parse(`${C}01,02x${C}`);
    expect(segs).toEqual([{ text: 'x', fg: 1, bg: 2 }]);
  });
});

// \x04RRGGBB[,RRGGBB] names its colour outright, and is kept like a \x03 slot
// (#558): the same rules for a bare code and a foreground alone.
describe('splitTextByTokens — truecolour', () => {
  it('keeps both foreground and background, as lowercase #rrggbb', () => {
    expect(parse(`${HEX}FF0000,00ff00hi${HEX}`)).toEqual([
      { text: 'hi', fg: '#ff0000', bg: '#00ff00' },
    ]);
  });

  it('leaves the background unchanged when it sets only a foreground', () => {
    expect(parse(`${C}04,01a${HEX}ff0000b`)).toEqual([
      { text: 'a', fg: 4, bg: 1 },
      { text: 'b', fg: '#ff0000', bg: 1 },
    ]);
  });

  it('resets both on a bare \\x04', () => {
    expect(parse(`${HEX}ff0000,00ff00a${HEX}b`)).toEqual([
      { text: 'a', fg: '#ff0000', bg: '#00ff00' },
      { text: 'b' },
    ]);
  });

  it('leaves a comma that no colour follows in the text', () => {
    expect(parse(`${HEX}ff0000,zz`)).toEqual([{ text: ',zz', fg: '#ff0000' }]);
  });

  it('hides an equal pair, like an equal slot pair', () => {
    expect(parse(`${HEX}112233,112233secret${HEX}`)).toEqual([
      { text: 'secret', spoiler: true, fg: '#112233' },
    ]);
  });
});

// \x16 is a toggle the renderer applies (#558); the runs only carry it.
describe('splitTextByTokens — reverse', () => {
  it('toggles on and off', () => {
    expect(parse(`a${REV}b${REV}c`)).toEqual([
      { text: 'a' },
      { text: 'b', reverse: true },
      { text: 'c' },
    ]);
  });

  it('is cleared by \\x0F', () => {
    expect(parse(`${REV}a${RESET}b`)).toEqual([{ text: 'a', reverse: true }, { text: 'b' }]);
  });

  it("keeps the run's own colours for the renderer to swap", () => {
    expect(parse(`${C}04,01${REV}x`)).toEqual([{ text: 'x', reverse: true, fg: 4, bg: 1 }]);
  });

  it('leaves an equal pair a spoiler', () => {
    expect(parse(`${REV}${C}04,04x`)).toEqual([{ text: 'x', spoiler: true, fg: 4 }]);
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

  it('ignores a token that trims down to just the bare prefix', () => {
    // "#." matches the regex but trims to "#" — not enough to be a channel.
    expect(parse('look at #. ok')).toEqual([{ text: 'look at #. ok' }]);
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

  it('does not treat a bare "#" as a channel', () => {
    expect(parse('a # b')).toEqual([{ text: 'a # b' }]);
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
  it('maps fg and bg codes to CSS colours via the fallback palette', () => {
    // No palette argument → fall back to MIRC_PALETTE_FALLBACK. Slot 4 is
    // red, slot 8 is yellow.
    expect(segmentInlineStyle({ text: 'x', fg: 4, bg: 8 }, null)).toEqual({
      color: '#ff6188',
      backgroundColor: '#ffd866',
      padding: 'var(--mirc-bg-bleed) 0',
    });
  });

  // The bleed rides with the background and nothing else. Stacked coloured rows
  // need it to form a solid field rather than a striped one; a run with only a
  // foreground has no fill to extend, and padding there would widen the hit
  // area for no paint.
  //
  // ⚠ The vertical-only shorthand is the whole trick. A horizontal value would
  // push the run past its own characters and shear ASCII art off the monospace
  // grid — the exact bug removed from the spoiler box.
  it('bleeds the background vertically, and only when there is one', () => {
    expect(segmentInlineStyle({ text: 'x', fg: 4, bg: 8 }, null).padding).toBe(
      'var(--mirc-bg-bleed) 0',
    );
    expect(segmentInlineStyle({ text: 'x', fg: 4 }, null).padding).toBeUndefined();
    expect(segmentInlineStyle({ text: 'x' }, null).padding).toBeUndefined();
  });

  it('renders a background even when the foreground is the default (99)', () => {
    // \x0399,01 — default text on the "black" slot. Black is a literal colour,
    // not var(--bg): a slot that resolved to the surface it's painted on would
    // render as no box at all.
    const style = segmentInlineStyle({ text: 'x', fg: 99, bg: 1 }, null);
    expect(style.color).toBeUndefined();
    expect(style.backgroundColor).toBe('#000000');
  });

  it('honours a caller-supplied palette over the fallback', () => {
    const palette = Array(16).fill('#abcdef');
    palette[4] = '#deadbe';
    const style = segmentInlineStyle({ text: 'x', fg: 4 }, null, palette);
    expect(style.color).toBe('#deadbe');
  });

  it('reports a background-only segment as styled', () => {
    expect(segmentHasStyle({ text: 'x', bg: 8 })).toBe(true);
    expect(segmentHasStyle({ text: 'x' })).toBe(false);
  });
});

describe('segmentInlineStyle — truecolour and reverse', () => {
  it('paints a truecolour pair as sent', () => {
    expect(segmentInlineStyle({ text: 'x', fg: '#ff0000', bg: '#00ff00' }, null)).toEqual({
      color: '#ff0000',
      backgroundColor: '#00ff00',
      padding: 'var(--mirc-bg-bleed) 0',
    });
  });

  it('swaps a full pair', () => {
    // Slot 4 is red, slot 8 is yellow.
    expect(segmentInlineStyle({ text: 'x', fg: 4, bg: 8, reverse: true }, null)).toEqual({
      color: '#ffd866',
      backgroundColor: '#ff6188',
      padding: 'var(--mirc-bg-bleed) 0',
    });
  });

  // Reverse on plain text is the theme inverted, not nothing: what ASCII art
  // uses \x16 for when it draws blocks in the reader's own colours.
  it("swaps an unset side with the theme's own colour", () => {
    expect(segmentInlineStyle({ text: 'x', reverse: true }, null)).toEqual({
      color: 'var(--bg)',
      backgroundColor: 'var(--fg)',
      padding: 'var(--mirc-bg-bleed) 0',
    });
    const fgOnly = segmentInlineStyle({ text: 'x', fg: 4, reverse: true }, null);
    expect(fgOnly.color).toBe('var(--bg)');
    expect(fgOnly.backgroundColor).toBe('#ff6188');
    // An unpaintable slot is as good as unset.
    const defaultFg = segmentInlineStyle({ text: 'x', fg: 99, bg: 8, reverse: true }, null);
    expect(defaultFg.color).toBe('#ffd866');
    expect(defaultFg.backgroundColor).toBe('var(--fg)');
  });

  it("swaps a nick's colour, which is that text's foreground", () => {
    const style = segmentInlineStyle({ text: 'bob', color: '#123456', reverse: true }, null);
    expect(style.color).toBe('var(--bg)');
    expect(style.backgroundColor).toBe('#123456');
  });

  it('reports a reversed segment as styled', () => {
    expect(segmentHasStyle({ text: 'x', reverse: true })).toBe(true);
  });
});

describe('splitTextByTokens — emoji shortcodes', () => {
  // A stand-in for the emoji table so the render-time pass is deterministic
  // without loading the real ~1,900-entry chunk. The real resolver (emojiGlyph)
  // is exercised in emojiShortcodes.test.ts.
  const FAKE: Record<string, string> = {
    smile: '😄',
    tada: '🎉',
    '+1': '👍',
    'e-mail': '📧',
  };
  const emoji = (name: string): string | null => FAKE[name.toLowerCase()] ?? null;
  const parseEmoji = (text: string) => splitTextByTokens(text, null, null, null, emoji);

  it('replaces a known :shortcode: with its glyph', () => {
    expect(parseEmoji(':smile:')).toEqual([{ text: '😄' }]);
  });

  it('replaces a shortcode mid-sentence, keeping the surrounding text', () => {
    expect(parseEmoji('well :tada: done')).toEqual([
      { text: 'well ' },
      { text: '🎉' },
      { text: ' done' },
    ]);
  });

  it('matches a case-insensitive shortcode', () => {
    expect(parseEmoji(':TADA:')).toEqual([{ text: '🎉' }]);
  });

  it('handles + and - inside the shortcode name', () => {
    expect(parseEmoji('nice :+1: then :e-mail:')).toEqual([
      { text: 'nice ' },
      { text: '👍' },
      { text: ' then ' },
      { text: '📧' },
    ]);
  });

  it('converts adjacent shortcodes', () => {
    expect(parseEmoji(':+1::+1:')).toEqual([{ text: '👍' }, { text: '👍' }]);
  });

  it('leaves an unknown shortcode literal', () => {
    expect(parseEmoji('what :nope: is')).toEqual([{ text: 'what :nope: is' }]);
  });

  it('does not convert when the opening colon hugs a preceding word char', () => {
    // The composer's boundary rule: "word:smile:" is not a shortcode start.
    expect(parseEmoji('word:smile:')).toEqual([{ text: 'word:smile:' }]);
  });

  it('does not convert a clock like 12:00:00', () => {
    expect(parseEmoji('at 12:00:00 sharp')).toEqual([{ text: 'at 12:00:00 sharp' }]);
  });

  it('passes text through unchanged when no emojiFn is supplied', () => {
    // The 4-arg form (LinkedText pre-load, composer-less callers) never converts.
    expect(splitTextByTokens(':smile:', null, null, null)).toEqual([{ text: ':smile:' }]);
  });

  it('carries active IRC formatting onto an emoji glyph', () => {
    expect(splitTextByTokens(`${BOLD}:tada:`, null, null, null, emoji)).toEqual([
      { text: '🎉', bold: true },
    ]);
  });

  it('runs after channel splitting — a shortcode after a #channel still converts', () => {
    expect(parseEmoji('#chan :tada:')).toEqual([
      { text: '#chan', channel: '#chan' },
      { text: ' ' },
      { text: '🎉' },
    ]);
  });

  it('still colours a nick that follows an emoji', () => {
    const nickSet = new Set(['alice']);
    const color = (n: string): string | null => (n.toLowerCase() === 'alice' ? '#f00' : null);
    expect(splitTextByTokens(':tada: alice', nickSet, null, color, emoji)).toEqual([
      { text: '🎉' },
      { text: ' ' },
      { text: 'alice', color: '#f00', self: false },
    ]);
  });
});

describe('splitTextByTokens — <angle-bracketed> URLs', () => {
  // RFC 3986 Appendix C's delimiter convention. Discord reads it as "link, but no unfurl", and
  // Lurker does the same — `previewableUrls` refuses to resolve what the brackets wrap. Here the
  // job is the other half: the brackets are plumbing, so they are not rendered.

  it('renders the link without its brackets', () => {
    expect(parse('<https://example.com>')).toEqual([
      { text: 'https://example.com', url: 'https://example.com' },
    ]);
  });

  it('keeps the surrounding prose, minus the brackets', () => {
    expect(parse('see <https://example.com> for more')).toEqual([
      { text: 'see ' },
      { text: 'https://example.com', url: 'https://example.com' },
      { text: ' for more' },
    ]);
  });

  it('does NOT trim trailing punctuation inside brackets', () => {
    // ⚠⚠ The whole point of the convention: the author has said where the address ends, so it is
    // not guessed at. Unbracketed, that period is sentence punctuation and comes off.
    expect(parse('<https://example.com/a.>')).toEqual([
      { text: 'https://example.com/a.', url: 'https://example.com/a.' },
    ]);
    expect(parse('https://example.com/a.')).toEqual([
      { text: 'https://example.com/a', url: 'https://example.com/a' },
      { text: '.' },
    ]);
  });

  it('leaves a lone bracket alone, since it is ordinary prose', () => {
    expect(parse('a < https://example.com')).toEqual([
      { text: 'a < ' },
      { text: 'https://example.com', url: 'https://example.com' },
    ]);
    expect(parse('<https://example.com')).toEqual([
      { text: '<' },
      { text: 'https://example.com', url: 'https://example.com' },
    ]);
  });

  it('emits no empty segment where the opening bracket was', () => {
    // Dropping the `<` can leave nothing between the previous token and the link — a message that
    // IS a bracketed link starts its URL at index 1 — and an empty text segment is one more node
    // for the renderer to walk on every row.
    expect(parse('<https://example.com>').every((s) => s.text !== '')).toBe(true);
  });

  it('applies to a bare www host too, which is the same convention', () => {
    expect(parse('<www.example.com>')).toEqual([
      { text: 'www.example.com', url: 'http://www.example.com' },
    ]);
  });
  it('keeps the brackets around a bare email address, which are prose', () => {
    // `<a@b.com>` is the mail-address convention, not the URL one: the brackets are part of what
    // was written, as in a git trailer.
    expect(parse('mail me at <foo@bar.com> ok')).toEqual([
      { text: 'mail me at <' },
      { text: 'foo@bar.com', url: 'mailto:foo@bar.com' },
      { text: '> ok' },
    ]);
    expect(parse('Co-Authored-By: X <a@b.com>')).toEqual([
      { text: 'Co-Authored-By: X <' },
      { text: 'a@b.com', url: 'mailto:a@b.com' },
      { text: '>' },
    ]);
  });

  it('still treats a bracketed www host with an @ in its path as a URL', () => {
    expect(parse('<www.example.com/@alice>')).toEqual([
      { text: 'www.example.com/@alice', url: 'http://www.example.com/@alice' },
    ]);
  });

  it('still treats a bracketed mailto: as the URL convention', () => {
    expect(parse('<mailto:foo@bar.com>')).toEqual([
      { text: 'mailto:foo@bar.com', url: 'mailto:foo@bar.com' },
    ]);
  });
});

describe('splitTextByTokens — a trailing ellipsis', () => {
  it('is sentence punctuation, not part of the URL', () => {
    // macOS substitutes `…` for `...` as you type, so this is how a trailing-off sentence arrives.
    expect(parse('see https://example.com/a…')).toEqual([
      { text: 'see ' },
      { text: 'https://example.com/a', url: 'https://example.com/a' },
      { text: '…' },
    ]);
  });

  it('is kept when it sits inside the path', () => {
    expect(parse('https://example.com/a…b')).toEqual([
      { text: 'https://example.com/a…b', url: 'https://example.com/a…b' },
    ]);
  });
});

describe('nickColor — hash', () => {
  // Named after The Lounge's classes, so a result reads as the class a nick
  // gets there: `.user.color-N` is palette slot N - 1.
  const lounge = Array.from({ length: 32 }, (_, i) => `color-${i + 1}`);
  const asLounge = (nick: string, stopChars = '') =>
    nickColor(nick, { palette: lounge, stopChars, hash: 'sum' });

  // Expected values are The Lounge's own arithmetic, worked by hand from
  // colorClass.ts: 1 + (sum of charCodeAt) % 32.
  it('sum gives a nick its class from The Lounge', () => {
    expect(asLounge('alice')).toBe('color-31'); // 510 % 32 = 30
    expect(asLounge('bob')).toBe('color-20'); // 307 % 32 = 19
    expect(asLounge('Bob')).toBe('color-20'); // 275 % 32 = 19
    expect(asLounge('bob_')).toBe('color-19'); // 402 % 32 = 18
  });

  it('sum does not lowercase', () => {
    // U+0178 is 376, its lowercase U+00FF is 255: slots 24 and 31.
    expect(asLounge('\u0178')).toBe('color-25');
    expect(asLounge('\u00ff')).toBe('color-32');
  });

  it('sum adds UTF-16 code units, not code points', () => {
    // U+1F600 is D83D + DE00 = 112189, slot 29. The code point alone is slot 0.
    expect(asLounge('\u{1F600}')).toBe('color-30');
  });

  it('sum still honours stop chars, so parity needs them cleared', () => {
    expect(asLounge('bob_', '_|')).toBe('color-20');
  });

  it('djb2-32 is the default and is unchanged by the option', () => {
    const palette = getOption('look.nick.colors')?.default as string[];
    const bare = nickColor('Alice_', { palette, stopChars: '_|' });
    expect(bare).not.toBeNull();
    expect(nickColor('alice', { palette, stopChars: '_|', hash: 'djb2-32' })).toBe(bare);
  });

  it('the registry offers both hashes and defaults to djb2-32', () => {
    const opt = getOption('look.nick.color_hash');
    expect(opt?.type === 'enum' && opt.choices).toEqual(['djb2-32', 'sum']);
    expect(opt?.default).toBe('djb2-32');
  });
});
