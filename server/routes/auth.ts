// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { Router } from 'express';
import type { Request, Response } from 'express';
import type {
  VerifiedRegistrationResponse,
  VerifiedAuthenticationResponse,
} from '@simplewebauthn/server';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';

import {
  findUserById,
  findUserByUsername,
  usernameTaken,
  countUsers,
  createUser,
  deleteUser,
  getPasswordHash,
  userHasPassword,
  setPasswordHash,
} from '../db/users.js';
import { inviteStatus, consumeInvite } from '../db/invites.js';
import { findLiveRecoveryToken, consumeRecoveryToken } from '../db/accountRecovery.js';
import { isValidUsername, isValidLoginUsername } from '../../shared/username.js';
import {
  listForUser as listCredentialsForUser,
  findByCredentialId,
  countAll as countAllCredentials,
  countForUser as countCredentialsForUser,
  insertCredential,
  updateCounter,
  updateLabel,
  deleteById as deleteCredentialById,
} from '../db/webauthnCredentials.js';
import { createSession, deleteSession, deleteSessionsForUser } from '../db/sessions.js';
import { SESSION_COOKIE, getCookieOptions, requireAuth, bearerToken } from '../middleware/auth.js';
import { rpConfig, saveChallenge, consumeChallenge, userIdToHandle } from '../services/webauthn.js';
import {
  hashPassword,
  verifyPassword,
  isValidPassword,
  passwordRequirementsMessage,
} from '../services/password.js';
import {
  guardCredentialAttempt,
  limitRequests,
  loginFailureThrottle,
  authRequestThrottle,
} from '../middleware/rateLimit.js';

const CHALLENGE_COOKIE = 'lurker_webauthn_challenge';

function challengeCookieOptions(): ReturnType<typeof getCookieOptions> & { maxAge: number } {
  // Short-lived, signed, scoped to the auth flow. Mirrors session cookie
  // security flags so it works under the same dev/prod settings.
  const base = getCookieOptions();
  return { ...base, maxAge: 5 * 60 * 1000 };
}

function setChallengeCookie(res: Response, token: string): void {
  res.cookie(CHALLENGE_COOKIE, token, challengeCookieOptions());
}

function clearChallengeCookie(res: Response): void {
  res.clearCookie(CHALLENGE_COOKIE, { ...challengeCookieOptions(), maxAge: undefined });
}

// webauthnCredentials.ts is still untyped — credential shape inferred as any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function publicCredential(c: any): Record<string, unknown> {
  return {
    id: c.id,
    label: c.label,
    deviceType: c.deviceType,
    backedUp: c.backedUp,
    transports: c.transports,
    createdAt: c.createdAt,
    lastUsedAt: c.lastUsedAt,
  };
}

const router = Router();

// Coarse per-IP request cap across the entire auth surface (options, invite probing,
// setup, auth-methods, ...) — a blanket flood/enumeration backstop. The credential
// endpoints below stack a much tighter failure throttle on top. Both are no-ops on an
// untrusted client key (fail open); see middleware/rateLimit.ts (#568).
router.use(limitRequests(authRequestThrottle));

// ---------- setup status ----------

// "Needs setup" means the system has no users yet — i.e. the very first run
// before the operator bootstraps their admin account. Once a user exists,
// further accounts come in through the invite flow, not this endpoint.
router.get('/setup-status', (_req: Request, res: Response) => {
  if (countUsers() === 0) {
    res.json({ needsSetup: true, mode: 'create-user' });
    return;
  }
  res.json({ needsSetup: false });
});

// ---------- setup / first-admin bootstrap ----------

