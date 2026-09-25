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

describe('stylesheets', () => {
  it('never nest :hover inside a pseudo-function', () => {
    const offenders = styleFiles(SRC).flatMap((file) =>
      readFileSync(file, 'utf8')
        // Comments may name the shape (to warn against it); blank them, but keep
        // their newlines so reported line numbers stay true.
        .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
        .split('\n')
        .map((line, i) => ({ line, at: `${relative(SRC, file)}:${i + 1}` }))
        .filter(({ line }) => NESTED_HOVER.test(line))
        .map(({ at, line }) => `${at}  ${line.trim()}`),
    );
    expect(offenders).toEqual([]);
  });
});
