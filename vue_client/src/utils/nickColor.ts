// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { createUrlRegex } from '../../../shared/urlPattern.js';
import { shortcodeScanRegex } from './emojiShortcodes.js';

// Deterministic nick coloring: trim stop chars, hash, modulo a palette.
//
// Palette, stop-chars and hash come from settings (look.nick.colors,
// look.nick.color_stop_chars, look.nick.color_hash); see
// shared/settingsRegistry.ts.
//
// Two hashes:
//   djb2-32  weechat's gui_nick_find_color. The nick is lowercased first.
//   sum      The Lounge's colorClass: UTF-16 code units added up, and the nick
//            is NOT lowercased. With The Lounge's 32 colors and no stop chars
//            a nick gets the color it has there (#1446).

function trimForColor(nick: string, stopChars: string): string {
  let out = '';
  let seenOther = false;
  for (const ch of nick) {
    const isStop = stopChars.includes(ch);
    if (isStop && seenOther) break;
    if (!isStop) seenOther = true;
    out += ch;
  }
  return out;
}

function djb2(str: string): number {
  let h = 5381 >>> 0;
  for (const ch of str) {
    const cp = ch.codePointAt(0) as number;
    const term = (((h << 5) >>> 0) + (h >>> 2) + cp) >>> 0;
    h = (h ^ term) >>> 0;
  }
  return h;
}

// The Lounge walks charCodeAt, so an astral character counts as its two
// surrogates. Summing code points would move those nicks to another color.
function sumCodeUnits(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) h += str.charCodeAt(i);
  return h;
}

export type NickColorHash = 'djb2-32' | 'sum';

interface NickColorOptions {
  palette: string[];
  stopChars: string;
  hash?: NickColorHash;
}

export function nickColor(
  nick: string | null | undefined,
  { palette, stopChars, hash }: NickColorOptions,
): string | null {
  if (!nick) return null;
  if (!palette || palette.length === 0) return null;
  const trimmed = trimForColor(nick, stopChars || '');
  if (!trimmed) return null;
  const index = hash === 'sum' ? sumCodeUnits(trimmed) : djb2(trimmed.toLowerCase());
  return palette[index % palette.length];
}

// Chars that can appear inside an IRC nick (RFC 2812 plus the usual extensions).
// A match against `nickSet` only counts when neither neighbour is one of these,
// so "bob" inside "bobby" won't match.
const NICK_CHAR_CLASS = '[A-Za-z0-9_\\-\\[\\]\\\\^{|}]';

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// URL detection lives in shared/urlPattern.ts so the server's highlight
// engine can exclude links from highlight matching using the same definition.
// trimTrailingPunctuation (below) then strips trailing sentence punctuation so
// "see https://example.com." doesn't keep the period.

// Strip trailing punctuation that's almost certainly part of the surrounding
// sentence rather than the token. Closing brackets are only stripped when
// they'd be unbalanced inside the token — `https://en.wikipedia.org/wiki/Foo_(bar)`
// keeps its trailing ')', but `(see https://example.com)` doesn't. Shared by
// the URL and channel-name splitters.
export function trimTrailingPunctuation(s: string): string {
  const PAIRS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  let end = s.length;
  while (end > 0) {
    const ch = s[end - 1];
    // ⚠ `…` is sentence punctuation too: macOS substitutes it for `...` as you type, so
    // `see https://example.com/a…` otherwise links to an address ending in an ellipsis.
    if ('.,;:!?\'"…'.includes(ch)) {
      end--;
      continue;
    }
    if (ch in PAIRS) {
      const opens = PAIRS[ch];
      let oc = 0;
      let cc = 0;
      for (let i = 0; i < end - 1; i++) {
        if (s[i] === opens) oc++;
        else if (s[i] === ch) cc++;
      }
      // The current trailing char would push closes past opens.
      if (cc >= oc) {
        end--;
        continue;
      }
    }
    break;
  }
  return s.slice(0, end);
}

// Bare email: "name@host.tld" with no scheme. The [^:]+@ guard rules out
// strings that already have a scheme prefix (mailto:, http://user@host), and
// a www. host wins even with an @ in its path (www.example.com/@alice).
function isBareEmail(matched: string): boolean {
  return !/^www\./i.test(matched) && /^[^:]+@/.test(matched);
}