// Open registration only while there are zero users. The first account
// created here is promoted to admin and gets exclusive control over invites
// and user management.
router.post('/setup/options', async (req: Request, res: Response) => {
  if (countUsers() > 0) {
    res.status(409).json({ error: 'setup already complete' });
    return;
  }
  const requested = (req.body?.username || '').trim();
  if (!isValidUsername(requested)) {
    res.status(400).json({ error: 'invalid username' });
    return;
  }
  if (usernameTaken(requested)) {
    res.status(409).json({ error: 'username already taken' });
    return;
  }
  const user = createUser(requested, { role: 'admin' });
  const { rpID, rpName } = rpConfig();
  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userName: user.username,
    userID: new Uint8Array(userIdToHandle(user.id)),
    userDisplayName: user.username,
    attestationType: 'none',
    authenticatorSelection: {
      residentKey: 'required',
      userVerification: 'preferred',
    },
    excludeCredentials: [],
  });

  const token = saveChallenge({
    purpose: 'setup',
    challenge: options.challenge,
    userId: user.id,
  });
  setChallengeCookie(res, token);
  res.json({ options, mode: 'create-user', username: user.username });
});

router.post('/setup/verify', async (req: Request, res: Response) => {
  const token = req.signedCookies?.[CHALLENGE_COOKIE];
  const entry = consumeChallenge(token);
  clearChallengeCookie(res);
  if (!entry || entry.purpose !== 'setup') {
    res.status(400).json({ error: 'no pending setup' });
    return;
  }
  // Race guard: if another tab finished setup between options and verify,
  // back out. We can't safely create credentials against the now-existing
  // admin from an anonymous request.
  if (countAllCredentials() > 0) {
    res.status(409).json({ error: 'setup already complete' });
    return;
  }
  const { rpID, expectedOrigin } = rpConfig();
  let verification: VerifiedRegistrationResponse;
  try {
    verification = await verifyRegistrationResponse({
      response: req.body?.response,
      expectedChallenge: entry.challenge as string,
      expectedOrigin,
      expectedRPID: rpID,
      requireUserVerification: false,
    });
  } catch (err) {
    const e = err as { message?: string };
    res.status(400).json({ error: e.message || 'verification failed' });
    return;
  }
  if (!verification.verified || !verification.registrationInfo) {
    res.status(400).json({ error: 'verification failed' });
    return;
  }

  const user = findUserById(entry.userId as number);
  if (!user) {
    res.status(500).json({ error: 'user vanished mid-setup' });
    return;
  }

  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
  const label = (req.body?.label || '').toString().trim().slice(0, 64) || null;
  insertCredential({
    userId: user.id,
    credentialId: credential.id,
    publicKey: Buffer.from(credential.publicKey),
    counter: credential.counter,
    transports: credential.transports || [],
    deviceType: credentialDeviceType,
    backedUp: credentialBackedUp,
    label,
  });

  const { token: sessionToken } = createSession(user.id);
  res.cookie(SESSION_COOKIE, sessionToken, getCookieOptions());
  res.json({ user: { id: user.id, username: user.username, role: user.role } });
});

// Password-only first-admin setup. Mirrors /setup/options + /setup/verify but
// skips the WebAuthn dance — operator picks a username and password and is
// signed in straight away. They can add a passkey later from settings.
router.post('/setup/password', (req: Request, res: Response) => {
  if (countUsers() > 0) {
    res.status(409).json({ error: 'setup already complete' });
    return;
  }
  const requested = (req.body?.username || '').trim();
  const password: unknown = req.body?.password;
  if (!isValidUsername(requested)) {
    res.status(400).json({ error: 'invalid username' });
    return;
  }
  if (!isValidPassword(password)) {
    res.status(400).json({ error: passwordRequirementsMessage() });
    return;
  }
  if (usernameTaken(requested)) {
    res.status(409).json({ error: 'username already taken' });
    return;
  }
  const user = createUser(requested, { role: 'admin' });
  setPasswordHash(user.id, hashPassword(password as string));
  const { token: sessionToken } = createSession(user.id);
  res.cookie(SESSION_COOKIE, sessionToken, getCookieOptions());
  res.json({ user: { id: user.id, username: user.username, role: user.role } });
});

// ---------- invite redemption ----------

