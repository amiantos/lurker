// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, afterEach } from 'vitest';
import { allowedBrowserOrigins, isAllowedBrowserOrigin } from './corsOrigins.js';

const savedCors = process.env.CORS_ORIGIN;

describe('allowedBrowserOrigins', () => {
  afterEach(() => {
    if (savedCors === undefined) delete process.env.CORS_ORIGIN;
    else process.env.CORS_ORIGIN = savedCors;
  });

  it('falls back to the dev origin when CORS_ORIGIN is unset', () => {
    delete process.env.CORS_ORIGIN;
    expect(allowedBrowserOrigins()).toEqual(['https://irc.local.bradroot.me:5173']);
  });

  it('normalizes away a trailing slash', () => {
    process.env.CORS_ORIGIN = 'https://irc.example.com/';
    expect(allowedBrowserOrigins()).toEqual(['https://irc.example.com']);
  });

  it('splits a comma-separated allowlist and trims whitespace', () => {
    process.env.CORS_ORIGIN = 'https://a.example, https://b.example';
    expect(allowedBrowserOrigins()).toEqual(['https://a.example', 'https://b.example']);
  });

  it('dedupes entries that normalize to the same origin', () => {
    process.env.CORS_ORIGIN = 'https://a.example,https://a.example/';
    expect(allowedBrowserOrigins()).toEqual(['https://a.example']);
  });

  it('drops an unparseable entry rather than including a value that can never match', () => {
    process.env.CORS_ORIGIN = 'irc.example.com, https://ok.example';
    expect(allowedBrowserOrigins()).toEqual(['https://ok.example']);
  });

  it('preserves an explicit port', () => {
    process.env.CORS_ORIGIN = 'https://irc.example.com:8443';
    expect(allowedBrowserOrigins()).toEqual(['https://irc.example.com:8443']);
  });
});

describe('isAllowedBrowserOrigin', () => {
  afterEach(() => {
    if (savedCors === undefined) delete process.env.CORS_ORIGIN;
    else process.env.CORS_ORIGIN = savedCors;
  });

  it('matches a configured origin exactly', () => {
    process.env.CORS_ORIGIN = 'https://irc.example.com';
    expect(isAllowedBrowserOrigin('https://irc.example.com')).toBe(true);
  });

  it('matches even when the configured value has a trailing slash', () => {
    process.env.CORS_ORIGIN = 'https://irc.example.com/';
    expect(isAllowedBrowserOrigin('https://irc.example.com')).toBe(true);
  });

  it('rejects a scheme mismatch', () => {
    process.env.CORS_ORIGIN = 'https://irc.example.com';
    expect(isAllowedBrowserOrigin('http://irc.example.com')).toBe(false);
  });

  it('rejects a missing or unparseable origin', () => {
    process.env.CORS_ORIGIN = 'https://irc.example.com';
    expect(isAllowedBrowserOrigin(undefined)).toBe(false);
    expect(isAllowedBrowserOrigin('not-a-url')).toBe(false);
  });
});