function urlHref(matched: string): string {
  if (/^www\./i.test(matched)) return `http://${matched}`;
  if (isBareEmail(matched)) return `mailto:${matched}`;
  return matched;
}

/**
 * Whether a URL match is wrapped in angle brackets — `<https://example.com>`.
 *
 * The convention is RFC 3986 Appendix C's: brackets delimit a URL so a reader (and a parser)
 * doesn't have to guess where it ends inside prose. Discord borrowed it as "link, but no
 * unfurl", and that is the meaning both callers here implement — `splitTextByUrls` strips the
 * brackets from the rendered text, and `previewableUrls` refuses to resolve what they wrap.
 *
 * ⚠⚠ The end test uses the UNTRIMMED match. `trimTrailingPunctuation` eats the `.` off
 * `<https://example.com/a.>`, so measuring from the trimmed length looks one character short of
 * the `>` and the brackets stop being recognised on exactly the URLs whose ends are ambiguous —
 * which is the case the convention exists for.
 *
 * ⚠⚠ A bare email address never counts.
 * `<foo@bar.com>` is the mail-address convention (`Co-Authored-By: X <a@b.com>`), where the
 * brackets are part of what was written, and treating them as plumbing dropped them from the
 * rendered line. `<www.example.com>` is the URL convention all the same.
 */
export function isBracketedUrl(text: string, index: number, rawMatch: string): boolean {
  // `text[-1]` is undefined rather than an error, so a match at position 0 falls out here.
  return (
    text[index - 1] === '<' &&
    text[index + rawMatch.length] === '>' &&
    // urlHref's own classifier, so a scheme added to the shared pattern can't silently fall out
    // of the convention.
    !isBareEmail(rawMatch)
  );
}

interface UrlSegment {
  kind: 'url';
  text: string;
  href: string;
}

interface TextSegment {
  kind: 'text';
  text: string;
}

type UrlOrTextSegment = UrlSegment | TextSegment;

// Split text on URL matches, yielding segments tagged with kind so the caller
// can dispatch (URL segments need an <a>; text segments still need a nick pass).
function splitTextByUrls(text: string): UrlOrTextSegment[] {
  const out: UrlOrTextSegment[] = [];
  if (!text) return out;
  const re = createUrlRegex();
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const start = m.index;
    // ⚠ Inside brackets the whole match is the URL, with NO trailing-punctuation trim. That is
    // the entire point of the convention: the author has stated where the address ends, so
    // `<https://en.wikipedia.org/wiki/Foo.>` keeps its period instead of having it guessed away.
    const bracketed = isBracketedUrl(text, start, m[0]);
    const matched = bracketed ? m[0] : trimTrailingPunctuation(m[0]);
    if (!matched) {
      // The whole match was punctuation (shouldn't happen given the regex
      // requires a scheme/www prefix, but guard anyway).
      re.lastIndex = start + 1;
      continue;
    }
    // The brackets themselves are plumbing and are not rendered, so both the scan position and
    // the preceding text segment step over them.
    re.lastIndex = start + matched.length + (bracketed ? 1 : 0);
    // ⚠ Emptiness checked rather than `start > lastIdx`. Dropping the `<` can leave nothing at
    // all between the previous token and this one — a message that IS a bracketed link starts at
    // index 1 — and an empty text segment renders as an extra node for the renderer to walk.
    const before = text.slice(lastIdx, bracketed ? start - 1 : start);
    if (before) out.push({ kind: 'text', text: before });
    out.push({ kind: 'url', text: matched, href: urlHref(matched) });
    lastIdx = start + matched.length + (bracketed ? 1 : 0);
  }
  if (lastIdx < text.length) out.push({ kind: 'text', text: text.slice(lastIdx) });
  return out;
}

interface ChannelSegment {
  kind: 'channel';
  text: string;
}

type ChannelOrTextSegment = ChannelSegment | TextSegment;