// Public status probe. Returns the bare minimum the UI needs to render the
// landing page — no info about who created the invite or for whom.
router.get('/invite/:token', (req: Request<{ token: string }>, res: Response) => {
  const result = inviteStatus(req.params.token);
  if (result.status === 'valid') {
    res.json({ valid: true });
    return;
  }
  if (result.status === 'expired') {
    res.json({ valid: false, expired: true });
    return;
  }
  res.json({ valid: false });
});

router.post('/invite/:token/options', async (req: Request<{ token: string }>, res: Response) => {
  const result = inviteStatus(req.params.token);
  if (result.status !== 'valid') {
    res.status(404).json({ error: 'invalid or used invite' });
    return;
  }
  const requested = (req.body?.username || '').trim();
  if (!isValidUsername(requested)) {
    res.status(400).json({ error: 'invalid username' });
    return;
  }
  if (usernameTaken(requested)) {
    res.status(409).json({ error: 'username already taken' });
    return;
  }
  // Create the user up-front so we have a stable webauthn user handle for the
  // registration options. If the user abandons the flow we end up with a
  // username-squatter the admin can remove, mirroring the existing setup
  // flow's tradeoff.
  const user = createUser(requested, { role: 'user' });
  const { rpID, rpName } = rpConfig();
  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userName: user.username,
    userID: new Uint8Array(userIdToHandle(user.id)),
    userDisplayName: user.username,
    attestationType: 'none',
    authenticatorSelection: {
      residentKey: 'required',
      userVerification: 'preferred',
    },
    excludeCredentials: [],
  });
  const token = saveChallenge({
    purpose: 'invite',
    challenge: options.challenge,
    userId: user.id,
    inviteToken: req.params.token,
  });
  setChallengeCookie(res, token);
  res.json({ options, username: user.username });
});

router.post('/invite/:token/verify', async (req: Request<{ token: string }>, res: Response) => {
  const challengeToken = req.signedCookies?.[CHALLENGE_COOKIE];
  const entry = consumeChallenge(challengeToken);
  clearChallengeCookie(res);
  if (!entry || entry.purpose !== 'invite' || entry.inviteToken !== req.params.token) {
    res.status(400).json({ error: 'no pending invite' });
    return;
  }
  const entryUserId = entry.userId as number;
  // Re-check the invite right before committing. Status may have changed
  // between options and verify (admin revoke, parallel redemption).
  if (inviteStatus(req.params.token).status !== 'valid') {
    deleteUser(entryUserId);
    res.status(409).json({ error: 'invite is no longer valid' });
    return;
  }
  const { rpID, expectedOrigin } = rpConfig();
  let verification: VerifiedRegistrationResponse;
  try {
    verification = await verifyRegistrationResponse({
      response: req.body?.response,
      expectedChallenge: entry.challenge as string,
      expectedOrigin,
      expectedRPID: rpID,
      requireUserVerification: false,
    });
  } catch (err) {
    deleteUser(entryUserId);
    const e = err as { message?: string };
    res.status(400).json({ error: e.message || 'verification failed' });
    return;
  }
  if (!verification.verified || !verification.registrationInfo) {
    deleteUser(entryUserId);
    res.status(400).json({ error: 'verification failed' });
    return;
  }

  const user = findUserById(entryUserId);
  if (!user) {
    res.status(500).json({ error: 'user vanished mid-setup' });
    return;
  }

  // Atomic consume — only one parallel redemption can win. If we lose,
  // tear down the user we created and surface the conflict.
  if (!consumeInvite(req.params.token, user.id)) {
    deleteUser(user.id);
    res.status(409).json({ error: 'invite is no longer valid' });
    return;
  }

  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
  const label = (req.body?.label || '').toString().trim().slice(0, 64) || null;
  insertCredential({
    userId: user.id,
    credentialId: credential.id,
    publicKey: Buffer.from(credential.publicKey),
    counter: credential.counter,
    transports: credential.transports || [],
    deviceType: credentialDeviceType,
    backedUp: credentialBackedUp,
    label,
  });

  const { token: sessionToken } = createSession(user.id);
  res.cookie(SESSION_COOKIE, sessionToken, getCookieOptions());
  res.json({ user: { id: user.id, username: user.username, role: user.role } });
});

