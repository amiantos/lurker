// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The request rules behind the OAuth authorization server (#891). Registration is
// open, so these are what keep an attacker-registered app from turning Lurker into
// a phishing or open-redirect tool — every refusal below is a shape someone could
// otherwise register.

import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import {
  OOB_REDIRECT_URI,
  hostOf,
  isValidRedirectUri,
  matchRedirectUri,
  parseAuthorizeRequest,
  redirectDestination,
  validateRegistration,
  verifyPkceS256,
  withQuery,
} from './oauth.js';

// Built from code points so the test source itself never carries an invisible
// character a reviewer can't see.
const BELL = String.fromCharCode(0x07);
const RIGHT_TO_LEFT_OVERRIDE = String.fromCharCode(0x202e);
const TAB = String.fromCharCode(0x09);

describe('isValidRedirectUri', () => {
  it.each([
    'https://app.example.com/callback',
    'http://127.0.0.1:8123/callback',
    'http://127.0.0.1/cb',
    'http://[::1]:9000/cb',
    'com.example.spooky:/oauth',
    'com.example.spooky://oauth/callback',
    OOB_REDIRECT_URI,
  ])('accepts %s', (uri) => {
    expect(isValidRedirectUri(uri)).toBe(true);
  });

  it.each([
    ['plain http off loopback', 'http://example.com/cb'],
    ['localhost by name', 'http://localhost:8123/cb'],
    // The URL parser strips the tab, so a check on the raw string would see
    // "java<tab>script" while a browser navigating to it runs javascript:.
    ['a tab hidden inside javascript:', `java${TAB}script:alert(1)`],
    ['javascript:', 'javascript:alert(1)'],
    ['data:', 'data:text/html,hello'],
    ['mailto:', 'mailto:someone@example.com'],
    ['a custom scheme that is not reverse-DNS', 'myapp://callback'],
    ['a fragment', 'https://app.example.com/cb#frag'],
    ['userinfo on a loopback redirect', 'http://user@127.0.0.1:8123/cb'],
    ['a host that only starts like loopback', 'http://127.0.0.1.evil.com/cb'],
    ['a relative path', '/callback'],
    ['a space', 'https://app.example.com/call back'],
  ])('refuses %s', (_label, uri) => {
    expect(isValidRedirectUri(uri)).toBe(false);
  });
});

describe('matchRedirectUri', () => {
  const registered = ['http://127.0.0.1:8000/callback', 'com.example.spooky:/oauth'];

  it('matches a registered URI exactly', () => {
    expect(matchRedirectUri(registered, 'com.example.spooky:/oauth')).toBe(true);
  });

  it('matches a loopback redirect on any port (RFC 8252 §7.3)', () => {
    expect(matchRedirectUri(registered, 'http://127.0.0.1:53124/callback')).toBe(true);
  });

  it.each([
    ['a different loopback path', 'http://127.0.0.1:53124/other'],
    ['a different loopback query', 'http://127.0.0.1:53124/callback?x=1'],
    ['the other loopback address', 'http://[::1]:8000/callback'],
    ['a host that starts with 127.0.0.1', 'http://127.0.0.1.evil.com:8000/callback'],
    ['userinfo in front of another host', 'http://127.0.0.1@evil.com:8000/callback'],
    ['an unregistered path on the app scheme', 'com.example.spooky:/other'],
  ])('refuses %s', (_label, requested) => {
    expect(matchRedirectUri(registered, requested)).toBe(false);
  });

  it('keeps port flexibility to loopback only', () => {
    expect(
      matchRedirectUri(['https://app.example.com:8443/cb'], 'https://app.example.com:9443/cb'),
    ).toBe(false);
  });
});

describe('redirectDestination', () => {
  it('describes where each kind of redirect lands', () => {
    expect(redirectDestination(OOB_REDIRECT_URI)).toEqual({ kind: 'code' });
    expect(redirectDestination('http://127.0.0.1:8000/cb')).toEqual({ kind: 'loopback' });
    expect(redirectDestination('com.example.spooky:/oauth')).toEqual({
      kind: 'app',
      scheme: 'com.example.spooky',
    });
    expect(redirectDestination('https://app.example.com/cb')).toEqual({
      kind: 'web',
      host: 'app.example.com',
    });
  });
});

describe('withQuery', () => {
  it('adds parameters and keeps the ones already there', () => {
    const url = new URL(
      withQuery('https://app.example.com/cb?keep=1', { code: 'abc', state: 'x' }),
    );
    expect(url.searchParams.get('keep')).toBe('1');
    expect(url.searchParams.get('code')).toBe('abc');
    expect(url.searchParams.get('state')).toBe('x');
  });

  it('leaves out undefined values', () => {
    expect(withQuery('com.example.spooky:/oauth', { code: 'abc', state: undefined })).toBe(
      'com.example.spooky:/oauth?code=abc',
    );
  });
});

describe('hostOf', () => {
  it('returns the host of a client_uri, or null', () => {
    expect(hostOf('https://spooky.example:8443/about')).toBe('spooky.example:8443');
    expect(hostOf(null)).toBeNull();
    expect(hostOf('not a url')).toBeNull();
  });
});