// Split text on IRC channel names. A channel token is a `#` prefix followed
// by a run of characters valid in an IRC channel name: per RFC 2812 that
// rules out whitespace, commas, and colons (`:` begins the optional channel
// mask). Trailing sentence punctuation is trimmed the same way URLs are. The
// prefix must not sit directly after a word character, so "C#" doesn't read
// as a channel. `##anime`-style double-hash names work because the second
// `#` is just an ordinary body character. `&`-prefixed local channels and
// other rare prefixes aren't supported here, matching the rest of the app
// (BufferList sort/render, the buffer-actions menu, etc.) which all
// hard-code `#`. Runs on text that has already had URLs split out, so a
// `#anchor` inside a link never reaches this pass.
function splitTextByChannels(text: string): ChannelOrTextSegment[] {
  const out: ChannelOrTextSegment[] = [];
  if (!text) return out;
  const re = /(?<![A-Za-z0-9_])#[^\s,:]+/g;
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const start = m.index;
    const matched = trimTrailingPunctuation(m[0]);
    // A token that trims down to the bare prefix (e.g. "#." mid-sentence) is
    // not a channel — it needs the prefix plus at least one body character.
    if (matched.length < 2) {
      re.lastIndex = start + 1;
      continue;
    }
    re.lastIndex = start + matched.length;
    if (start > lastIdx) out.push({ kind: 'text', text: text.slice(lastIdx, start) });
    out.push({ kind: 'channel', text: matched });
    lastIdx = start + matched.length;
  }
  if (lastIdx < text.length) out.push({ kind: 'text', text: text.slice(lastIdx) });
  return out;
}

interface EmojiOrTextPiece {
  text: string;
  // true when `text` is an emoji glyph that replaced a `:shortcode:` — the
  // caller emits it as-is and skips the nick pass (a glyph has no nick inside).
  emoji?: boolean;
}

// Replace every resolvable `:shortcode:` with its emoji glyph, splitting the
// run into literal / glyph pieces. `emojiFn` (typically `emojiGlyph`) is the
// injected lookup; it's null until the emoji table loads and in non-message
// callers, in which case the text passes through untouched. Unknown shortcodes
// (`:foo:` with no match) are left literal. Uses the composer's grammar via
// `shortcodeScanRegex`, so what we auto-convert on send we render on receive.
// Runs on text that has already had URLs and channels split out, so a
// `http://x:y:z` or `#chan:foo` token never reaches this pass.
function splitTextByEmoji(
  text: string,
  emojiFn: ((name: string) => string | null) | null | undefined,
): EmojiOrTextPiece[] {
  if (!emojiFn || !text) return [{ text }];
  const re = shortcodeScanRegex();
  const out: EmojiOrTextPiece[] = [];
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const glyph = emojiFn(m[1]);
    if (glyph == null) continue; // not a known emoji — leave `:name:` literal
    const start = m.index;
    if (start > lastIdx) out.push({ text: text.slice(lastIdx, start) });
    out.push({ text: glyph, emoji: true });
    lastIdx = start + m[0].length;
  }
  if (lastIdx < text.length) out.push({ text: text.slice(lastIdx) });
  return out.length ? out : [{ text }];
}

interface NickTextSegment {
  text: string;
  color?: string | null;
  self?: boolean;
}

// Color any occurrence of a nick from `nickSet` within `text`. Comparison is
// case-insensitive; the matched casing is preserved in the rendered text.
// `colorFn` is `(nick) => string|null`.
function colorNicksInText(
  text: string,
  nickSet: Set<string> | null | undefined,
  selfLower: string | null | undefined,
  colorFn: ((nick: string) => string | null) | null | undefined,
): NickTextSegment[] {
  if (!text) return [{ text: '' }];
  if (!nickSet || nickSet.size === 0) return [{ text }];

  const nicks = [...nickSet].filter(Boolean);
  if (nicks.length === 0) return [{ text }];
  // Longest first so "alibaba" wins over "ali" in alternation.
  nicks.sort((a, b) => b.length - a.length);
  const alternation = nicks.map(escapeRegex).join('|');
  const pattern = new RegExp(
    `(?<!${NICK_CHAR_CLASS})(?:${alternation})(?!${NICK_CHAR_CLASS})`,
    'gi',
  );

  const out: NickTextSegment[] = [];
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    const matched = m[0];
    const start = m.index;
    if (start > lastIdx) out.push({ text: text.slice(lastIdx, start) });
    const lower = matched.toLowerCase();
    const isSelf = selfLower && lower === selfLower;
    out.push({
      text: matched,
      color: isSelf ? null : colorFn ? colorFn(matched) : null,
      self: !!isSelf,
    });
    lastIdx = start + matched.length;
  }
  if (lastIdx < text.length) out.push({ text: text.slice(lastIdx) });
  return out;
}