// Password redemption of an invite. Mirrors /invite/:token/options +
// /invite/:token/verify but with no WebAuthn dance.
router.post('/invite/:token/password', (req: Request<{ token: string }>, res: Response) => {
  const result = inviteStatus(req.params.token);
  if (result.status !== 'valid') {
    res.status(404).json({ error: 'invalid or used invite' });
    return;
  }
  const requested = (req.body?.username || '').trim();
  const password: unknown = req.body?.password;
  if (!isValidUsername(requested)) {
    res.status(400).json({ error: 'invalid username' });
    return;
  }
  if (!isValidPassword(password)) {
    res.status(400).json({ error: passwordRequirementsMessage() });
    return;
  }
  if (usernameTaken(requested)) {
    res.status(409).json({ error: 'username already taken' });
    return;
  }
  const user = createUser(requested, { role: 'user' });
  // Atomic consume — only one parallel redemption can win. If we lose,
  // tear down the user we just created and surface the conflict.
  if (!consumeInvite(req.params.token, user.id)) {
    deleteUser(user.id);
    res.status(409).json({ error: 'invite is no longer valid' });
    return;
  }
  setPasswordHash(user.id, hashPassword(password as string));
  const { token: sessionToken } = createSession(user.id);
  res.cookie(SESSION_COOKIE, sessionToken, getCookieOptions());
  res.json({ user: { id: user.id, username: user.username, role: user.role } });
});

// ---------- account recovery ----------

// Redemption of an admin-issued recovery link (#855). An account has no email
// address, so there is no self-service reset to build: an admin issues a link
// for one account and hands it over out of band, and redeeming it adds a
// sign-in method back to an account its owner is locked out of.
//
// Every path here ends in finishRecovery(), which signs the account out
// everywhere before minting the new session: the lockout that made recovery
// necessary is indistinguishable from a takeover, so any session predating the
// recovery is assumed hostile. (An already-open WebSocket survives until it
// disconnects — see deleteSessionsForUser and #567.) Existing passkeys are
// deliberately left alone — recovery restores a way in, it is not a way to
// strip someone's credentials.

function finishRecovery(res: Response, user: { id: number; username: string; role: string }): void {
  deleteSessionsForUser(user.id);
  const { token: sessionToken } = createSession(user.id);
  res.cookie(SESSION_COOKIE, sessionToken, getCookieOptions());
  res.json({ user: { id: user.id, username: user.username, role: user.role } });
}

// Public status probe for the landing page. An expired link and a token that
// was never real answer identically — the page is the same dead end either way,
// and distinguishing them would confirm a token had once existed. The username
// comes back because the page needs to name the account being recovered, and
// whoever holds this link can already take that account over.
router.get('/recovery/:token', (req: Request<{ token: string }>, res: Response) => {
  const info = findLiveRecoveryToken(req.params.token);
  const user = info ? findUserById(info.userId) : null;
  if (!user) {
    res.json({ valid: false });
    return;
  }
  res.json({
    valid: true,
    username: user.username,
    expiresAt: info!.expiresAt,
    // Whether the page offers "set a password" or "change your password".
    hasPassword: userHasPassword(user.id),
  });
});

