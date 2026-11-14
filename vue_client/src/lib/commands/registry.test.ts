// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import {
  COMMANDS,
  FEATURED,
  commandUsage,
  formUsage,
  helpLines,
  resolveVerb,
  specFor,
  type CommandSpec,
} from './registry.js';
import { KNOWN_LEVELS } from '../../../../shared/ignoreLevels.js';

const specs: readonly CommandSpec[] = COMMANDS;

describe('the command table', () => {
  it('names each command once, lowercase, aliases included', () => {
    const names = specs.flatMap((s) => s.names);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-z0-9]+$/);
  });

  it('resolves names and aliases, in any case', () => {
    expect(specFor('QUERY')?.names[0]).toBe('msg');
    expect(resolveVerb('Hop')).toBe('hop');
    expect(resolveVerb('frob')).toBeNull();
    expect(specFor('frob')).toBeUndefined();
  });

  it('features commands that exist', () => {
    for (const name of FEATURED) expect(specFor(name)?.names[0]).toBe(name);
  });

  it('is well formed: a rest slot is last, keywords and flags are lowercase', () => {
    const problems: string[] = [];
    for (const spec of specs) {
      const name = spec.names[0];
      if (!spec.summary) problems.push(`${name}: no summary`);
      for (const form of spec.forms) {
        form.args.forEach((a, i) => {
          const where = `${name} ${a.label}`;
          if (a.rest && i !== form.args.length - 1) problems.push(`${where}: rest is not last`);
          const words = [a.label, ...(a.values ?? [])];
          if (a.kind === 'keyword' && !words.every((w) => /^[a-z0-9]+$/.test(w))) {
            problems.push(`${where}: keyword is not lowercase`);
          }
          if (a.kind === 'choice' && !a.values?.length) problems.push(`${where}: empty choice`);
        });
        for (const f of form.flags ?? []) {
          if (!/^-[a-z_]+$/.test(f.name)) problems.push(`${name} ${f.name}: bad flag name`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('offers only ignore levels the parser knows', () => {
    const levels = specFor('ignore')!.forms[0].args[1].values!;
    expect(levels.filter((level) => !KNOWN_LEVELS.has(level))).toEqual([]);
  });
});

describe('usage', () => {
  it('prints a form the way it is typed', () => {
    expect(commandUsage(specFor('msg')!)).toBe('/msg <nick> [text]');
    expect(commandUsage(specFor('op')!)).toBe('/op <nick…>');
    expect(commandUsage(specFor('part')!, 'leave')).toBe('/leave [#chan] [reason]');
    expect(commandUsage(specFor('away')!)).toBe('/away [-all] [-one] [msg]');
    expect(commandUsage(specFor('ignore')!)).toBe('/ignore [opts] [mask|#chan] [LEVELS…]');
    expect(commandUsage(specFor('dcc')!)).toBe('/dcc [list]');
  });

  it('puts options after the words that pick the form', () => {
    const chat = specFor('dcc')!.forms.find((f) => f.args[0].label === 'chat')!;
    expect(formUsage('dcc', chat)).toBe('/dcc chat [-passive] [-secure] <nick>');
  });
});

describe('/commands', () => {
  const lines = helpLines();
  const text = lines.join('\n');

  it('lists every command that is not hidden, under its category', () => {
    const listed = specs.filter((spec) => lines.some((l) => l.startsWith(`  /${spec.names[0]}`)));
    expect(listed).toEqual(specs.filter((spec) => !spec.hidden));
    expect(lines).toContain('Moderation:');
  });

  it('names aliases, spells out long option lists, keeps the examples', () => {
    expect(text).toContain('— leave channel (keeps buffer) (aliases: /leave, /p)');
    expect(text).toContain(
      '      opts: -network -regexp -full -pattern <text> -except -time <dur>',
    );
    expect(text).toContain('e.g. /theme apply light   ·   /theme save My Theme');
    expect(text).toContain(
      '  /dcc send [-passive] [-secure] <nick> [file] — send one of your files',
    );
    expect(text).toContain('//text');
  });
});