// Fallback for the 16 mIRC colour slots, used when no caller-supplied palette
// covers a given index. The chromatic slots match nick.colors defaults so a
// renderer without a settings store (tests, MOTD pre-paint) still produces
// theme-friendly colours. Indices 16-98 (extended) aren't widely used, so we
// don't render those — we just consume the escape so the digits don't leak into
// the output. The \x04 truecolour variant names its colour outright and is
// rendered as sent (see IrcColor).
//
// ⚠ EVERY slot is a literal, and none may become a theme reference again.
//
// The rule used to be narrower — "never var(--bg), because that IS the surface;
// var(--fg) and its derivatives are safe since they can never equal the
// background" — and that reasoning only held for the CANVAS. A run carries its
// own background, which is a second surface it never considered:
//
//   \x0300,01  white on black  →  var(--fg) on #000000, unreadable in a light
//                                 theme
//   \x0301,00  black on white  →  slot 0 is the BACKGROUND here, so a
//                                 foreground reference painted the box
//
// A slot that can't be named without knowing what it's drawn on isn't a colour.
// The cost is that white is invisible on a light canvas when used bare, exactly
// as black already was on a dark one — the sender's call, and what every other
// client does.
export const MIRC_PALETTE_FALLBACK: readonly string[] = [
  '#ffffff', // 0  white
  '#000000', // 1  black
  '#6799f3', // 2  navy
  '#a9dc76', // 3  green
  '#ff6188', // 4  red
  '#ed6c89', // 5  maroon
  '#ab9df2', // 6  purple
  '#fc9867', // 7  orange
  '#ffd866', // 8  yellow
  '#b3db82', // 9  lime
  '#78dce8', // 10 teal
  '#a0f1ff', // 11 cyan
  '#7ba4ff', // 12 blue
  '#ff7494', // 13 magenta
  '#7f7f7f', // 14 gray       — mIRC's own grey
  '#d2d2d2', // 15 light gray — mIRC's own light grey
];

// Look up a mIRC colour slot in a caller-supplied palette, falling back to
// MIRC_PALETTE_FALLBACK when the palette is missing the entry or empty. Out-
// of-range indices (16-98) return null so the renderer can drop them without
// leaking digits into the output.
export function mircColor(
  index: number,
  palette: readonly string[] | null | undefined,
): string | null {
  if (index < 0 || index > 15) return null;
  const supplied = palette?.[index];
  if (supplied) return supplied;
  return MIRC_PALETTE_FALLBACK[index] ?? null;
}

// A colour a formatting code named: a mIRC slot from \x03, or a '#rrggbb' from
// \x04 truecolour (#558). A truecolour value is literal, like every slot.
export type IrcColor = number | string;

// The CSS colour for an IrcColor, or null for a slot the palette can't paint.
export function ircColor(
  color: IrcColor,
  palette: readonly string[] | null | undefined,
): string | null {
  return typeof color === 'string' ? color : mircColor(color, palette);
}

// Whether a run's text is invisible: foreground and background the same
// colour, which is the IRC spoiler convention (and how ASCII art fills a
// block). The renderer draws it as a click-to-reveal box, and link previews
// skip its URLs, so both ask here.
// ⚠ The colour has to be one we can paint. The palette has sixteen slots, so
// anything above resolves to null (see mircColor) and paints no box —
// `\x0399,99text\x03` satisfied fg === bg while drawing nothing, so text
// rendered in the clear became a neutral grey spoiler nobody could usefully
// reveal. 99 is mIRC's "default", a common way to write a run, and it is also
// what applySpoilerMarkup emits to close a spoiler before a digit: without this
// check that close would turn the whole rest of the line into a spoiler box.
export function hidesText(fg: IrcColor | null, bg: IrcColor | null): boolean {
  if (fg == null || fg !== bg) return false;
  return typeof fg === 'string' || fg <= 15;
}