// Set a password with a recovery link. The password is validated BEFORE the
// token is spent, so a too-short one doesn't burn a single-use link.
//
// guardCredentialAttempt shares this IP's login backoff — it turns away a
// caller already being throttled, and clears that state on success. It does NOT
// count failures here: it records only on 401, and a dead link answers 400.
// That's deliberate rather than an oversight. Nothing on this route is
// guessable — the token is 32 random bytes — so failure backoff would buy
// nothing, while the router-wide limitRequests(authRequestThrottle) above
// already caps how fast anyone can probe the auth surface at all.
router.post(
  '/recovery/:token/password',
  guardCredentialAttempt(loginFailureThrottle),
  (req: Request<{ token: string }>, res: Response) => {
    const password: unknown = req.body?.password;
    if (!isValidPassword(password)) {
      res.status(400).json({ error: passwordRequirementsMessage() });
      return;
    }
    const userId = consumeRecoveryToken(req.params.token);
    if (userId === null) {
      res.status(400).json({ error: 'that recovery link is invalid or has expired' });
      return;
    }
    const user = findUserById(userId);
    if (!user) {
      // The row CASCADEs with the account, so this means the account was deleted
      // between the consume and this read.
      res.status(404).json({ error: 'that account no longer exists' });
      return;
    }
    setPasswordHash(user.id, hashPassword(password as string));
    finishRecovery(res, user);
  },
);

// Enroll a fresh passkey with a recovery link — the half of this feature a
// password-only reset would miss, since a passkey-only member who lost their
// phone has no password to reset. Mirrors /passkeys/options, but authorized by
// the link instead of a session.
router.post('/recovery/:token/options', async (req: Request<{ token: string }>, res: Response) => {
  const info = findLiveRecoveryToken(req.params.token);
  const user = info ? findUserById(info.userId) : null;
  if (!user) {
    res.status(404).json({ error: 'invalid or expired recovery link' });
    return;
  }
  const { rpID, rpName } = rpConfig();
  // listCredentialsForUser is untyped — credentials are any[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const existing = listCredentialsForUser(user.id) as any[];
  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userName: user.username,
    userID: new Uint8Array(userIdToHandle(user.id)),
    userDisplayName: user.username,
    attestationType: 'none',
    authenticatorSelection: {
      residentKey: 'required',
      userVerification: 'preferred',
    },
    // The authenticators already on the account. Usually none of them are the
    // one in the member's hand — that's why they're here — but excluding them
    // keeps a still-enrolled device from silently registering itself twice.
    excludeCredentials: existing.map((c) => ({
      id: c.credentialId,
      transports: c.transports,
    })),
  });
  const token = saveChallenge({
    purpose: 'recovery',
    challenge: options.challenge,
    userId: user.id,
    recoveryToken: req.params.token,
  });
  setChallengeCookie(res, token);
  res.json({ options, username: user.username });
});

router.post('/recovery/:token/verify', async (req: Request<{ token: string }>, res: Response) => {
  const challengeToken = req.signedCookies?.[CHALLENGE_COOKIE];
  const entry = consumeChallenge(challengeToken);
  clearChallengeCookie(res);
  if (!entry || entry.purpose !== 'recovery' || entry.recoveryToken !== req.params.token) {
    res.status(400).json({ error: 'no pending recovery' });
    return;
  }
  const { rpID, expectedOrigin } = rpConfig();
  let verification: VerifiedRegistrationResponse;
  try {
    verification = await verifyRegistrationResponse({
      response: req.body?.response,
      expectedChallenge: entry.challenge as string,
      expectedOrigin,
      expectedRPID: rpID,
      requireUserVerification: false,
    });
  } catch (err) {
    const e = err as { message?: string };
    res.status(400).json({ error: e.message || 'verification failed' });
    return;
  }
  if (!verification.verified || !verification.registrationInfo) {
    res.status(400).json({ error: 'verification failed' });
    return;
  }

  // Spend the link only once the authenticator has answered, so a failed or
  // abandoned ceremony leaves it usable. Nothing has been written yet, so losing
  // this race needs no cleanup — unlike the invite flow, which has a
  // speculatively-created account to tear down.
  const userId = consumeRecoveryToken(req.params.token);
  if (userId === null || userId !== (entry.userId as number)) {
    res.status(409).json({ error: 'that recovery link is no longer valid' });
    return;
  }
  const user = findUserById(userId);
  if (!user) {
    res.status(404).json({ error: 'that account no longer exists' });
    return;
  }

  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
  const label = (req.body?.label || '').toString().trim().slice(0, 64) || null;
  insertCredential({
    userId: user.id,
    credentialId: credential.id,
    publicKey: Buffer.from(credential.publicKey),
    counter: credential.counter,
    transports: credential.transports || [],
    deviceType: credentialDeviceType,
    backedUp: credentialBackedUp,
    label,
  });
  finishRecovery(res, user);
});

