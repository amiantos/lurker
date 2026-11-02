// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// One place to parse/normalize a channel-scope list so the /highlight parser,
// the settings pane, the service, and the DB layer agree on splitting, trimming,
// lowercasing (channel matching is case-insensitive), de-duping, and dropping
// blanks. Previously this logic was reimplemented four times with inconsistent
// casing.

/**
 * The four IRC channel prefixes (RFC 2811 §2.1): `#` global, `&` server-local,
 * `+` no-modes, `!` safe/timestamped.
 *
 * ⚠⚠ Testing only for `#` is the single most-repeated bug in this codebase — it had accumulated
 * in ~30 places in the web client alone (#724), where an `&`/`+`/`!` channel was then treated as
 * a DM: no nicklist, a `probe-presence` fired at the channel name as if it were a nick, nick
 * colouring, whois menu items, and sorting among the DMs. It survived because `&` is server-local
 * and `+`/`!` are historic, so almost every real network only uses `#`.
 *
 * Shared rather than per-tier precisely because the halves disagreeing is what caused the damage:
 * the server has classified all four since `kindForTarget` was written, so every client-side `#`
 * test was a place the two tiers silently parted company.
 *
 * ⚠ This answers "is this the name of a CHANNEL". It is NOT the question a completion trigger
 * asks — that one is "did the user type a `#`", where the character is a literal sigil and
 * widening it would pop a channel picker on any `+` in ordinary prose. Those sites stay `#`-only
 * and say so.
 */
export const CHANNEL_PREFIX_CHARS = '#&+!';
const CHANNEL_PREFIXES = new Set(CHANNEL_PREFIX_CHARS);

// ⚠ A plain boolean, deliberately NOT a `target is string` type predicate. Most callers pass an
// already-`string` target, and a predicate would narrow the ELSE branch of those to `never` —
// so `!isChannelTarget(t)` would stop compiling wherever `t` is used afterwards, which is most of
// the DM paths. The handful of callers holding `string | undefined` guard once themselves.
export function isChannelTarget(target: string | null | undefined): boolean {
  return typeof target === 'string' && CHANNEL_PREFIXES.has(target[0] ?? '');
}

/**
 * Whether `target` names exactly one person: what a DCC offer may go to. Not a channel, not a
 * STATUSMSG channel target (`@#room`, `+#room`), not a list (`bob,#room` reaches every target
 * on a server that takes several), not a broadcast mask (`$$*`), and nothing a line could be
 * split on. A DCC offer to a
 * channel hands its file, or its chat, to whoever connects first.
 */
export function isSinglePeerTarget(target: string): boolean {
  // eslint-disable-next-line no-control-regex
  if (!target || /[,\s\u0000-\u001f]/.test(target)) return false;
  // A server or host mask (`$$*`, `$#*.net`): an oper's broadcast to everyone.
  if (target.startsWith('$')) return false;
  return channelReadings(target).length === 0;
}

/** STATUSMSG prefixes a server may take in front of a channel name (`@#room` reaches its ops). */
const STATUSMSG_PREFIXES = '~&@%+';

/**
 * Every channel `target` could be read as naming, STATUSMSG prefixes peeled one at a time.
 *
 * A STATUSMSG prefix can itself be a channel sigil (`+`, `&`), so every way of reading the
 * leading run is kept: `%+room` is the `+room` channel to the halfops, and `+room` itself.
 * Empty for a nick. Anything judging what a line to `target` reaches must check them all.
 */
export function channelReadings(target: string): string[] {
  const out: string[] = [];
  for (let t = target; t; t = t.slice(1)) {
    if (isChannelTarget(t)) out.push(t);
    if (!STATUSMSG_PREFIXES.includes(t[0])) break;
  }
  return out;
}

/**
 * A bare, prefix-less name is what people usually type, so it gets the common `#`; a name already
 * carrying any of the four prefixes is left alone. Callers own their own input validation
 * (whitespace, empty, lone prefix) — this only settles the prefix.
 *
 * Shared so the web's Join Channel modal and `/join` (#496) and the server's channel lists
 * (`parseChannelNames`) settle a bare name the same way.
 */
export function ensureChannelPrefix(name: string): string {
  return isChannelTarget(name) ? name : `#${name}`;
}

/**
 * A list of channels to autojoin, as a person types one: the network form's Channels field
 * (`default_channel`) and an admin preset's recommended channels. A string, or an array of them
 * (the admin pane sends one); commas and whitespace both separate, blanks and a lone prefix are
 * dropped, and a name repeated in another casing is the same channel, kept in its first spelling.
 *
 * A bare name gets a `#` only when NO name in the list carries a prefix (sweep L17): "lurker,
 * linux" seeds #lurker and #linux, as Join Channel would. Once any name has one, the list is IRC's
 * own syntax and is taken as typed, because there a bare word can be a channel KEY: `#secret
 * hunter2` prefixed word by word would autojoin a public #hunter2 named after the key.
 */
