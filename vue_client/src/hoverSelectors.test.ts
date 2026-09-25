// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// postcss-hover-media-feature (postcss.config.js) loops forever on a `:hover`
// nested inside a pseudo-function — `:global(.line:hover) .x`, `:is(a:hover)`,
// `:not(:hover)` — and the symptom is `vite` / `vite build` sitting at 100% CPU
// with no error and no file name. Cheaper to refuse the shape here than to
// bisect a frozen dev server again. Put the `:hover` outside the parentheses
// (`.line:hover :deep(.x)`) or move the rule to the component that owns it.
const SRC = new URL('.', import.meta.url).pathname;
const NESTED_HOVER = /:(?:global|deep|slotted|is|where|not|has)\([^)]*:hover/;

function styleFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return styleFiles(path);
    return /\.(vue|css)$/.test(name) ? [path] : [];
  });
}

// Every match in a file's text, as `file:line  match`. The whole text, not line
// by line: a selector can span lines (`:global(\n  .line:hover\n)`), and
// `[^)]*` crosses newlines. Comments may name the shape (to warn against it),
// so they're blanked first — keeping their newlines, so line numbers stay true.
function offendersIn(file: string, text: string): string[] {
  const src = text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
  const found: string[] = [];
  for (const m of src.matchAll(new RegExp(NESTED_HOVER.source, 'g'))) {
    const line = src.slice(0, m.index).split('\n').length;
    found.push(`${file}:${line}  ${m[0].replace(/\s+/g, ' ')}`);
  }
  return found;
}

describe('stylesheets', () => {
  it('never nest :hover inside a pseudo-function', () => {
    const offenders = styleFiles(SRC).flatMap((file) =>
      offendersIn(relative(SRC, file), readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  // The scan itself: a guard that can't see the shape protects nothing.
  it('catches the shape on one line or across several, and not in a comment', () => {
    expect(offendersIn('a.vue', ':global(.line:hover) .x {}')).toHaveLength(1);
    expect(offendersIn('a.vue', '.y {}\n:global(\n  .line:hover\n) .x {}')).toEqual([
      'a.vue:2  :global( .line:hover',
    ]);
    expect(offendersIn('a.vue', '/* not :global(.line:hover) */ .x:hover {}')).toEqual([]);
    expect(offendersIn('a.vue', '.line:hover :deep(.x) {}')).toEqual([]);
  });
});