// ---------- login ----------

router.post('/login/options', async (_req: Request, res: Response) => {
  // Returns options only when at least one passkey exists. The client also
  // probes /auth-methods to know whether to even surface the passkey button,
  // so this 409 mostly guards against stale clients calling out of order.
  if (countAllCredentials() === 0) {
    res.status(409).json({ error: 'no passkeys registered' });
    return;
  }
  const { rpID } = rpConfig();
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: 'preferred',
    // Empty allowCredentials lets the browser surface any discoverable
    // (resident-key) passkey for this RP — no username field needed.
    allowCredentials: [],
  });
  const token = saveChallenge({
    purpose: 'login',
    challenge: options.challenge,
  });
  setChallengeCookie(res, token);
  res.json({ options });
});

router.post(
  '/login/verify',
  guardCredentialAttempt(loginFailureThrottle),
  async (req: Request, res: Response) => {
    const token = req.signedCookies?.[CHALLENGE_COOKIE];
    const entry = consumeChallenge(token);
    clearChallengeCookie(res);
    if (!entry || entry.purpose !== 'login') {
      res.status(400).json({ error: 'no pending login' });
      return;
    }
    const response = req.body?.response;
    const credentialId = response?.id;
    if (!credentialId) {
      res.status(400).json({ error: 'missing credential id' });
      return;
    }

    // webauthnCredentials.ts is untyped — stored is any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stored = findByCredentialId(credentialId) as any;
    if (!stored) {
      res.status(401).json({ error: 'unknown credential' });
      return;
    }

    const { rpID, expectedOrigin } = rpConfig();
    let verification: VerifiedAuthenticationResponse;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: entry.challenge as string,
        expectedOrigin,
        expectedRPID: rpID,
        credential: {
          id: stored.credentialId,
          publicKey: new Uint8Array(stored.publicKey),
          counter: stored.counter,
          transports: stored.transports,
        },
        requireUserVerification: false,
      });
    } catch (err) {
      const e = err as { message?: string };
      res.status(400).json({ error: e.message || 'verification failed' });
      return;
    }
    if (!verification.verified) {
      res.status(401).json({ error: 'verification failed' });
      return;
    }

    updateCounter(stored.id, verification.authenticationInfo.newCounter);

    const user = findUserById(stored.userId);
    if (!user) {
      res.status(500).json({ error: 'user no longer exists' });
      return;
    }

    const { token: sessionToken } = createSession(user.id);
    res.cookie(SESSION_COOKIE, sessionToken, getCookieOptions());
    res.json({ user: { id: user.id, username: user.username, role: user.role } });
  },
);

// Dummy hash with valid format and the real algorithm parameters. Verifying
// against it on a username-miss costs the same scrypt work as a real verify,
// so response time doesn't leak whether the account exists. Salt/digest are
// fixed zero bytes — no secret value.
const DUMMY_PASSWORD_HASH = `scrypt$32768$8$1$${Buffer.alloc(16).toString('base64')}$${Buffer.alloc(64).toString('base64')}`;

router.post(
  '/login/password',
  guardCredentialAttempt(loginFailureThrottle),
  (req: Request, res: Response) => {
    const username = (req.body?.username || '').trim();
    const password: unknown = req.body?.password;
    if (!isValidLoginUsername(username) || typeof password !== 'string' || password.length === 0) {
      res.status(400).json({ error: 'username and password required' });
      return;
    }
    const user = findUserByUsername(username);
    const stored = user ? getPasswordHash(user.id) : null;
    const ok = verifyPassword(password, stored || DUMMY_PASSWORD_HASH);
    if (!user || !stored || !ok) {
      res.status(401).json({ error: 'invalid username or password' });
      return;
    }
    const { token: sessionToken } = createSession(user.id);
    res.cookie(SESSION_COOKIE, sessionToken, getCookieOptions());
    res.json({ user: { id: user.id, username: user.username, role: user.role } });
  },
);