export function parseChannelNames(raw: unknown): string[] {
  const entries = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const words = entries
    .filter((entry): entry is string => typeof entry === 'string')
    .flatMap((entry) => entry.split(/[,\s]+/))
    .map((name) => name.trim())
    .filter(Boolean);
  // Judged before a lone prefix is dropped: in "# hunter2" the `#` is still a sign of IRC syntax,
  // and the word beside it may still be a key.
  const asTyped = words.some((name) => isChannelTarget(name));
  const names = words.filter((name) => !(name.length === 1 && isChannelTarget(name)));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of names) {
    const channel = asTyped ? name : ensureChannelPrefix(name);
    const key = channel.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(channel);
  }
  return out;
}

/**
 * The DCC CHAT buffer sigil. `=alice` is a direct peer-to-peer conversation with alice carried
 * on a TCP socket THIS PROCESS owns — it is not a channel, not a nick, and **never an IRC
 * target**. The convention is irssi's (dcc-chat.c:179, fe-dcc-chat.c:58) and repartee's
 * (app/dcc.rs:121); both also route `/msg =nick` to the socket, so it carries addressing
 * meaning rather than being a display label.
 *
 * ⚠⚠ Lives here, next to `isChannelTarget`, for the reason that comment already gives: the
 * damage comes from the two tiers disagreeing about a target's shape. `=` is the THIRD answer
 * to "what is this target", after channel and DM, and every site that used to treat
 * "not a channel" as "therefore a nick I can put on the wire" is now wrong.
 *
 * ⚠⚠ A `=` target reaching the IRC socket is the failure mode to guard against — as `PRIVMSG
 * =alice`, `MONITOR + =alice` or `TAGMSG =alice`. The structural defence is that these buffers
 * are minted `kind: 'dcc'` (server/db/buffers.ts), which keeps them out of the kind-keyed SQL
 * that feeds presence tracking and bouncer playback; the guards in ircManager's send paths are
 * the second line, covering the composer, MCP and attached bouncer clients alike.
 */
export const DCC_CHAT_PREFIX = '=';

// ⚠ A plain boolean for the same reason `isChannelTarget` is one — see its note.
//
// ⚠ Any `=`-prefixed string, bare `=` included. Requiring a peer after the sigil
// let a bare `=` through as an ordinary DM target, so it reached the wire as
// `PRIVMSG =`. No valid nick or channel starts with `=`, so treating every such
// string as a pseudo-target is exact, not over-broad; callers that need a peer
// get an empty one from dccChatPeer and refuse.
export function isDccChatTarget(target: string | null | undefined): boolean {
  return typeof target === 'string' && target.startsWith(DCC_CHAT_PREFIX);
}

/** The peer nick a `=nick` buffer is chatting with. Returns the target unchanged if it isn't
 *  a DCC chat target, so callers can pass either without a shape test first. */
export function dccChatPeer(target: string): string {
  return isDccChatTarget(target) ? target.slice(1) : target;
}

/**
 * The prefix set as a regex character-class BODY (no brackets), for callers that must match a
 * channel name inside a larger pattern rather than test a whole target.
 *
 * ⚠ Escaped, because it gets interpolated into a class — `]`, `\`, `^` or `-` would otherwise
 * change the class's meaning instead of being matched literally. None of the four prefixes needs
 * it today; the escape is what makes adding a fifth safe.
 */
export const CHANNEL_PREFIX_CLASS = CHANNEL_PREFIX_CHARS.replace(/[\\\]^-]/g, '\\$&');

// Hoisted, not built per call: this runs inside a sort comparator (twice per comparison in
// `bufferSortKey`) and once per row in the quick switcher, on every sidebar rebuild.
const CHANNEL_PREFIX_RE = new RegExp(`^[${CHANNEL_PREFIX_CLASS}]+`);

/** Strip every leading channel sigil — for sort keys and display, never for addressing. */
export function stripChannelPrefix(target: string): string {
  return target.replace(CHANNEL_PREFIX_RE, '');
}

// Normalize an array of channel names: trim, lowercase, drop blanks, dedupe.
// Non-string entries are ignored.
export function normalizeChannelList(values: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const c = (typeof v === 'string' ? v : '').trim().toLowerCase();
    if (c && !seen.has(c)) {
      seen.add(c);
      out.push(c);
    }
  }
  return out;
}

// Parse a free-form channel list (comma- and/or space-separated) into a
// normalized array.
export function parseChannelList(input: string): string[] {
  return normalizeChannelList(input.split(/[\s,]+/));
}
