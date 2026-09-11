// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import express, { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { requireAuth, requireCookieSession } from '../middleware/auth.js';
import { RequestThrottle, limitRequests } from '../middleware/rateLimit.js';
import { closeSocketsForOAuthTokens } from '../services/wsHub.js';
import { isNodeMode } from '../utils/edition.js';
import { publicBaseUrl } from '../utils/publicOrigin.js';
import {
  MAX_PENDING_APPS,
  consumeCode,
  countPendingApps,
  createApp,
  createCode,
  createToken,
  deleteOAuthForApp,
  deleteTokenForClient,
  findAppByClientId,
  listAuthorizedApps,
  purgeOAuth,
} from '../db/oauth.js';
import type { OAuthApp } from '../db/oauth.js';
import {
  OOB_REDIRECT_URI,
  hostOf,
  matchRedirectUri,
  parseAuthorizeRequest,
  redirectDestination,
  validateRegistration,
  verifyPkceS256,
  withQuery,
} from '../services/oauth.js';
import type { AuthorizeRequest } from '../services/oauth.js';

// OAuth 2 authorization server for third-party clients (#891), on Mastodon's
// model: any client registers itself, the member approves it in the browser, and
// the token the client gets has the same access as a password sign-in.
//
// Public clients only. With open registration a client secret proves nothing --
// anyone can register their own -- so every app authenticates with its client_id
// alone and PKCE S256 binds each code to whoever started the flow. Tokens never
// expire and there are no refresh tokens; revoking deletes the token and closes
// every socket it opened.
//
// A cell in node edition runs all of this except registration. One registration
// is valid on every cell, so the orchestrator in front of them keeps the registry
// (routes/node.ts), and every code and token a cell mints starts with its name so
// the orchestrator can route it back (oauthRoutingPrefix in utils/edition.ts).

export const oauthRouter = Router();

// Mastodon's figure for its own open registration endpoint. Behind a reverse
// proxy without LURKER_TRUST_PROXY every client shares one key, which the docs say.
export const registrationThrottle = new RequestThrottle({ windowMs: 10 * 60_000, maxRequests: 5 });

// RFC 6749 token and revocation requests are form-encoded. Parsed on these two
// routes only: a global urlencoded parser would let a cross-site form post to
// every cookie-authenticated route, which JSON-only parsing currently prevents.
const formBody = express.urlencoded({ extended: false, limit: '16kb' });

function noStore(res: Response): void {
  res.set('Cache-Control', 'no-store');
  res.set('Pragma', 'no-cache');
}

function oauthError(res: Response, status: number, error: string, description: string): void {
  res.status(status).json({ error, error_description: description });
}

// A parameter is only ever a single string. Express turns a repeated parameter
// into an array, and anything that isn't a string reads as absent.
function param(body: unknown, key: string): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

// ---------- registration (RFC 7591) ----------

// A node's orchestrator takes registrations for the whole fleet (see above), so a
// cell refuses them before they count against anyone's limit.
function registrationUnavailableInNodeMode(_req: Request, res: Response, next: NextFunction): void {
  if (!isNodeMode()) {
    next();
    return;
  }
  res.status(404).json({ error: 'registration is managed by the control plane' });
}

