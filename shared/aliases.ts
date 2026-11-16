// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Command aliases (#276): a name the user gives to one or more commands, with
// the typed arguments substituted in. `/alias greet /me waves at $1`, then
// `/greet bob`.
//
// Shared so the server validates a definition with the rules the client expands
// it by, and so there is one description of the grammar for the mobile apps to
// port. The grammar is irssi's and WeeChat's where the two agree, WeeChat's
// where they don't:
//
//  - `;` separates commands, `\;` is a literal one.
//  - `$1`..`$9` are the typed words, `$2-` the second to the end, `$2-3` a
//    span, `$*` everything as typed. A word that wasn't typed is empty. A dash
//    with a letter or a `$` straight after it is a dash: `$1-bot`, `$1-$2`.
//  - `$channel` (`$chan`) is the buffer the alias was run in, `$nick` (`$me`)
//    your nick there, `$network` its network. `$$` is a literal dollar, and any
//    other `$` is left alone.
//  - A body that names no typed word gets them all on the end of its last
//    command, so `/alias j /join` needs nothing more.
//  - The slash on a command is optional.

export const ALIAS_NAME_MAX = 64;
export const ALIAS_BODY_MAX = 4096;

/**
 * How many aliases deep one typed line may go. An alias never re-enters itself
 * (its own name inside its body is the command it replaced), so this only
 * bounds a long chain of different ones.
 */
export const MAX_ALIAS_DEPTH = 10;

/**
 * How many commands one typed line may come to. Depth alone doesn't bound it:
 * six aliases that each run the next twenty times are 3.2 million commands,
 * built while the line is still being typed. Past this, nothing is run.
 */
export const MAX_ALIAS_COMMANDS = 500;

/**
 * Names no alias may take: the two commands that manage aliases, so one that
 * replaces a command can always be listed and removed.
 */
export const RESERVED_ALIAS_NAMES: readonly string[] = ['alias', 'unalias'];

export interface Alias {
  readonly name: string;
  readonly body: string;
}

export type AliasNameResult =
  | { readonly ok: true; readonly name: string }
  | { readonly ok: false; readonly error: string };

/**
 * A typed name as a stored one is looked up: no slash, lower case, and none of
 * the rules below. Removing and editing go by this, so a row that breaks a rule
 * (an import, a name reserved since) can still be reached.
 */
export function aliasKey(raw: string): string {
  return raw.trim().replace(/^\/+/, '').toLowerCase();
}

/** A typed name as it is stored: no slash, lower case. */
export function normalizeAliasName(raw: string): AliasNameResult {
  const name = aliasKey(raw);
  if (!name) return { ok: false, error: 'an alias needs a name' };
  if (/[\s/]/.test(name))
    return { ok: false, error: "an alias name can't hold a space or a slash" };
  if (name.startsWith('-')) return { ok: false, error: "an alias name can't start with -" };
  // A path segment of dots is resolved away before it reaches /api/aliases/:name.
  if (/^\.+$/.test(name)) return { ok: false, error: "an alias name can't be only dots" };
  if (name.length > ALIAS_NAME_MAX) {
    return { ok: false, error: `an alias name is at most ${ALIAS_NAME_MAX} characters` };
  }
  if (RESERVED_ALIAS_NAMES.includes(name)) {
    return { ok: false, error: `/${name} can't be replaced` };
  }
  return { ok: true, name };
}

export type AliasBodyResult =
  | { readonly ok: true; readonly body: string }
  | { readonly ok: false; readonly error: string };

/** A typed body as it is stored: trimmed, and holding at least one command. */
export function normalizeAliasBody(raw: string): AliasBodyResult {
  const body = raw.trim();
  if (!splitAliasBody(body).length) return { ok: false, error: 'an alias needs a command to run' };
  if (body.length > ALIAS_BODY_MAX) {
    return { ok: false, error: `an alias is at most ${ALIAS_BODY_MAX} characters` };
  }
  return { ok: true, body };
}

/** The commands of a body, in order. `\;` is a semicolon that doesn't split. */
export function splitAliasBody(body: string): string[] {
  const commands: string[] = [];
  let current = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '\\' && body[i + 1] === ';') {
      current += ';';
      i++;
    } else if (ch === ';') {
      commands.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  commands.push(current);
  return commands.map((c) => c.trim()).filter(Boolean);
}

/** Where an alias is being run, for the variables that aren't typed words. */
export interface AliasContext {
  /** The buffer's target: a channel, or the nick of a DM. Empty in the system buffer. */
  readonly channel: string;
  /** Your nick on that network. */
  readonly nick: string;
  /** The network's name. */
  readonly network: string;
}

const NAMED: readonly (readonly [string, keyof AliasContext])[] = [
  // Longest first, so `$channel` isn't read as `$chan` and three letters.
  ['channel', 'channel'],
  ['network', 'network'],
  ['chan', 'channel'],
  ['nick', 'nick'],
  ['me', 'nick'],
];

const isDigit = (ch: string | undefined): ch is string =>
  ch !== undefined && ch >= '1' && ch <= '9';
