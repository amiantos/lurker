// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Shared argument coercion for the verb handlers. The registry validates scope,
// required-ness and network ownership; what's left is the structural checking
// JSON Schema can't express — empty-after-trim, and "this string becomes one
// IRC parameter, so it must not contain whitespace or CRLF".
//
// These live together rather than inline per verb because the rule has to be
// the same at every call site. conn.raw() already strips CR/LF/NUL before the
// socket, so a stray newline is never an injection — but stripping silently
// rewrites `#x\r\nfoo` into an operation against `#xfoo` and reports { ok:
// true } for a channel the caller never named. Rejecting up front is what turns
// that into an answerable error instead of a wrong success.

/** One IRC parameter: non-empty after trimming, no interior whitespace or NUL. */
export function singleToken(
  value: unknown,
  { empty, malformed }: { empty: string; malformed: string },
): { value: string } | { error: string } {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s) return { error: empty };
  // NUL isn't whitespace, but conn.raw() strips it like CR/LF, so `#a\0b`
  // would silently become #ab — an operation on a channel nobody named.
  if (/[\s\0]/.test(s)) return { error: malformed };
  return { value: s };
}

/** A channel name argument, e.g. "#foo". Any of the four IRC prefixes. */
export function channelArg(value: unknown): { value: string } | { error: string } {
  return singleToken(value, { empty: 'empty-channel', malformed: 'channel-must-be-single-token' });
}

/** A free-text IRC parameter that may contain spaces but must stay one line
 *  (a part/quit reason, an away message). Unlike the values that flow through
 *  IrcConnection.raw(), these reach irc-framework's own `client.join/part/quit/
 *  raw`, which serialise and write the line verbatim — so an embedded CRLF here
 *  really does inject a second IRC command rather than being stripped. */
export function singleLine(
  value: unknown,
  { malformed }: { malformed: string },
): { value: string | undefined } | { error: string } {
  if (value == null) return { value: undefined };
  const s = typeof value === 'string' ? value : '';
  if (/[\r\n\0]/.test(s)) return { error: malformed };
  const trimmed = s.trim();
  return { value: trimmed ? trimmed : undefined };
}
