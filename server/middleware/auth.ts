// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import type { CookieOptions, NextFunction, Request, Response } from 'express';
import { findSession } from '../db/sessions.js';
import type { Session } from '../db/sessions.js';
import { findUserById, touchUserLastSeen } from '../db/users.js';
import type { User } from '../db/users.js';

export const SESSION_COOKIE = 'lurker_session';
// The control plane's session cookie (mirrors lurker-control-plane's
// middleware/session.ts CP_SESSION_COOKIE; same cookie options as ours). On a
// hosted cell a tenant request only reaches us because the reverse proxy
// accepted cp_session and then injected the lurker_session it minted — so when
// we can't honor that lurker_session (e.g. the cell's SESSION_SECRET rotated on
// a rebuild, invalidating the signature), the fix is to clear BOTH cookies and
// let the client bounce to the sign-in page for a clean re-auth, rather than
// leave a valid cp_session paired with a dead lurker_session that never recovers.
export const CP_SESSION_COOKIE = 'cp_session';

export function getCookieOptions(): CookieOptions {
  // Secure is opt-in via COOKIE_SECURE=true. Tying it to NODE_ENV silently
  // breaks the common self-hosted shapes: LAN hostnames over plain HTTP, and
  // proxies (Cloudflare Tunnel, reverse proxies) that terminate TLS upstream
  // and connect to the container in cleartext — in both cases the browser
  // drops Secure cookies and the user appears logged in but the session
  // cookie never lands. Operators serving Lurker over true end-to-end HTTPS
  // can flip this on to harden against cleartext-network eavesdropping.
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === 'true',
    signed: true,
    path: '/',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  };
}

export function loadSession(req: Request): { session: Session; user: User } | null {
  const token = req.signedCookies?.[SESSION_COOKIE];
  if (!token) return null;
  const session = findSession(token);
  if (!session) return null;
  const user = findUserById(session.user_id);
  if (!user) return null;
  return { session, user };
}

// Native clients (iOS/Android) authenticate with `Authorization: Bearer <token>`
// instead of a cookie — they can set headers on a WebSocket upgrade, which
// browsers cannot, and that is exactly why the web client stays cookie-bound.
//
// The bearer here IS a session token: the same opaque `sessions.token` the
// cookie carries, just handed to the app in a response body rather than wrapped
// in a Set-Cookie (see POST /api/auth/login/token). So this resolves through the
// unmodified findSession path and a native session is a real session row —
// revoking one is deleting a row, and expiry works as it always has.
//
// This does NOT collide with the API-token bearer (middleware/apiAuth.ts): that
// one is mounted only on /mcp, so the two bearer namespaces never meet on the
// same route.
export function bearerToken(authorization: string | undefined): string | null {
  const match = /^Bearer\s+(\S+)$/.exec(authorization ?? '');
  return match ? match[1] : null;
}

export function loadBearerSession(
  authorization: string | undefined,
): { session: Session; user: User } | null {
  const token = bearerToken(authorization);
  if (!token) return null;
  const session = findSession(token);
  if (!session) return null;
  const user = findUserById(session.user_id);
  if (!user) return null;
  return { session, user };
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  // Cookie first (every web request), bearer second (native only) — so the hot
  // path is unchanged and a native request costs one extra header regex.
  const ctx = loadSession(req) ?? loadBearerSession(req.headers.authorization);
  if (!ctx) {
    // If the request carried a lurker_session we can't honor — a stale cookie
    // whose signature no longer verifies (cell SESSION_SECRET rotated on a
    // rebuild → it lands in req.cookies, not req.signedCookies) or whose session
    // row is gone — clear it AND cp_session. A refresh then deletes both dead
    // cookies and the reverse proxy serves the sign-in page, so the user re-auths
    // cleanly instead of getting wedged with a good cp_session + dead session.
    // A request with NO lurker_session never reaches here on a hosted cell (the
    // proxy mints one when absent), and on standalone there's no cp_session to
    // clear — so gating the clear on "a session cookie was present" is safe.
    // Detect that from the RAW Cookie header: cookie-parser drops a
    // bad-signature signed cookie from both req.cookies and req.signedCookies
    // (the SESSION_SECRET-rotation case), so neither reflects that one was sent.
    const hadStaleSession = (req.headers.cookie ?? '')
      .split(/;\s*/)
      .some((c) => c.startsWith(`${SESSION_COOKIE}=`));
    if (hadStaleSession) {
      const clearOpts = { ...getCookieOptions(), maxAge: undefined };
      res.clearCookie(SESSION_COOKIE, clearOpts);
      res.clearCookie(CP_SESSION_COOKIE, clearOpts);
    }
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  req.user = ctx.user;
  req.session = ctx.session;
  touchUserLastSeen(ctx.user.id);
  next();
}

// Stack on top of requireAuth. Returns 403 (not 401) so the client knows the
// session is fine but the user just lacks the role — different from a missing
// or expired cookie, which the auth-store redirect handler reacts to.
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  if (req.user.role !== 'admin') {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  next();
}

// Read-only gate for paused accounts. Stack on top of requireAuth. GET/HEAD
// reads fall through so a paused user can still browse their history; any
// mutating method gets a clean 403. The authoritative block on IRC traffic is
// the startNetwork gate in ircManager — this just turns what would be a silent
// no-op into a clear error and stops a paused user from mutating network config.
export function blockWritesWhenPaused(req: Request, res: Response, next: NextFunction): void {
  if (req.user?.is_paused && req.method !== 'GET' && req.method !== 'HEAD') {
    res.status(403).json({ error: 'account paused' });
    return;
  }
  next();
}
