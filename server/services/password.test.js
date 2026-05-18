// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: Elastic-2.0

import { describe, it, expect } from 'vitest';
import {
  isValidPassword,
  passwordRequirementsMessage,
  hashPassword,
  verifyPassword,
} from './password.js';

describe('isValidPassword', () => {
  it('rejects non-strings', () => {
    expect(isValidPassword(null)).toBe(false);
    expect(isValidPassword(12345678)).toBe(false);
  });

  it('rejects too-short and too-long passwords', () => {
    expect(isValidPassword('1234567')).toBe(false);
    expect(isValidPassword('x'.repeat(257))).toBe(false);
  });

  it('accepts in-range passwords', () => {
    expect(isValidPassword('1'.repeat(8))).toBe(true);
    expect(isValidPassword('1'.repeat(256))).toBe(true);
  });
});

describe('passwordRequirementsMessage', () => {
  it('mentions the min and max', () => {
    expect(passwordRequirementsMessage()).toMatch(/8 and 256/);
  });
});

describe('hashPassword / verifyPassword', () => {
  it('round-trips a correct password', () => {
    const hash = hashPassword('correct-horse');
    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(verifyPassword('correct-horse', hash)).toBe(true);
  });

  it('rejects the wrong password', () => {
    const hash = hashPassword('correct-horse');
    expect(verifyPassword('wrong-horse', hash)).toBe(false);
  });

  it('returns false on non-string / non-scrypt stored values', () => {
    expect(verifyPassword('x', null)).toBe(false);
    expect(verifyPassword('x', undefined)).toBe(false);
    expect(verifyPassword('x', 'plain text password')).toBe(false);
  });

  it('returns false on malformed scrypt strings', () => {
    expect(verifyPassword('x', 'scrypt$bad')).toBe(false);
    expect(verifyPassword('x', 'scrypt$NaN$8$1$aaa$bbb')).toBe(false);
    expect(verifyPassword('x', 'scrypt$32768$8$1$$')).toBe(false);
  });

  it('the same password hashed twice produces different output (random salt)', () => {
    const h1 = hashPassword('same');
    const h2 = hashPassword('same');
    expect(h1).not.toBe(h2);
    expect(verifyPassword('same', h1)).toBe(true);
    expect(verifyPassword('same', h2)).toBe(true);
  });
});