export interface IrcRun {
  text: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  // \x16: the renderer swaps fg and bg (#558). Kept as a flag rather than
  // applied here, because an unset side swaps with the theme's own colour,
  // which only the renderer knows.
  reverse: boolean;
  fg: IrcColor | null;
  bg: IrcColor | null;
}

// Walk the IRC formatting state machine and emit runs of text, each tagged
// with the formatting attrs in effect when that text was emitted. Codes:
//   \x02 bold, \x1D italic, \x1F underline, \x1E strike  — toggles
//   \x16 reverse                                         — toggle
//   \x11 monospace                                       — consumed (no-op,
//                                                          we're already mono)
//   \x0F                                                 — reset all
//   \x03[FG[,BG]] mIRC colour                            — FG and BG kept
//   \x04[hex6[,hex6]] truecolour                         — FG and BG kept
export function parseIrcFormatting(text: string): IrcRun[] {
  const runs: IrcRun[] = [];
  let bold = false,
    italic = false,
    underline = false,
    strike = false,
    reverse = false;
  let fg: IrcColor | null = null;
  let bg: IrcColor | null = null;
  let buf = '';
  const flush = (): void => {
    if (!buf) return;
    runs.push({ text: buf, bold, italic, underline, strike, reverse, fg, bg });
    buf = '';
  };
  let i = 0;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (code === 0x02) {
      flush();
      bold = !bold;
      i++;
      continue;
    }
    if (code === 0x1d) {
      flush();
      italic = !italic;
      i++;
      continue;
    }
    if (code === 0x1f) {
      flush();
      underline = !underline;
      i++;
      continue;
    }
    if (code === 0x1e) {
      flush();
      strike = !strike;
      i++;
      continue;
    }
    if (code === 0x16) {
      flush();
      reverse = !reverse;
      i++;
      continue;
    }
    if (code === 0x11) {
      flush();
      i++;
      continue;
    }
    if (code === 0x0f) {
      flush();
      bold = italic = underline = strike = reverse = false;
      fg = null;
      bg = null;
      i++;
      continue;
    }
    if (code === 0x03) {
      flush();
      i++;
      let digits = '';
      while (digits.length < 2 && i < text.length && text[i] >= '0' && text[i] <= '9') {
        digits += text[i++];
      }
      if (digits === '') {
        // A bare \x03 closes the colour run — resets both fg and bg.
        fg = null;
        bg = null;
      } else {
        fg = parseInt(digits, 10);
        if (text[i] === ',' && text[i + 1] >= '0' && text[i + 1] <= '9') {
          i++;
          let bgDigits = '';
          while (bgDigits.length < 2 && i < text.length && text[i] >= '0' && text[i] <= '9') {
            bgDigits += text[i++];
          }
          bg = parseInt(bgDigits, 10);
        }
        // A foreground with no trailing background leaves bg as-is, per the
        // modern IRC formatting spec — \x0304 recolours text but keeps
        // whatever background was already in effect.
      }
      continue;
    }
    if (code === 0x04) {
      flush();
      i++;
      const hex = /^[0-9A-Fa-f]{6}/.exec(text.slice(i));
      if (hex) {
        fg = `#${hex[0].toLowerCase()}`;
        i += 6;
        const bgHex = text[i] === ',' ? /^[0-9A-Fa-f]{6}/.exec(text.slice(i + 1)) : null;
        if (bgHex) {
          bg = `#${bgHex[0].toLowerCase()}`;
          i += 7;
        }
        // As with \x03, a foreground alone keeps the background in effect.
      } else {
        // A bare \x04 closes the colour run, like a bare \x03.
        fg = null;
        bg = null;
      }
      continue;
    }
    buf += text[i++];
  }
  flush();
  return runs;
}

export interface TextSegmentStyle {
  color?: string;
  backgroundColor?: string;
  /** Vertical only — see `--mirc-bg-bleed`. Never a horizontal value. */
  padding?: string;
  fontWeight?: string;
  fontStyle?: string;
  textDecoration?: string;
}

