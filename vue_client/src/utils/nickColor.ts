// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { createUrlRegex } from '../../../shared/urlPattern.js';

// Deterministic nick coloring. Mirrors weechat's gui_nick_find_color:
// trim stop chars, lowercase, hash, modulo a palette.
//
// Palette and stop-chars come from settings (look.nick.colors,
// look.nick.color_stop_chars); see vue_client/src/utils/settingsRegistry.js.

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

interface NickColorOptions {
  palette: string[];
  stopChars: string;
}

export function nickColor(
  nick: string | null | undefined,
  { palette, stopChars }: NickColorOptions,
): string | null {
  if (!nick) return null;
  if (!palette || palette.length === 0) return null;
  const normalized = trimForColor(nick, stopChars || '').toLowerCase();
  if (!normalized) return null;
  return palette[djb2(normalized) % palette.length];
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
// trimUrlTail (below) then strips trailing sentence punctuation so
// "see https://example.com." doesn't keep the period.

// Strip trailing punctuation that's almost certainly part of the surrounding
// sentence rather than the URL. Closing brackets are only stripped when they'd
// be unbalanced inside the URL — `https://en.wikipedia.org/wiki/Foo_(bar)`
// keeps its trailing ')', but `(see https://example.com)` doesn't.
function trimUrlTail(s: string): string {
  const PAIRS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  let end = s.length;
  while (end > 0) {
    const ch = s[end - 1];
    if ('.,;:!?\'"'.includes(ch)) {
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

function urlHref(matched: string): string {
  if (/^www\./i.test(matched)) return `http://${matched}`;
  // Bare email: "name@host.tld" with no scheme. The [^:]+@ guard rules out
  // strings that already have a scheme prefix (mailto:, http://user@host).
  if (/^[^:]+@/.test(matched)) return `mailto:${matched}`;
  return matched;
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
    const matched = trimUrlTail(m[0]);
    if (!matched) {
      // The whole match was punctuation (shouldn't happen given the regex
      // requires a scheme/www prefix, but guard anyway).
      re.lastIndex = start + 1;
      continue;
    }
    re.lastIndex = start + matched.length;
    if (start > lastIdx) out.push({ kind: 'text', text: text.slice(lastIdx, start) });
    out.push({ kind: 'url', text: matched, href: urlHref(matched) });
    lastIdx = start + matched.length;
  }
  if (lastIdx < text.length) out.push({ kind: 'text', text: text.slice(lastIdx) });
  return out;
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

// mIRC's classic 16-colour foreground palette. Indices 16-98 (extended) and
// the \x04 hex variant aren't widely used and clash badly with custom themes,
// so we don't render those — we just consume the escape so the digits don't
// leak into the output.
const MIRC_PALETTE: Record<number, string> = {
  0: '#ffffff',
  1: '#000000',
  2: '#00007f',
  3: '#009300',
  4: '#ff0000',
  5: '#7f0000',
  6: '#9c009c',
  7: '#fc7f00',
  8: '#ffff00',
  9: '#00fc00',
  10: '#009393',
  11: '#00ffff',
  12: '#0000fc',
  13: '#ff00ff',
  14: '#7f7f7f',
  15: '#d2d2d2',
};

interface IrcRun {
  text: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  fg: number | null;
  bg: number | null;
}

// Walk the IRC formatting state machine and emit runs of text, each tagged
// with the formatting attrs in effect when that text was emitted. Codes:
//   \x02 bold, \x1D italic, \x1F underline, \x1E strike  — toggles
//   \x16 reverse                                         — consumed (no-op)
//   \x11 monospace                                       — consumed (no-op,
//                                                          we're already mono)
//   \x0F                                                 — reset all
//   \x03[FG[,BG]] mIRC colour                            — FG and BG kept
//   \x04[hex6[,hex6]] truecolour                         — consumed, dropped
function parseIrcFormatting(text: string): IrcRun[] {
  const runs: IrcRun[] = [];
  let bold = false,
    italic = false,
    underline = false,
    strike = false;
  let fg: number | null = null;
  let bg: number | null = null;
  let buf = '';
  const flush = (): void => {
    if (!buf) return;
    runs.push({ text: buf, bold, italic, underline, strike, fg, bg });
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
    if (code === 0x11 || code === 0x16) {
      flush();
      i++;
      continue;
    }
    if (code === 0x0f) {
      flush();
      bold = italic = underline = strike = false;
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
        i += 6;
        if (text[i] === ',' && /^[0-9A-Fa-f]{6}/.test(text.slice(i + 1))) {
          i += 7;
        }
      } else {
        fg = null;
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
  fg?: number | null;
  bg?: number | null;
  // A run whose fg and bg are the same colour: invisible text the renderer
  // shows as a click-to-reveal spoiler. Carries no fg/bg — SpoilerText draws
  // its own box — but keeps any bold/italic/underline/strike for the reveal.
  spoiler?: boolean;
}

// Build a Vue inline-style object for a segment. Colour precedence: an
// explicit IRC fg wins over nick coloring, which wins over the self-color.
// Pass selfColor=null when rendering outside the message context (topic bar,
// motd, etc.) — those callers never produce nick / self segments anyway.
export function segmentInlineStyle(seg: RenderSegment, selfColor: string | null): TextSegmentStyle {
  const style: TextSegmentStyle = {};
  if (seg.fg != null && MIRC_PALETTE[seg.fg]) {
    style.color = MIRC_PALETTE[seg.fg];
  } else if (seg.color) {
    style.color = seg.color;
  } else if (seg.self && selfColor) {
    style.color = selfColor;
  }
  if (seg.bg != null && MIRC_PALETTE[seg.bg]) {
    style.backgroundColor = MIRC_PALETTE[seg.bg];
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
    seg.bold ||
    seg.italic ||
    seg.underline ||
    seg.strike
  );
}

function splitRunIntoSegments(
  text: string,
  nickSet: Set<string> | null | undefined,
  selfLower: string | null | undefined,
  colorFn: ((nick: string) => string | null) | null | undefined,
): RenderSegment[] {
  if (!text) return [];
  const urlSegments = splitTextByUrls(text);
  if (urlSegments.length === 0) {
    return colorNicksInText(text, nickSet, selfLower, colorFn).filter((s) => s.text);
  }
  const out: RenderSegment[] = [];
  for (const seg of urlSegments) {
    if (seg.kind === 'url') {
      out.push({ url: seg.href, text: seg.text });
      continue;
    }
    if (!seg.text) continue;
    const nickSegs = colorNicksInText(seg.text, nickSet, selfLower, colorFn);
    for (const ns of nickSegs) {
      if (ns.text) out.push(ns);
    }
  }
  return out;
}

// Split `text` into renderable segments. Formatting codes are parsed first so
// each downstream segment carries its IRC formatting attrs; URL splitting then
// nick splitting run on the cleaned text inside each formatting run.
//
// Returned segment shapes (callers branch on these in order):
//   { text, spoiler, ...fmt }           — hidden run (fg===bg); render as a
//                                         click-to-reveal box, never an <a>
//   { url, text, ...fmt }               — clickable link (with formatting)
//   { text, color?, self?, ...fmt }     — nick / plain text (with formatting)
// where fmt is { bold?, italic?, underline?, strike?, fg?, bg? }.
export function splitTextByTokens(
  text: string | null | undefined,
  nickSet: Set<string> | null | undefined,
  selfLower: string | null | undefined,
  colorFn: ((nick: string) => string | null) | null | undefined,
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
    // text — the IRC spoiler convention. Emit it as one opaque segment and
    // skip URL / nick splitting: a linked URL or a coloured nick rendered
    // inside the run would stay visible and leak the hidden content.
    if (run.fg != null && run.bg != null && run.fg === run.bg) {
      out.push({ text: run.text, spoiler: true, ...fmt });
      continue;
    }
    if (run.fg != null) fmt.fg = run.fg;
    if (run.bg != null) fmt.bg = run.bg;
    for (const seg of splitRunIntoSegments(run.text, nickSet, selfLower, colorFn)) {
      out.push({ ...seg, ...fmt });
    }
  }
  return out.length ? out : [{ text: '' }];
}
