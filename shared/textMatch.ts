// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Shared text-matching primitives used by the highlight engine and the ignore
// content-pattern matcher. One implementation means "highlights on a word" and
// "ignore -pattern that word" agree on word boundaries, glob translation, and
// URL stripping, on both server and client.

import { createUrlRegex } from './urlPattern.js';

// 'substr' — case-(in)sensitive substring (irssi's default -pattern / stristr)
// 'plain'  — whole-word match of a literal (word-boundary anchored)
// 'glob'   — whole-word glob (* and ?) match
// 'regex'  — raw regular expression
export type TextKind = 'substr' | 'plain' | 'glob' | 'regex';

export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function globToRegexSource(pattern: string): string {
  let out = '';
  for (const ch of pattern) {
    if (ch === '*') out += '.*';
    else if (ch === '?') out += '.';
    else out += escapeRegex(ch);
  }
  return out;
}

// A "word character" for whole-word matching: any Unicode letter or number, or
// underscore. Crucially this is NOT JS's ASCII-only `\w`/`\W` — those treat any
// accented or non-Latin letter (e.g. `ł`) as a boundary, so a keyword `em` would
// wrongly match inside `zrozumiałem`. `\p{L}\p{N}` (with the `u` flag) keeps
// non-ASCII letters as word chars. The prefix is a consuming negated class
// rather than a lookbehind so the regex compiles on older engines (Safari < 16.4
// lacks lookbehind — a throw there would silently drop the rule).
const WORD_CHAR = '[\\p{L}\\p{N}_]';
const NON_WORD_CHAR = '[^\\p{L}\\p{N}_]';

// Compile a text pattern into a predicate. Returns null when the pattern can't
// compile (invalid regex) so callers can drop the rule rather than throw.
export function buildTextTest(
  pattern: string,
  kind: TextKind,
  caseSensitive: boolean,
): ((text: string) => boolean) | null {
  if (kind === 'substr') {
    if (caseSensitive) return (text: string) => text.includes(pattern);
    const needle = pattern.toLowerCase();
    return (text: string) => text.toLowerCase().includes(needle);
  }
  const flags = caseSensitive ? '' : 'i';
  // Raw user regex compiles as-is (no `u` flag — a user pattern may use syntax
  // that's invalid in Unicode mode, e.g. an unescaped `{`).
  if (kind === 'regex') {
    try {
      const re = new RegExp(pattern, flags);
      return (text: string) => re.test(text);
    } catch {
      return null;
    }
  }
  // 'plain' (literal whole-word) or 'glob' (whole-word with * and ?). We control
  // the generated source, so the `u` flag is always safe here.
  const body = kind === 'glob' ? globToRegexSource(pattern) : escapeRegex(pattern);
  const source = `(?:^|${NON_WORD_CHAR})(?:${body})(?!${WORD_CHAR})`;
  try {
    const re = new RegExp(source, flags + 'u');
    return (text: string) => re.test(text);
  } catch {
    return null;
  }
}

// The URL alternation is ~120 chars; compile it once and reuse. The /g regex is
// safe to share across .replace() calls (replace resets lastIndex each time).
const URL_RE = createUrlRegex();

// Blank out URLs before matching so a word inside a link — e.g. a nick that
// happens to appear in `https://example.com/nick` — doesn't trigger a match.
// The URL is replaced with a space (not removed) so words on either side can't
// fuse into a false match.
export function stripUrls(text: string): string {
  return text.replace(URL_RE, ' ');
}

// mIRC/IRC formatting control codes: color (\x03[fg][,bg]), hex color
// (\x04RRGGBB), and the toggles. These must be removed before whole-word
// matching: a colored word like `\x0304QUACK!` leaves the digit `4` glued to the
// front of QUACK, which breaks the word boundary and makes the highlight miss.
// The set mirrors the client renderer (vue_client/src/utils/nickColor.ts) EXACTLY
// so the matcher strips precisely what the user sees — the toggles are bold
// \x02, monospace \x11, reverse \x16, italic \x1d, strike \x1e, underline \x1f,
// reset \x0f; and \x03 with an optional 1-2 digit fg + optional ,bg (a bare \x03
// is a reset, and \x03 followed by `,NN` (bg, no fg) is NOT a color, so its digits
// stay text). Matching control codes literally is the point, so no-control-regex
// is moot.
/* eslint-disable no-control-regex */
const FORMAT_RE =
  /\x03(?:\d{1,2}(?:,\d{1,2})?)?|\x04[0-9A-Fa-f]{6}|[\x02\x0f\x11\x16\x1d\x1e\x1f]/g;
/* eslint-enable no-control-regex */

export function stripFormatting(text: string): string {
  return text.replace(FORMAT_RE, '');
}

// Sticky variant of FORMAT_RE for position-anchored scanning. Shares the source
// so the two never drift.
/* eslint-disable no-control-regex */
const FORMAT_RE_STICKY = new RegExp(FORMAT_RE.source, 'y');
/* eslint-enable no-control-regex */

// Map a "visible" (formatting-stripped) character offset back to its index in
// the raw, still-formatted string. When you match against stripFormatting(text)
// but then need to slice the ORIGINAL text at the same logical point — e.g. to
// keep a message's bold/colour after locating where it begins — this converts
// the stripped offset to the raw one. Walks raw once, skipping whole format
// codes (which contribute no visible characters).
export function rawIndexForVisibleOffset(raw: string, visibleOffset: number): number {
  if (visibleOffset <= 0) return 0;
  let visible = 0;
  let i = 0;
  while (i < raw.length) {
    if (visible >= visibleOffset) return i;
    FORMAT_RE_STICKY.lastIndex = i;
    const m = FORMAT_RE_STICKY.exec(raw);
    if (m && m[0].length > 0) {
      i += m[0].length;
    } else {
      visible++;
      i++;
    }
  }
  return raw.length;
}

// Normalize a message body for highlight/ignore-pattern matching: drop IRC
// formatting codes, then blank out URLs. Both the highlight engine and the
// ignore content matcher run this so they agree on what the "text" is.
export function cleanForMatch(text: string): string {
  return stripUrls(stripFormatting(text));
}
