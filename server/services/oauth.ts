// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import crypto from 'crypto';

// Request validation for the OAuth 2 authorization server (#891). Pure functions,
// no storage, so every rule here is unit-testable on its own.
//
// Registration is open, so anyone can register an app with any name and any
// redirect it likes. The rules below exist to keep that from becoming a phishing
// or open-redirect tool: redirect URIs come from a short allowlist of shapes, a
// requested redirect must match a registered one, and PKCE binds each code to
// whoever started the flow.

/** RFC 8252's out-of-band redirect: show the code for the member to copy. */
export const OOB_REDIRECT_URI = 'urn:ietf:wg:oauth:2.0:oob';

export const MAX_CLIENT_NAME_LENGTH = 60;
export const MAX_REDIRECT_URIS_LENGTH = 2000;
export const MAX_CLIENT_URI_LENGTH = 2000;
export const MAX_STATE_LENGTH = 1024;

// Printable ASCII only. The WHATWG URL parser silently strips tabs and newlines
// and trims leading control characters, so `java\tscript:` would sail past a
// scheme check done on the raw string and then run as javascript: once a browser
// navigates to it. Refusing anything outside 0x21-0x7E closes that before the
// parser gets a say.
const PRINTABLE_ASCII = /^[\x21-\x7E]+$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]']);
const SCHEME = /^[a-z][a-z0-9+.-]*$/;
const CODE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const CODE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

// The approval page leads with the app's name, so a name that reorders or hides
// text on screen is refused: C0/C1 controls and the bidi embedding, override and
// isolate characters.
function hasUnsafeNameChar(name: string): boolean {
  for (const ch of name) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f)) return true;
    if ((cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069)) return true;
  }
  return false;
}

/**
 * Whether a redirect URI may be registered. An allowlist of four shapes:
 *
 *   - `https:` — a claimed https link (Universal Links, App Links) or a web page
 *   - `http:` on 127.0.0.1 or [::1] — a desktop or CLI app listening locally
 *   - a reverse-DNS custom scheme such as `com.example.app:` (RFC 8252 §7.1),
 *     which also keeps out `mailto:`, `javascript:` and every other short scheme
 *   - the out-of-band URN
 */
export function isValidRedirectUri(raw: string): boolean {
  if (raw === OOB_REDIRECT_URI) return true;
  if (!PRINTABLE_ASCII.test(raw) || raw.includes('#')) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol === 'https:') return url.hostname !== '';
  if (url.protocol === 'http:') return LOOPBACK_HOSTS.has(url.hostname);
  const scheme = url.protocol.slice(0, -1);
  return SCHEME.test(scheme) && scheme.includes('.');
}

function parseLoopback(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' || url.username || url.password) return null;
  return LOOPBACK_HOSTS.has(url.hostname) ? url : null;
}

/**
 * Whether a redirect requested at authorization matches one the app registered.
 * Exact string equality, with one exception from RFC 8252 §7.3: a loopback
 * redirect matches on any port, because a CLI picks a free port when it starts.
 * Everything else about the loopback URI -- host, path, query -- must still be
 * identical, and it is compared on the PARSED URI so `127.0.0.1.evil.com` or
 * `127.0.0.1@evil.com` can never pass as a prefix match.
 */
export function matchRedirectUri(registered: readonly string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  if (!PRINTABLE_ASCII.test(requested) || requested.includes('#')) return false;
  const wanted = parseLoopback(requested);
  if (!wanted) return false;
  return registered.some((candidate) => {
    const url = parseLoopback(candidate);
    return (
      url !== null &&
      url.hostname === wanted.hostname &&
      url.pathname === wanted.pathname &&
      url.search === wanted.search
    );
  });
}

/** Where an approval lands, for the approval page to say in plain words. */
export type RedirectDestination =
  | { kind: 'code' }
  | { kind: 'loopback' }
  | { kind: 'app'; scheme: string }
  | { kind: 'web'; host: string };

export function redirectDestination(uri: string): RedirectDestination {
  if (uri === OOB_REDIRECT_URI) return { kind: 'code' };
  const url = new URL(uri);
  if (url.protocol === 'http:') return { kind: 'loopback' };
  if (url.protocol === 'https:') return { kind: 'web', host: url.host };
  return { kind: 'app', scheme: url.protocol.slice(0, -1) };
}

