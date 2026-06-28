// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Parser for the /relay command (#277) — mark, unmark, and list relay/bridge
// bots on the active network. A marked bot's messages get re-attributed to the
// speaker embedded in their envelope (`[Discord] <alice> hi` → alice).
//
// Pure and dependency-free so it unit-tests outside the Vue SFC, like the other
// command parsers. The custom-pattern argument is the *raw remainder* of the
// line — a template such as `<{nick}> {message}` whose spaces are significant —
// so we peel tokens by hand instead of tokenizeArgs, which would split and
// de-quote it.

export type RelayCommand =
  | { kind: 'list' }
  | { kind: 'add'; nick: string; pattern: string }
  | { kind: 'remove'; nick: string }
  | { kind: 'error'; message: string };

const ADD = new Set(['add', 'mark', 'set']);
const REMOVE = new Set(['remove', 'rm', 'del', 'delete', 'unmark']);

const USAGE = 'usage: /relay [list] · /relay add <nick> [pattern] · /relay remove <nick>';

// Split off the first whitespace-delimited token, returning [token, remainder].
// The remainder keeps its internal spacing (only the gap after the token is
// consumed) so a custom template survives intact.
function peel(s: string): [string, string] {
  const m = /^(\S+)\s*([\s\S]*)$/.exec(s.trimStart());
  return m ? [m[1], m[2]] : ['', ''];
}

// Drop one matching pair of surrounding quotes, if present — a convenience so
// `/relay add bot "[{s}] <{n}> {m}"` works even though quoting isn't required.
function unquote(s: string): string {
  if (
    s.length >= 2 &&
    ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === "'" && s[s.length - 1] === "'"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

export function parseRelayCommand(argLine: string): RelayCommand {
  const trimmed = (argLine || '').trim();
  if (!trimmed) return { kind: 'list' };

  const [sub, rest] = peel(trimmed);
  const verb = sub.toLowerCase();

  if (verb === 'list' || verb === 'ls') return { kind: 'list' };

  if (ADD.has(verb)) {
    const [nick, pattern] = peel(rest);
    if (!nick) return { kind: 'error', message: 'usage: /relay add <nick> [pattern]' };
    return { kind: 'add', nick, pattern: unquote(pattern.trim()) };
  }

  if (REMOVE.has(verb)) {
    const [nick] = peel(rest);
    if (!nick) return { kind: 'error', message: 'usage: /relay remove <nick>' };
    return { kind: 'remove', nick };
  }

  return { kind: 'error', message: `unknown subcommand "${sub}". ${USAGE}` };
}
