// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Argument parsing for tools/recovery-link.ts, split out as a pure function so
// it can be tested.
//
// It earns its own module: this is index arithmetic over argv, and it has been
// wrong twice. First `urlIndex + 1` was used as a skip index when no --url was
// present, so it swallowed the username (argv[0]). Then, fixing that, the same
// `urlIndex + 1` was READ with no --url present, so the username became the
// origin and the WEBAUTHN_ORIGIN fallback went dead — printing a link like
// `alice/recover/<token>` for the documented default invocation, on the
// sole-admin-locked-out path this tool exists for, after the token was already
// written. Both were invisible to typecheck and to every other test.

export interface RecoveryLinkArgs {
  username: string | null;
  origin: string;
  /** Set when the arguments are unusable; the caller prints it and exits 1. */
  error: string | null;
}

export function parseRecoveryLinkArgs(
  argv: readonly string[],
  env: { WEBAUTHN_ORIGIN?: string } = {},
): RecoveryLinkArgs {
  const inlineUrl = argv.find((a) => a.startsWith('--url='));
  const urlIndex = argv.indexOf('--url');

  // Read the following slot ONLY when --url actually appeared as its own token.
  // Without this guard urlIndex is -1 and argv[0] — the username — is read as
  // the origin.
  const spacedValue = urlIndex === -1 ? null : (argv[urlIndex + 1] ?? null);
  const originArg = inlineUrl ? inlineUrl.slice('--url='.length) : spacedValue;

  if ((inlineUrl || urlIndex !== -1) && !originArg) {
    return {
      username: null,
      origin: '',
      error: '--url needs a value, e.g. --url https://lurker.example.com',
    };
  }

  // Skip the value slot only when --url took a separate one; with --url=… there
  // is no separate slot and skipping would eat the username.
  const skipIndex = urlIndex === -1 ? -1 : urlIndex + 1;
  const username = argv.filter((a, i) => !a.startsWith('--') && i !== skipIndex)[0] ?? null;

  const origin = (originArg || (env.WEBAUTHN_ORIGIN || '').split(',')[0] || '').trim();
  if (username && !origin) {
    return {
      username,
      origin: '',
      error:
        'No base URL: pass --url https://lurker.example.com, or set WEBAUTHN_ORIGIN in the environment.',
    };
  }
  // Trailing slashes would double up against the /recover/ path below.
  return { username, origin: origin.replace(/\/+$/, ''), error: null };
}