const isWordChar = (ch: string | undefined): boolean => ch !== undefined && /[A-Za-z0-9_]/.test(ch);

/** One command with its variables filled in, and whether it named a typed word. */
function substitute(
  template: string,
  argLine: string,
  words: readonly string[],
  ctx: AliasContext,
): { text: string; usedArgs: boolean } {
  let text = '';
  let usedArgs = false;
  for (let i = 0; i < template.length; i++) {
    const ch = template[i];
    const next = template[i + 1];
    if (ch !== '$') {
      text += ch;
      continue;
    }
    if (next === '$') {
      text += '$';
      i++;
      continue;
    }
    if (next === '*') {
      text += argLine;
      usedArgs = true;
      i++;
      continue;
    }
    if (isDigit(next)) {
      const from = Number(next);
      i++;
      // `$1-bot` and `$1-$2` are a word and a dash; `$1-` anywhere else is a range.
      const after = template[i + 2];
      if (template[i + 1] === '-' && !(after === '$' || /[A-Za-z0_]/.test(after ?? ''))) {
        i++;
        const to = isDigit(template[i + 1]) ? Number(template[++i]) : words.length;
        text += words.slice(from - 1, to).join(' ');
      } else {
        text += words[from - 1] ?? '';
      }
      usedArgs = true;
      continue;
    }
    const named = NAMED.find(
      ([word]) => template.startsWith(word, i + 1) && !isWordChar(template[i + 1 + word.length]),
    );
    if (named) {
      text += ctx[named[1]];
      i += named[0].length;
      continue;
    }
    text += '$';
  }
  return { text, usedArgs };
}

/**
 * The command lines an alias becomes for the arguments typed after it, each
 * with its leading slash. Expanded once: a typed word that holds a `$1` or a
 * `;` is text, not more of the alias.
 */
export function expandAlias(body: string, argLine: string, ctx: AliasContext): string[] {
  const args = argLine.trim();
  const words = args ? args.split(/\s+/) : [];
  let usedArgs = false;
  const lines = splitAliasBody(body).map((template) => {
    const out = substitute(template, args, words, ctx);
    usedArgs ||= out.usedArgs;
    return out.text.trim();
  });
  if (!usedArgs && args && lines.length) {
    lines[lines.length - 1] = `${lines[lines.length - 1]} ${args}`;
  }
  return lines.filter(Boolean).map((line) => (line.startsWith('/') ? line : `/${line}`));
}

/** What a typed line comes to once every alias in it has been expanded. */
export interface ResolvedAliases {
  /** The commands to run, in order. None of them is to be expanded again. */
  readonly lines: string[];
  /** The alias that was not expanded because the chain was already too deep. */
  readonly stoppedAt: string | null;
  /** The line came to more than MAX_ALIAS_COMMANDS commands; `lines` is empty. */
  readonly tooMany: boolean;
}

/**
 * Expand a typed command line all the way down: the alias it names, the aliases
 * that one's commands name, and so on. A line that names no alias comes back as
 * it is.
 *
 * A name already running in the chain is not expanded again, so an alias's own
 * name in its body is the command it replaced (`/alias quit /quit gone
 * fishing`), and no alias can run forever.
 */
export function resolveAliases(
  line: string,
  aliases: readonly Alias[],
  ctx: AliasContext,
): ResolvedAliases {
  const lines: string[] = [];
  const state = { stoppedAt: null as string | null, tooMany: false };
  collect(line, aliases, ctx, [], lines, state);
  return state.tooMany ? { lines: [], ...state } : { lines, ...state };
}

function collect(
  line: string,
  aliases: readonly Alias[],
  ctx: AliasContext,
  running: readonly string[],
  lines: string[],
  state: { stoppedAt: string | null; tooMany: boolean },
): void {
  if (state.tooMany) return;
  const space = line.search(/\s/);
  const verb = aliasKey(space === -1 ? line : line.slice(0, space));
  const alias = aliases.find((a) => a.name === verb);
  // A reserved name is never run as an alias, however it got into the list.
  if (!alias || running.includes(verb) || RESERVED_ALIAS_NAMES.includes(verb)) {
    if (lines.length >= MAX_ALIAS_COMMANDS) state.tooMany = true;
    else lines.push(line);
    return;
  }
  if (running.length >= MAX_ALIAS_DEPTH) {
    state.stoppedAt ??= verb;
    return;
  }
  const args = space === -1 ? '' : line.slice(space);
  for (const expanded of expandAlias(alias.body, args, ctx)) {
    collect(expanded, aliases, ctx, [...running, verb], lines, state);
  }
}

/**
 * The command an alias stands in for when it is a plain rename, for completing
 * its arguments as that command's: the verb, and the words the body already
 * supplies after it. Null for a body with several commands or with variables,
 * where a typed word has no one slot it lands in.
 */
export function aliasTarget(body: string): { verb: string; words: string[] } | null {
  const commands = splitAliasBody(body);
  if (commands.length !== 1 || commands[0].includes('$')) return null;
  const [verb, ...words] = commands[0].replace(/^\//, '').split(/\s+/);
  return verb ? { verb: verb.toLowerCase(), words } : null;
}