/** Add query parameters to a redirect URI, keeping any it already carries. */
export function withQuery(uri: string, params: Record<string, string | undefined>): string {
  const url = new URL(uri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}

/** The host of an app's `client_uri`, or null. Shown on the approval page, never trusted. */
export function hostOf(uri: string | null): string | null {
  if (!uri) return null;
  try {
    return new URL(uri).host || null;
  } catch {
    return null;
  }
}

/** RFC 7636 S256: BASE64URL(SHA256(verifier)) must equal the stored challenge. */
export function verifyPkceS256(verifier: string, challenge: string): boolean {
  if (!CODE_VERIFIER.test(verifier) || !CODE_CHALLENGE.test(challenge)) return false;
  const computed = Buffer.from(crypto.createHash('sha256').update(verifier).digest('base64url'));
  const expected = Buffer.from(challenge);
  return computed.length === expected.length && crypto.timingSafeEqual(computed, expected);
}

export interface ClientMetadata {
  clientName: string;
  clientUri: string | null;
  redirectUris: string[];
}

export type RegistrationResult =
  | { ok: true; metadata: ClientMetadata }
  | { ok: false; error: 'invalid_redirect_uri' | 'invalid_client_metadata'; description: string };

const badMetadata = (description: string): RegistrationResult => ({
  ok: false,
  error: 'invalid_client_metadata',
  description,
});
const badRedirect = (description: string): RegistrationResult => ({
  ok: false,
  error: 'invalid_redirect_uri',
  description,
});

/**
 * Validate an RFC 7591 registration body. Only the fields Lurker uses are read.
 * Everything a client may ask for that Lurker has exactly one answer to --
 * `scope`, `grant_types`, `response_types`, `token_endpoint_auth_method` -- is
 * ignored rather than refused; RFC 7591 lets the server replace requested
 * metadata, and the response says what the client actually got.
 */
export function validateRegistration(body: unknown): RegistrationResult {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return badMetadata('the registration must be a JSON object');
  }
  const fields = body as Record<string, unknown>;

  const clientName = typeof fields.client_name === 'string' ? fields.client_name.trim() : '';
  if (!clientName) return badMetadata('client_name is required');
  if ([...clientName].length > MAX_CLIENT_NAME_LENGTH) {
    return badMetadata(`client_name must be at most ${MAX_CLIENT_NAME_LENGTH} characters`);
  }
  if (hasUnsafeNameChar(clientName)) {
    return badMetadata('client_name contains control or text-direction characters');
  }

  const uris = fields.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0) {
    return badRedirect('redirect_uris must be a non-empty array');
  }
  if (!uris.every((u): u is string => typeof u === 'string')) {
    return badRedirect('every redirect_uri must be a string');
  }
  const redirectUris = [...new Set(uris)];
  if (redirectUris.join('').length > MAX_REDIRECT_URIS_LENGTH) {
    return badRedirect(`redirect_uris must total at most ${MAX_REDIRECT_URIS_LENGTH} characters`);
  }
  if (!redirectUris.every(isValidRedirectUri)) {
    return badRedirect(
      `each redirect_uri must be https, http on 127.0.0.1 or [::1], a reverse-DNS app scheme, or ${OOB_REDIRECT_URI}`,
    );
  }

  let clientUri: string | null = null;
  if (fields.client_uri !== undefined && fields.client_uri !== null) {
    const raw = fields.client_uri;
    let valid = false;
    if (
      typeof raw === 'string' &&
      raw.length <= MAX_CLIENT_URI_LENGTH &&
      PRINTABLE_ASCII.test(raw)
    ) {
      try {
        const protocol = new URL(raw).protocol;
        valid = protocol === 'https:' || protocol === 'http:';
      } catch {
        valid = false;
      }
    }
    if (!valid) return badMetadata('client_uri must be an http or https URL');
    clientUri = raw as string;
  }

  return { ok: true, metadata: { clientName, clientUri, redirectUris } };
}

export interface AuthorizeRequest {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string | undefined;
}

export type AuthorizeParse =
  | { ok: true; request: AuthorizeRequest }
  | { ok: false; error: string; description: string };

/**
 * Check the shape of an authorization request (query string or JSON body).
 * Doesn't look the client up; the route does that. Every parameter must be a
 * single string -- a repeated query parameter arrives as an array and is refused.
 */
const invalidRequest = (description: string): AuthorizeParse => ({
  ok: false,
  error: 'invalid_request',
  description,
});

export function parseAuthorizeRequest(source: Record<string, unknown>): AuthorizeParse {
  const str = (key: string): string | undefined =>
    typeof source[key] === 'string' ? (source[key] as string) : undefined;

  const clientId = str('client_id');
  if (!clientId) return invalidRequest('client_id is required');
  const redirectUri = str('redirect_uri');
  if (!redirectUri) return invalidRequest('redirect_uri is required');
  if (str('response_type') !== 'code') {
    return {
      ok: false,
      error: 'unsupported_response_type',
      description: 'response_type must be code',
    };
  }
  if (str('code_challenge_method') !== 'S256') {
    return invalidRequest('PKCE is required: code_challenge_method must be S256');
  }
  const codeChallenge = str('code_challenge');
  if (!codeChallenge || !CODE_CHALLENGE.test(codeChallenge)) {
    return invalidRequest('code_challenge must be 43 base64url characters');
  }
  const state = source.state === undefined ? undefined : str('state');
  if (source.state !== undefined && (state === undefined || state.length > MAX_STATE_LENGTH)) {
    return invalidRequest(`state must be a string of at most ${MAX_STATE_LENGTH} characters`);
  }
  return { ok: true, request: { clientId, redirectUri, codeChallenge, state } };
}