oauthRouter.post(
  '/register',
  registrationUnavailableInNodeMode,
  limitRequests(registrationThrottle),
  (req: Request, res: Response) => {
    noStore(res);
    const result = validateRegistration(req.body);
    if (!result.ok) {
      oauthError(res, 400, result.error, result.description);
      return;
    }
    // The throttle bounds one address; this bounds the table, whatever the source.
    // Approved apps don't count, and unapproved ones are purged after an hour. The
    // hourly sweep can leave an expired registration in place for up to another
    // hour, so a full table is swept before anyone is turned away.
    if (countPendingApps() >= MAX_PENDING_APPS) purgeOAuth();
    if (countPendingApps() >= MAX_PENDING_APPS) {
      res.set('Retry-After', '3600');
      oauthError(
        res,
        429,
        'temporarily_unavailable',
        'too many unapproved registrations; try later',
      );
      return;
    }
    const app = createApp(result.metadata);
    res.status(201).json({
      client_id: app.clientId,
      client_id_issued_at: Math.floor(Date.parse(app.createdAt) / 1000),
      client_name: app.clientName,
      ...(app.clientUri ? { client_uri: app.clientUri } : {}),
      redirect_uris: app.redirectUris,
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
  },
);

// ---------- authorization (the approval page's API) ----------

type ResolvedAuthorize =
  | { ok: true; app: OAuthApp; request: AuthorizeRequest }
  | { ok: false; error: string; description: string };

function resolveAuthorize(source: Record<string, unknown>): ResolvedAuthorize {
  const parsed = parseAuthorizeRequest(source);
  if (!parsed.ok) return parsed;
  const app = findAppByClientId(parsed.request.clientId);
  if (!app) return { ok: false, error: 'invalid_client', description: 'unknown client_id' };
  if (!matchRedirectUri(app.redirectUris, parsed.request.redirectUri)) {
    return {
      ok: false,
      error: 'invalid_redirect_uri',
      description: 'redirect_uri is not registered for this app',
    };
  }
  return { ok: true, app, request: parsed.request };
}

// Both authorize routes take the browser's session cookie and nothing else. The
// approval page is the only way a token gets minted, so a client holding a
// password-login bearer session can't approve an app for itself without it.
//
// Neither ever redirects on an error. Registration is open, so an attacker can
// register any redirect they like; bouncing a signed-in member there from a bad
// request would make Lurker an open redirector (RFC 9700 §4.11.2). Errors are
// shown on the page, and only the member's own Approve or Deny click navigates.

oauthRouter.get('/authorize', requireCookieSession, (req: Request, res: Response) => {
  noStore(res);
  const resolved = resolveAuthorize(req.query as Record<string, unknown>);
  if (!resolved.ok) {
    oauthError(res, 400, resolved.error, resolved.description);
    return;
  }
  const { clientId, redirectUri, codeChallenge, state } = resolved.request;
  res.json({
    app: { name: resolved.app.clientName, website: hostOf(resolved.app.clientUri) },
    destination: redirectDestination(redirectUri),
    // The request exactly as read and checked here. The page posts these values
    // back on Approve or Deny instead of re-reading its own URL: a second parser
    // can read a crafted query string differently (this one stops at 1000 keys,
    // URLSearchParams doesn't), which would show one app and approve another.
    request: {
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      ...(state !== undefined ? { state } : {}),
    },
  });
});

oauthRouter.post('/authorize', requireCookieSession, (req: Request, res: Response) => {
  noStore(res);
  // JSON only: a cross-site HTML form can't send it, and the cookie is the
  // credential here.
  if (!req.is('application/json')) {
    oauthError(res, 415, 'invalid_request', 'send the decision as application/json');
    return;
  }
  const resolved = resolveAuthorize((req.body ?? {}) as Record<string, unknown>);
  if (!resolved.ok) {
    oauthError(res, 400, resolved.error, resolved.description);
    return;
  }
  const { redirectUri, state, codeChallenge } = resolved.request;
  const outOfBand = redirectUri === OOB_REDIRECT_URI;
  const decision = param(req.body, 'decision');
  if (decision === 'deny') {
    res.json(
      outOfBand
        ? { denied: true }
        : { redirect: withQuery(redirectUri, { error: 'access_denied', state }) },
    );
    return;
  }
  if (decision !== 'approve') {
    oauthError(res, 400, 'invalid_request', 'decision must be approve or deny');
    return;
  }
  const code = createCode({
    appId: resolved.app.id,
    userId: req.user!.id,
    redirectUri,
    codeChallenge,
  });
  res.json(outOfBand ? { code } : { redirect: withQuery(redirectUri, { code, state }) });
});

// ---------- token + revocation ----------

oauthRouter.post('/token', formBody, (req: Request, res: Response) => {
  noStore(res);
  const grantType = param(req.body, 'grant_type');
  if (grantType === undefined) {
    oauthError(res, 400, 'invalid_request', 'grant_type is required');
    return;
  }
  if (grantType !== 'authorization_code') {
    oauthError(res, 400, 'unsupported_grant_type', 'only authorization_code is supported');
    return;
  }
  const clientId = param(req.body, 'client_id');
  const code = param(req.body, 'code');
  const redirectUri = param(req.body, 'redirect_uri');
  const codeVerifier = param(req.body, 'code_verifier');
  if (!clientId || !code || !redirectUri || !codeVerifier) {
    oauthError(
      res,
      400,
      'invalid_request',
      'client_id, code, redirect_uri and code_verifier are required',
    );
    return;
  }
  // Identify the client BEFORE touching the code, so a request that can't even
  // name a real app can't burn someone else's code.
  const app = findAppByClientId(clientId);
  if (!app) {
    oauthError(res, 401, 'invalid_client', 'unknown client_id');
    return;
  }
  // Spent first, checked second: a code presented with the wrong client,
  // redirect or verifier has been seen by someone it wasn't issued to.
  const grant = consumeCode(code);
  if (
    !grant ||
    grant.appId !== app.id ||
    grant.redirectUri !== redirectUri ||
    !verifyPkceS256(codeVerifier, grant.codeChallenge)
  ) {
    oauthError(
      res,
      400,
      'invalid_grant',
      'the code is invalid, expired, already used, or was issued to another request',
    );
    return;
  }
  res.json({
    access_token: createToken(app.id, grant.userId),
    token_type: 'Bearer',
    created_at: Math.floor(Date.now() / 1000),
  });
});

oauthRouter.post('/revoke', formBody, (req: Request, res: Response) => {
  noStore(res);
  const clientId = param(req.body, 'client_id');
  const token = param(req.body, 'token');
  if (!clientId || !token) {
    oauthError(res, 400, 'invalid_request', 'client_id and token are required');
    return;
  }
  if (!findAppByClientId(clientId)) {
    oauthError(res, 401, 'invalid_client', 'unknown client_id');
    return;
  }
  const revoked = deleteTokenForClient(token, clientId);
  if (revoked) closeSocketsForOAuthTokens(revoked.userId, [revoked.id], 'app access revoked');
  // RFC 7009: 200 whether or not the token existed, so this can't probe for tokens.
  res.status(200).json({});
});

// ---------- the member's authorized apps (Settings) ----------

oauthRouter.get('/apps', requireAuth, (req: Request, res: Response) => {
  res.json({ apps: listAuthorizedApps(req.user!.id) });
});

oauthRouter.delete('/apps/:id', requireAuth, (req: Request, res: Response) => {
  const appId = Number(req.params.id);
  if (!Number.isInteger(appId) || appId <= 0) {
    res.status(400).json({ error: 'invalid id' });
    return;
  }
  const tokenIds = deleteOAuthForApp(req.user!.id, appId);
  if (tokenIds.length === 0) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  closeSocketsForOAuthTokens(req.user!.id, tokenIds, 'app access revoked');
  res.json({ ok: true });
});

// ---------- discovery (RFC 8414) ----------

export const wellKnownRouter = Router();

wellKnownRouter.get('/oauth-authorization-server', (req: Request, res: Response) => {
  const issuer = publicBaseUrl(req);
  if (!issuer) {
    res.status(500).json({ error: 'cannot work out this server’s URL; set PUBLIC_BASE_URL' });
    return;
  }
  noStore(res);
  res.json({
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/api/oauth/token`,
    revocation_endpoint: `${issuer}/api/oauth/revoke`,
    registration_endpoint: `${issuer}/api/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    service_documentation: 'https://docs.lurker.chat/OAUTH',
  });
});