export interface RenderSegment {
  text: string;
  url?: string;
  color?: string | null;
  self?: boolean;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  reverse?: boolean;
  fg?: IrcColor | null;
  bg?: IrcColor | null;
  // A run whose fg and bg are the same colour: invisible text the renderer
  // shows as a click-to-reveal spoiler. Carries no fg/bg — SpoilerText draws
  // its own box — but keeps any bold/italic/underline/strike for the reveal.
  spoiler?: boolean;
  // An IRC channel name (#/&-prefixed). `text` holds the same string; the
  // renderer turns it into a clickable join/switch affordance when it has a
  // network to act on, otherwise it renders as plain text.
  channel?: string;
}

// Build a Vue inline-style object for a segment. Colour precedence: an
// explicit IRC fg wins over nick coloring, which wins over the self-color.
// Pass selfColor=null when rendering outside the message context (topic bar,
// motd, etc.) — those callers never produce nick / self segments anyway.
// `mircPalette` is the user-overridable 16-colour mIRC palette from settings;
// pass null to fall back to MIRC_PALETTE_FALLBACK (handy in tests and pre-
// store render paths).
export function segmentInlineStyle(
  seg: RenderSegment,
  selfColor: string | null,
  mircPalette: readonly string[] | null = null,
): TextSegmentStyle {
  const style: TextSegmentStyle = {};
  const fg =
    (seg.fg != null ? ircColor(seg.fg, mircPalette) : null) ||
    seg.color ||
    (seg.self ? selfColor : null);
  const bg = seg.bg != null ? ircColor(seg.bg, mircPalette) : null;
  // Reverse (\x16) swaps the pair. A side the run leaves unset is the theme's
  // own, so reversed plain text reads as the theme inverted rather than as
  // nothing (#558).
  const color = seg.reverse ? (bg ?? 'var(--bg)') : fg;
  const background = seg.reverse ? (fg ?? 'var(--fg)') : bg;
  if (color) style.color = color;
  if (background) {
    style.backgroundColor = background;
    // Bleed the fill into the line's leading so stacked coloured rows form a
    // solid field rather than a striped one — see --mirc-bg-bleed. Only when
    // there IS a background: on a foreground-only run this would paint
    // nothing and merely widen the hit area.
    style.padding = 'var(--mirc-bg-bleed) 0';
  }
  if (seg.bold) style.fontWeight = 'bold';
  if (seg.italic) style.fontStyle = 'italic';
  const decos: string[] = [];
  if (seg.underline) decos.push('underline');
  if (seg.strike) decos.push('line-through');
  if (decos.length) style.textDecoration = decos.join(' ');
  return style;
}

export function segmentHasStyle(seg: RenderSegment): boolean {
  return !!(
    seg.color ||
    seg.self ||
    seg.fg != null ||
    seg.bg != null ||
    seg.reverse ||
    seg.bold ||
    seg.italic ||
    seg.underline ||
    seg.strike
  );
}

// Channel, then emoji, then nick detection over a plain (URL-free) text run.
// Channels are matched first because a channel token can't contain a nick
// (nicks never start with #/&), so the order is unambiguous. Emoji shortcodes
// run next so a glyph is emitted whole and the remaining literal text still
// gets the nick pass — and a nick that happens to spell an emoji name (`:bone:`
// vs a user "bone") can't collide, since the shortcode needs the surrounding
// colons.
function splitPlainText(
  text: string,
  nickSet: Set<string> | null | undefined,
  selfLower: string | null | undefined,
  colorFn: ((nick: string) => string | null) | null | undefined,
  emojiFn: ((name: string) => string | null) | null | undefined,
): RenderSegment[] {
  const out: RenderSegment[] = [];
  for (const seg of splitTextByChannels(text)) {
    if (seg.kind === 'channel') {
      out.push({ text: seg.text, channel: seg.text });
      continue;
    }
    if (!seg.text) continue;
    for (const piece of splitTextByEmoji(seg.text, emojiFn)) {
      if (piece.emoji) {
        out.push({ text: piece.text });
        continue;
      }
      if (!piece.text) continue;
      for (const ns of colorNicksInText(piece.text, nickSet, selfLower, colorFn)) {
        if (ns.text) out.push(ns);
      }
    }
  }
  return out;
}

