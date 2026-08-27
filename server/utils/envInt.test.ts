// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, afterEach } from 'vitest';
import { envInt } from './envInt.js';

const NAME = 'LURKER_ENV_INT_TEST';

afterEach(() => {
  delete process.env[NAME];
});

describe('envInt', () => {
  it('falls back when unset or blank', () => {
    expect(envInt(NAME, 7)).toBe(7);
    process.env[NAME] = '   ';
    expect(envInt(NAME, 7)).toBe(7);
  });

  it('reads a whole number, 0 included', () => {
    process.env[NAME] = ' 12 ';
    expect(envInt(NAME, 7)).toBe(12);
    process.env[NAME] = '0';
    expect(envInt(NAME, 7)).toBe(0);
  });

  it('falls back on anything that is not a whole number >= 0', () => {
    const raws = ['0.5', '-1', 'abc', 'Infinity', '1e400', '3px'];
    const parsed = Object.fromEntries(
      raws.map((raw) => {
        process.env[NAME] = raw;
        return [raw, envInt(NAME, 7)];
      }),
    );
    expect(parsed).toEqual(Object.fromEntries(raws.map((raw) => [raw, 7])));
  });
});