// Password → session token, for clients that have no browser to hold a cookie.
// This is the native-app front door (iOS/Android): same credentials and same
// `sessions` row as POST /login/password above, but the token is returned in the
// body instead of a Set-Cookie, and the app then presents it as
// `Authorization: Bearer <token>` on both REST calls and the /ws upgrade.
//
// Deliberately NOT a new kind of credential: a native session is an ordinary
// session row, so expiry, lookup, and revocation all work exactly as they do
// for the web client.
//
// SECURITY: this is a public, unauthenticated, password-in / long-lived-token-out
// endpoint — the most attractive credential-stuffing target on the cell. It shares
// /login/password's constant-time miss behavior via DUMMY_PASSWORD_HASH and, as of
// #568, the same per-IP failure throttle (guardCredentialAttempt above): repeated
// failures from an IP back off with 429 before scrypt runs.
router.post(
  '/login/token',
  guardCredentialAttempt(loginFailureThrottle),
  (req: Request, res: Response) => {
    const username = (req.body?.username || '').trim();
    const password: unknown = req.body?.password;
    if (!isValidLoginUsername(username) || typeof password !== 'string' || password.length === 0) {
      res.status(400).json({ error: 'username and password required' });
      return;
    }
    const user = findUserByUsername(username);
    const stored = user ? getPasswordHash(user.id) : null;
    const ok = verifyPassword(password, stored || DUMMY_PASSWORD_HASH);
    if (!user || !stored || !ok) {
      res.status(401).json({ error: 'invalid username or password' });
      return;
    }
    const { token, expiresAt } = createSession(user.id);
    res.json({
      token,
      expiresAt,
      user: { id: user.id, username: user.username, role: user.role },
    });
  },
);

// Public probe so the login UI can decide which sign-in buttons to surface.
// Currently just reports whether any passkey exists anywhere — discoverable
// passkey login doesn't need a username, so a single global flag is enough.
router.get('/auth-methods', (_req: Request, res: Response) => {
  res.json({ passkey: countAllCredentials() > 0 });
});

// ---------- session ----------

router.post('/logout', (req: Request, res: Response) => {
  // Cookie for web, bearer for native — a native client has no cookie to clear,
  // so without the bearer branch its "log out" would leave a live session row
  // behind and the token on the device would keep working.
  const token = req.signedCookies?.[SESSION_COOKIE] ?? bearerToken(req.headers.authorization);
  if (token) deleteSession(token);
  res.clearCookie(SESSION_COOKIE, { ...getCookieOptions(), maxAge: undefined });
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req: Request, res: Response) => {
  res.json({
    user: {
      id: req.user!.id,
      username: req.user!.username,
      role: req.user!.role,
      is_paused: !!req.user!.is_paused,
    },
  });
});

// ---------- passkey management (authed) ----------

router.get('/passkeys', requireAuth, (req: Request, res: Response) => {
  res.json({ passkeys: listCredentialsForUser(req.user!.id).map(publicCredential) });
});

router.post('/passkeys/options', requireAuth, async (req: Request, res: Response) => {
  const { rpID, rpName } = rpConfig();
  // listCredentialsForUser is untyped — credentials are any[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const existing = listCredentialsForUser(req.user!.id) as any[];
  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userName: req.user!.username,
    userID: new Uint8Array(userIdToHandle(req.user!.id)),
    userDisplayName: req.user!.username,
    attestationType: 'none',
    authenticatorSelection: {
      residentKey: 'required',
      userVerification: 'preferred',
    },
    excludeCredentials: existing.map((c) => ({
      id: c.credentialId,
      transports: c.transports,
    })),
  });
  const token = saveChallenge({
    purpose: 'add-passkey',
    challenge: options.challenge,
    userId: req.user!.id,
  });
  setChallengeCookie(res, token);
  res.json({ options });
});

