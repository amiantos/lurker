// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The `/alias` command line (#276), irssi's grammar: bare lists, a name alone
// lists the aliases that start with it, `-name` removes, a name and a body
// defines or replaces. What an alias expands to is shared/aliases.ts.

import { normalizeAliasName, type Alias } from '../../../../shared/aliases.js';
import { formatColumns } from './output.js';

export type AliasCommand =
  | { readonly kind: 'list'; readonly prefix: string }
  | { readonly kind: 'remove'; readonly name: string }
  | { readonly kind: 'set'; readonly name: string; readonly body: string }
  | { readonly kind: 'error'; readonly error: string };

export function parseAliasArgs(argLine: string): AliasCommand {
  const line = argLine.trim();
  if (!line) return { kind: 'list', prefix: '' };
  const space = line.search(/\s/);
  const first = space === -1 ? line : line.slice(0, space);
  const body = space === -1 ? '' : line.slice(space).trim();
  if (first.startsWith('-')) {
    if (body) return { kind: 'error', error: 'removing an alias takes its name and nothing else' };
    const name = normalizeAliasName(first.slice(1));
    return name.ok ? { kind: 'remove', name: name.name } : { kind: 'error', error: name.error };
  }
  if (!body) return { kind: 'list', prefix: first.replace(/^\/+/, '').toLowerCase() };
  const name = normalizeAliasName(first);
  return name.ok ? { kind: 'set', name: name.name, body } : { kind: 'error', error: name.error };
}

/** The `/alias` listing: one aligned line per alias, under a count. */
export function aliasListLines(aliases: readonly Alias[], prefix: string): string[] {
  const shown = aliases.filter((a) => a.name.startsWith(prefix));
  if (!shown.length) {
    return [
      prefix
        ? `no alias starts with "${prefix}".`
        : 'no aliases. /alias <name> <command> makes one.',
    ];
  }
  return [
    `aliases (${shown.length}):`,
    ...formatColumns(shown.map((a) => [`  /${a.name}`, a.body])),
  ];
}
