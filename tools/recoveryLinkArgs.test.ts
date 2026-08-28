// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { parseRecoveryLinkArgs } from './recoveryLinkArgs.js';

const ENV = { WEBAUTHN_ORIGIN: 'https://lurker.example.com' };

describe('parseRecoveryLinkArgs', () => {
  it('falls back to WEBAUTHN_ORIGIN for the documented default invocation', () => {
    // `npm run recovery-link -- your-username`, exactly as SELF_HOSTING.md says.
    // This is the form that broke: with no --url, argv[urlIndex + 1] read argv[0]
    // and the username became the origin.
    expect(parseRecoveryLinkArgs(['alice'], ENV)).toEqual({
      username: 'alice',
      origin: 'https://lurker.example.com',
      error: null,
    });
  });

  it('takes the first entry of a comma-separated WEBAUTHN_ORIGIN', () => {
    const env = { WEBAUTHN_ORIGIN: 'https://a.example,https://b.example' };
    expect(parseRecoveryLinkArgs(['alice'], env).origin).toBe('https://a.example');
  });

  it.each([
    [['alice', '--url', 'https://x.example']],
    [['--url', 'https://x.example', 'alice']],
    [['alice', '--url=https://x.example']],
    [['--url=https://x.example', 'alice']],
  ])('accepts %j', (argv) => {
    expect(parseRecoveryLinkArgs(argv, ENV)).toEqual({
      username: 'alice',
      origin: 'https://x.example',
      error: null,
    });
  });

  it('prefers an explicit --url over the environment', () => {
    expect(parseRecoveryLinkArgs(['alice', '--url', 'https://override.example'], ENV).origin).toBe(
      'https://override.example',
    );
  });

  it('trims a trailing slash so the path does not double up', () => {
    expect(parseRecoveryLinkArgs(['alice', '--url', 'https://x.example/'], ENV).origin).toBe(
      'https://x.example',
    );
  });

  it('reports a --url with no value', () => {
    expect(parseRecoveryLinkArgs(['alice', '--url'], ENV).error).toMatch(/--url needs a value/);
  });

  it('reports having no origin at all', () => {
    const result = parseRecoveryLinkArgs(['alice'], {});
    expect(result.error).toMatch(/No base URL/);
  });

  it('returns a null username when only flags were given', () => {
    expect(parseRecoveryLinkArgs(['--url', 'https://x.example'], ENV).username).toBeNull();
  });
});