describe('verifyPkceS256', () => {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

  it('accepts the verifier behind the challenge', () => {
    expect(verifyPkceS256(verifier, challenge)).toBe(true);
  });

  it('refuses a different verifier', () => {
    expect(verifyPkceS256(crypto.randomBytes(32).toString('base64url'), challenge)).toBe(false);
  });

  it('refuses a "plain" challenge that is just the verifier', () => {
    expect(verifyPkceS256(verifier, verifier)).toBe(false);
  });

  it('refuses a verifier shorter than RFC 7636 allows', () => {
    expect(verifyPkceS256('short', challenge)).toBe(false);
  });
});

describe('validateRegistration', () => {
  const base = { client_name: 'Spooky', redirect_uris: ['com.example.spooky:/oauth'] };

  it('accepts a minimal registration', () => {
    expect(validateRegistration(base)).toEqual({
      ok: true,
      metadata: {
        clientName: 'Spooky',
        clientUri: null,
        redirectUris: ['com.example.spooky:/oauth'],
      },
    });
  });

  it('ignores the fields Lurker has only one answer to', () => {
    const result = validateRegistration({
      ...base,
      scope: 'read write',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_basic',
    });
    expect(result.ok).toBe(true);
  });

  it('trims the name, dedupes redirect URIs and keeps an http(s) client_uri', () => {
    const result = validateRegistration({
      client_name: '  Spooky  ',
      redirect_uris: [OOB_REDIRECT_URI, OOB_REDIRECT_URI],
      client_uri: 'https://spooky.example',
    });
    expect(result).toEqual({
      ok: true,
      metadata: {
        clientName: 'Spooky',
        clientUri: 'https://spooky.example',
        redirectUris: [OOB_REDIRECT_URI],
      },
    });
  });

  it('counts the name limit in characters, not UTF-16 units', () => {
    expect(validateRegistration({ ...base, client_name: '🙂'.repeat(60) }).ok).toBe(true);
  });

  it.each([
    ['no name', { redirect_uris: base.redirect_uris }, 'invalid_client_metadata'],
    [
      'a name over 60 characters',
      { ...base, client_name: 'x'.repeat(61) },
      'invalid_client_metadata',
    ],
    [
      'a right-to-left override in the name',
      { ...base, client_name: `Lurker${RIGHT_TO_LEFT_OVERRIDE}roi rof` },
      'invalid_client_metadata',
    ],
    [
      'a control character in the name',
      { ...base, client_name: `Spoo${BELL}ky` },
      'invalid_client_metadata',
    ],
    ['no redirect_uris', { client_name: 'Spooky' }, 'invalid_redirect_uri'],
    ['empty redirect_uris', { ...base, redirect_uris: [] }, 'invalid_redirect_uri'],
    ['a non-string redirect_uri', { ...base, redirect_uris: [42] }, 'invalid_redirect_uri'],
    [
      'an unsupported redirect_uri',
      { ...base, redirect_uris: ['javascript:alert(1)'] },
      'invalid_redirect_uri',
    ],
    [
      'redirect_uris over the length cap',
      { ...base, redirect_uris: [`https://app.example.com/${'a'.repeat(2000)}`] },
      'invalid_redirect_uri',
    ],
    [
      'a non-http client_uri',
      { ...base, client_uri: 'javascript:alert(1)' },
      'invalid_client_metadata',
    ],
    ['a body that is not an object', 'nope', 'invalid_client_metadata'],
  ])('refuses %s', (_label, body, error) => {
    expect(validateRegistration(body)).toMatchObject({ ok: false, error });
  });
});

describe('parseAuthorizeRequest', () => {
  const challenge = crypto
    .createHash('sha256')
    .update(crypto.randomBytes(32).toString('base64url'))
    .digest('base64url');
  const good = {
    client_id: 'client-abc',
    redirect_uri: OOB_REDIRECT_URI,
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'xyz',
  };

  it('accepts a well-formed request', () => {
    expect(parseAuthorizeRequest(good)).toEqual({
      ok: true,
      request: {
        clientId: 'client-abc',
        redirectUri: OOB_REDIRECT_URI,
        codeChallenge: challenge,
        state: 'xyz',
      },
    });
  });

  it('lets state be left out', () => {
    expect(parseAuthorizeRequest({ ...good, state: undefined })).toMatchObject({
      ok: true,
      request: { state: undefined },
    });
  });

  it.each([
    ['no client_id', { ...good, client_id: undefined }, 'invalid_request'],
    ['a repeated client_id', { ...good, client_id: ['a', 'b'] }, 'invalid_request'],
    ['no redirect_uri', { ...good, redirect_uri: undefined }, 'invalid_request'],
    ['response_type=token', { ...good, response_type: 'token' }, 'unsupported_response_type'],
    [
      'no PKCE',
      { ...good, code_challenge: undefined, code_challenge_method: undefined },
      'invalid_request',
    ],
    ['plain PKCE', { ...good, code_challenge_method: 'plain' }, 'invalid_request'],
    ['a malformed challenge', { ...good, code_challenge: 'too-short' }, 'invalid_request'],
    ['an oversized state', { ...good, state: 's'.repeat(1025) }, 'invalid_request'],
    ['a repeated state', { ...good, state: ['a', 'b'] }, 'invalid_request'],
  ])('refuses %s', (_label, source, error) => {
    expect(parseAuthorizeRequest(source as Record<string, unknown>)).toMatchObject({
      ok: false,
      error,
    });
  });
});