function splitRunIntoSegments(
  text: string,
  nickSet: Set<string> | null | undefined,
  selfLower: string | null | undefined,
  colorFn: ((nick: string) => string | null) | null | undefined,
  emojiFn: ((name: string) => string | null) | null | undefined,
): RenderSegment[] {
  if (!text) return [];
  const out: RenderSegment[] = [];
  for (const seg of splitTextByUrls(text)) {
    if (seg.kind === 'url') {
      out.push({ url: seg.href, text: seg.text });
      continue;
    }
    if (!seg.text) continue;
    out.push(...splitPlainText(seg.text, nickSet, selfLower, colorFn, emojiFn));
  }
  return out;
}

// Split `text` into renderable segments. Formatting codes are parsed first so
// each downstream segment carries its IRC formatting attrs; URL, then channel,
// then emoji, then nick splitting run on the cleaned text inside each
// formatting run.
//
// `emojiFn` (optional) resolves a `:shortcode:` to its glyph for the
// client-side render-time emoji pass — pass `emojiGlyph` (once the table has
// loaded) to turn `:tada:` into 🎉, or omit/null to leave shortcodes literal.
// It's render-only: the stored message text is never mutated.
//
// Returned segment shapes (callers branch on these in order):
//   { text, spoiler, ...fmt }           — hidden run (fg===bg); render as a
//                                         click-to-reveal box, never an <a>
//   { url, text, ...fmt }               — clickable link (with formatting)
//   { channel, text, ...fmt }           — clickable IRC channel name
//   { text, color?, self?, ...fmt }     — nick / plain text / emoji glyph
// where fmt is { bold?, italic?, underline?, strike?, reverse?, fg?, bg? }.
export function splitTextByTokens(
  text: string | null | undefined,
  nickSet: Set<string> | null | undefined,
  selfLower: string | null | undefined,
  colorFn: ((nick: string) => string | null) | null | undefined,
  emojiFn?: ((name: string) => string | null) | null,
): RenderSegment[] {
  if (!text) return [{ text: '' }];
  const runs = parseIrcFormatting(text);
  const out: RenderSegment[] = [];
  for (const run of runs) {
    if (!run.text) continue;
    const fmt: Partial<RenderSegment> = {};
    if (run.bold) fmt.bold = true;
    if (run.italic) fmt.italic = true;
    if (run.underline) fmt.underline = true;
    if (run.strike) fmt.strike = true;
    // A run whose foreground and background are the same colour is invisible
    // text — the IRC spoiler convention (see hidesText). Emit it as one opaque
    // segment and skip URL / nick splitting: a linked URL or a coloured nick
    // rendered inside the run would stay visible and leak the hidden content.
    // Keep the chosen colour on the segment so SpoilerText can paint the box in
    // the sender's colour rather than a generic gray. Reverse changes nothing
    // about an equal pair, so it isn't carried.
    if (hidesText(run.fg, run.bg)) {
      out.push({ text: run.text, spoiler: true, fg: run.fg, ...fmt });
      continue;
    }
    if (run.reverse) fmt.reverse = true;
    if (run.fg != null) fmt.fg = run.fg;
    if (run.bg != null) fmt.bg = run.bg;
    for (const seg of splitRunIntoSegments(run.text, nickSet, selfLower, colorFn, emojiFn)) {
      out.push({ ...seg, ...fmt });
    }
  }
  return out.length ? out : [{ text: '' }];
}

// Formatting only: the runs of `text` as segments, with no URL, nick or
// channel detection. For text that is a name, not a message — a display name
// (#607) keeps its mIRC colours but "foo.com" in one is not a link.
export function formattingSegments(text: string): RenderSegment[] {
  const out: RenderSegment[] = [];
  for (const run of parseIrcFormatting(text)) {
    if (!run.text) continue;
    const seg: RenderSegment = { text: run.text };
    if (run.bold) seg.bold = true;
    if (run.italic) seg.italic = true;
    if (run.underline) seg.underline = true;
    if (run.strike) seg.strike = true;
    if (run.reverse) seg.reverse = true;
    if (run.fg != null) seg.fg = run.fg;
    if (run.bg != null) seg.bg = run.bg;
    out.push(seg);
  }
  return out.length ? out : [{ text: '' }];
}