router.post('/passkeys/verify', requireAuth, async (req: Request, res: Response) => {
  const token = req.signedCookies?.[CHALLENGE_COOKIE];
  const entry = consumeChallenge(token);
  clearChallengeCookie(res);
  if (!entry || entry.purpose !== 'add-passkey' || (entry.userId as number) !== req.user!.id) {
    res.status(400).json({ error: 'no pending registration' });
    return;
  }
  const { rpID, expectedOrigin } = rpConfig();
  let verification: VerifiedRegistrationResponse;
  try {
    verification = await verifyRegistrationResponse({
      response: req.body?.response,
      expectedChallenge: entry.challenge as string,
      expectedOrigin,
      expectedRPID: rpID,
      requireUserVerification: false,
    });
  } catch (err) {
    const e = err as { message?: string };
    res.status(400).json({ error: e.message || 'verification failed' });
    return;
  }
  if (!verification.verified || !verification.registrationInfo) {
    res.status(400).json({ error: 'verification failed' });
    return;
  }
  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
  const label = (req.body?.label || '').toString().trim().slice(0, 64) || null;
  const stored = insertCredential({
    userId: req.user!.id,
    credentialId: credential.id,
    publicKey: Buffer.from(credential.publicKey),
    counter: credential.counter,
    transports: credential.transports || [],
    deviceType: credentialDeviceType,
    backedUp: credentialBackedUp,
    label,
  });
  res.json({ passkey: publicCredential(stored) });
});

router.patch('/passkeys/:id', requireAuth, (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: 'invalid id' });
    return;
  }
  const label = (req.body?.label || '').toString().trim().slice(0, 64) || null;
  const ok = updateLabel(id, req.user!.id, label);
  if (!ok) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json({ ok: true });
});

router.delete('/passkeys/:id', requireAuth, (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: 'invalid id' });
    return;
  }
  // Removing the last passkey is only safe if the user can still sign in
  // another way. Right now that's a password.
  if (countCredentialsForUser(req.user!.id) <= 1 && !userHasPassword(req.user!.id)) {
    res
      .status(409)
      .json({ error: 'cannot remove your only sign-in method — set a password first' });
    return;
  }
  const ok = deleteCredentialById(id, req.user!.id);
  if (!ok) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json({ ok: true });
});

// ---------- password management (authed) ----------

router.get('/password', requireAuth, (req: Request, res: Response) => {
  res.json({ hasPassword: userHasPassword(req.user!.id) });
});

router.put(
  '/password',
  requireAuth,
  guardCredentialAttempt(loginFailureThrottle),
  (req: Request, res: Response) => {
    const password: unknown = req.body?.password;
    const currentPassword: unknown = req.body?.currentPassword;
    if (!isValidPassword(password)) {
      res.status(400).json({ error: passwordRequirementsMessage() });
      return;
    }
    // Require the current password when one already exists, so a stolen session
    // cookie can't lock the real owner out by silently rotating it.
    if (userHasPassword(req.user!.id)) {
      const stored = getPasswordHash(req.user!.id);
      if (typeof currentPassword !== 'string' || !verifyPassword(currentPassword, stored)) {
        res.status(401).json({ error: 'current password is incorrect' });
        return;
      }
    }
    setPasswordHash(req.user!.id, hashPassword(password as string));
    res.json({ ok: true, hasPassword: true });
  },
);

router.delete('/password', requireAuth, (req: Request, res: Response) => {
  // Can't drop the last sign-in method.
  if (countCredentialsForUser(req.user!.id) === 0) {
    res.status(409).json({ error: 'cannot remove your only sign-in method — add a passkey first' });
    return;
  }
  setPasswordHash(req.user!.id, null);
  res.json({ ok: true, hasPassword: false });
});

export default router;
