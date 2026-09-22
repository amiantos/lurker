// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The translation skip/gate rules, as pure functions. Every rule here was a
// SHIPPED BUG in one of the two native clients (Scully desktop, Spooky
// Android) before it became a rule — the numbering follows the proposal doc so
// the test suite can cite them. Keep this module free of stores, fetch, and
// Vue: the rules are the load-bearing correctness surface and must be testable
// with no harness.

/** Rule 3/9's gate: LibreTranslate misidentifies short text below this
 *  confidence and then confidently mistranslates it. Applies to INCOMING
 *  detection only — an outgoing translation's target was chosen explicitly by
 *  the user, so detection confidence is irrelevant there (rule 9). */
export const MIN_DETECT_CONFIDENCE = 60;

// Rule 8: URLs contain many letters but translate to nothing — LibreTranslate
// scores them 0.0 confidence, and without stripping them first a link-heavy
// message fails the noise check, gets sent, fails the gate, and gets retried on
// every render. Strip before ANY other rule looks at the text.
const URL_RE = /\bhttps?:\/\/\S+|\bwww\.\S+/gi;

export function stripUrls(text: string): string {
  return text.replace(URL_RE, ' ');
}

// Rule 2's interjection list. ⚠ STORED PRE-COLLAPSED: the runtime check
// collapses character runs ("looool" → "lol", "hahahaha" → "haha") before
// matching, so an entry with its own repeats ("lool") would never match its
// collapsed form and silently rot. Lowercase, collapsed, no punctuation.
const INTERJECTIONS = new Set([
  'lol',
  'lmao',
  'rofl',
  'haha',
  'hehe',
  'jaja',
  // Base laughter syllables: the group-collapse reduces "hahaha"/"jajaja" to
  // these, so they must be present for the collapsed form to read as noise.
  'ha',
  'he',
  'ja',
  'ok',
  'okay',
  'k',
  'kk',
  'ty',
  'thx',
  'np',
  'yw',
  'brb',
  'afk',
  'gg',
  'gn',
  'gm',
  'wb',
  'hi',
  'hey',
  'yo',
  'o',
  'oh',
  'ah',
  'hm',
  'hmm',
  'wow',
  'oof',
  'rip',
  'nice',
  'same',
  'this',
  'yes',
  'no',
  'yeah',
  'nah',
  'yep',
  'nope',
  'xd',
  'uwu',
  'wtf',
  'omg',
  'idk',
  'imo',
  'smh',
]);

/** Normalize a stretched interjection toward its list form. Two independent
 *  stretch shapes occur and both must fold:
 *    - single-char runs:  "loool" → "lol",  "okkk" → "ok"
 *    - repeated groups:   "hahaha" → "ha…",  "jajaja" → "ja…"
 *  Returns the shortest form that is a known interjection, else a best-effort
 *  single-char dedupe. Legitimate doubles ("good") are only touched when the
 *  dedupe lands on a real interjection, so "good" stays "good". */
export function collapseRepeats(text: string): string {
  // Collapse a repeated multi-char GROUP to one instance: (ha)(ha)(ha)→ha.
  const ungrouped = text.replace(/^(.{2,}?)\1+$/, '$1');
  if (INTERJECTIONS.has(ungrouped)) return ungrouped;
  // Collapse single-char runs entirely: loool→lol, hahaha (already ha)→ha.
  const deduped = ungrouped.replace(/(.)\1+/g, '$1');
  if (INTERJECTIONS.has(deduped)) return deduped;
  // Nothing matched a known interjection — return the input UNCHANGED. Reducing
  // it anyway would mangle real words: "good"→"god" is not a normalization, it
  // is data loss, and isNoise would then mis-skip a legitimate message.
  return text;
}

/** Count of letter characters (any script), the measure rule 2 gates on.
 *  Unicode-aware: "你好" is 2 letters, not 0 — CJK text must not read as noise. */
export function letterCount(text: string): number {
  const m = text.match(/\p{L}/gu);
  return m ? m.length : 0;
}

/**
 * Rule 2 + 8: should this text skip translation entirely, before any network
 * call? True for text that is nothing but URLs, ≤2 letters after stripping
 * them, or a known interjection. Skipping is free; a wasted translation costs
 * a round-trip per render per reader.
 */
export function isNoise(text: string): boolean {
  const stripped = stripUrls(text).trim();
  if (letterCount(stripped) <= 2) return true;
  const collapsed = collapseRepeats(stripped.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ''));
  return INTERJECTIONS.has(collapsed);
}

/**
 * Rule 4: a translation only counts as one when the text genuinely changed.
 * Whitespace-insensitive: translators love to trim or re-space, and a badge on
 * a message whose visible text is identical reads as a client bug.
 */
export function genuinelyChanged(original: string, translated: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  const a = norm(original);
  const b = norm(translated);
  return b.length > 0 && a.toLowerCase() !== b.toLowerCase();
}

/**
 * Rule 3 (incoming only — see rule 9): trust a detection only at ≥60%
 * confidence. Below that LibreTranslate's guess is frequently wrong, and a
 * wrong source language produces a fluent, confident, incorrect translation —
 * worse than none, because nothing about it looks broken.
 *
 * The known cost (proposal, Known Limitations): short Spanish/Portuguese
 * messages often score below the gate and stay untranslated. Visible
 * incompleteness is the accepted trade for never showing a wrong translation.
 */
export function passesConfidenceGate(confidence: number | null | undefined): boolean {
  // ⚠ null/undefined PASSES, deliberately. A backend that reports no confidence
  // (every OpenAI-compatible one — they have no detection API) must not be
  // silently disabled by this gate; for those, "genuinely changed" (rule 4) is
  // the only signal a translation happened. The gate exists to catch a LOW
  // reported confidence, not an absent one.
  if (confidence == null) return true;
  return confidence >= MIN_DETECT_CONFIDENCE;
}

/** Render an ISO code for the badge. Rule/limitation: detectors emit codes
 *  outside our picker (e.g. `zh-Hans`) — render unknown codes as themselves
 *  rather than dropping the badge or crashing a lookup. */
export function badgeLang(code: string | null | undefined): string {
  return (code ?? '').trim() || '?';
}
