// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Relay/bridge-bot message parsing (#277). A relay bot posts other people's
// messages on IRC — bridged in from Discord, Telegram, Matrix, another network,
// etc. — wrapped in a fixed envelope like `[Discord] <alice> hello`. When the
// user marks the bot's nick as a relay, the client parses that envelope and
// attributes the line to the embedded speaker instead of the bot.
//
// Parsing is template-driven, not free regex: a template is literal text with
// `{source}`, `{nick}`, and `{message}` placeholders. We escape the literals
// and compile the placeholders to capture groups, so a user-supplied pattern
// can't inject regex or trigger catastrophic backtracking. `{nick}` and
// `{message}` are required; `{source}` is optional. Everything stays pure and
// dependency-free so it runs at render time on the client and in tests from the
// repo root.

import { stripFormatting, rawIndexForVisibleOffset } from './textMatch.js';

/** Which captured value a compiled group holds, in left-to-right order. */
type Slot = 'source' | 'nick' | 'message';

/** Parsed envelope: the embedded speaker plus the platform tag, when present. */
export interface RelayParse {
  /** The `[source]` tag (e.g. "Discord"), or null when the template omits it. */
  source: string | null;
  /** The embedded speaker's nick. Always non-empty on a successful parse. */
  nick: string;
  /** The actual message text, with the envelope stripped. */
  text: string;
}

// Channel-membership prefix glyphs (PREFIX in ISUPPORT): owner ~, admin &, op @,
// halfop %, voice +. A relay bot often carries the speaker's status from the
// source channel — `<+FAST>` — but those glyphs aren't part of the nick, so we
// drop a leading run of them. Safe because a real nick can't begin with one.
const MEMBER_PREFIX_RE = /^[~&@%+]+/;

// Built-in formats, tried in order. The bracketed-source form first because
// it's the common bridge shape (matterbridge, the ##videogames relay on Libera,
// most operator-run bots); the bare `<nick>` form second for relays that don't
// prefix a platform tag. A marked bot whose format matches neither needs a
// custom template.
export const DEFAULT_RELAY_TEMPLATES = ['[{source}] <{nick}> {message}', '<{nick}> {message}'];

const PLACEHOLDER = /\{(source|nick|message)\}/g;

function escapeLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface Compiled {
  re: RegExp;
  slots: Slot[];
}

// Compiled-template cache. Templates are a tiny, stable set (two defaults plus
// the occasional custom pattern), so an unbounded Map is fine and keeps the
// per-row render cost to a hash lookup.
const cache = new Map<string, Compiled | null>();

/**
 * Compile a relay template into an anchored regex plus the slot order of its
 * capture groups. Returns null when the template lacks the required `{nick}` /
 * `{message}` placeholders or produces an invalid regex.
 */
export function compileRelayTemplate(template: string): Compiled | null {
  if (cache.has(template)) return cache.get(template) ?? null;
  const slots: Slot[] = [];
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  PLACEHOLDER.lastIndex = 0;
  while ((m = PLACEHOLDER.exec(template))) {
    out += escapeLiteral(template.slice(last, m.index));
    const slot = m[1] as Slot;
    slots.push(slot);
    // `{message}` is greedy to the end of the line; `{nick}` and `{source}` are
    // lazy so the literals that follow them (`>`, `]`, a space) bound the match.
    // A nick can't contain whitespace; a source tag might, so it's permissive.
    out += slot === 'message' ? '(.*)' : slot === 'nick' ? '(\\S+?)' : '(.+?)';
    last = m.index + m[0].length;
  }
  out += escapeLiteral(template.slice(last));
  if (!slots.includes('nick') || !slots.includes('message')) {
    cache.set(template, null);
    return null;
  }
  let compiled: Compiled | null;
  try {
    compiled = { re: new RegExp(`^${out}$`), slots };
  } catch {
    compiled = null;
  }
  cache.set(template, compiled);
  return compiled;
}

/**
 * Parse a relay bot's message body into its embedded speaker and text. Pass a
 * custom template to override the built-in formats; an empty/whitespace pattern
 * falls back to {@link DEFAULT_RELAY_TEMPLATES}. Returns null when no template
 * matches (the caller then renders the line unchanged, attributed to the bot).
 */
export function parseRelayMessage(
  body: string | null | undefined,
  customPattern?: string | null,
): RelayParse | null {
  if (!body) return null;
  // Relay bots colour the source tag and nick (mIRC \x03 codes, bold, etc.),
  // and those control chars sit right inside the [source]/<nick> we match — so
  // strip formatting before matching or the envelope never lines up. The source
  // and nick come back plain (we re-colour the nick ourselves anyway); the
  // message keeps its own formatting, recovered by mapping the match back onto
  // the raw body.
  const stripped = stripFormatting(body);
  const custom = (customPattern || '').trim();
  const templates = custom ? [custom] : DEFAULT_RELAY_TEMPLATES;
  for (const template of templates) {
    const compiled = compileRelayTemplate(template);
    if (!compiled) continue;
    const match = compiled.re.exec(stripped);
    if (!match) continue;
    let source: string | null = null;
    let nick = '';
    let text = '';
    compiled.slots.forEach((slot, i) => {
      const value = match[i + 1] ?? '';
      if (slot === 'source') source = value;
      else if (slot === 'nick') nick = value;
      else text = value;
    });
    // Drop any channel-membership prefix the bot carried into the nick, so the
    // speaker reads as `FAST`, not `+FAST` — and so Reply/Copy target the real
    // nick.
    nick = nick.replace(MEMBER_PREFIX_RE, '');
    if (!nick) continue;
    // Recover the message's original formatting. {message} is the trailing group
    // in every sane template, so its stripped form is a suffix of `stripped` —
    // map that suffix's start back into the raw body and slice. (A custom
    // template that puts {message} elsewhere falls back to the plain text.)
    let displayText = text;
    if (compiled.slots[compiled.slots.length - 1] === 'message') {
      const rawStart = rawIndexForVisibleOffset(body, stripped.length - text.length);
      displayText = body.slice(rawStart);
    }
    return { source, nick, text: displayText };
  }
  return null;
}
