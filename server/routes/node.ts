// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { Router } from 'express';
import type { Request, Response } from 'express';
import { requireNodeAuth } from '../middleware/nodeAuth.js';
import { getEdition } from '../utils/edition.js';
import { APP_VERSION } from '../utils/userAgent.js';
import { isValidUsername } from '../../shared/username.js';
import {
  countUsers,
  createUser,
  deleteUser,
  findUserById,
  findUserByUsername,
  usernameTaken,
  setUserPaused,
} from '../db/users.js';
import { markUploadRemovedById } from '../db/uploadHistory.js';
import { deleteOAuthForUser, upsertAppFromFleet } from '../db/oauth.js';
import { validateRegistration } from '../services/oauth.js';
import { closeSocketsForOAuthTokens } from '../services/wsHub.js';
import ircManager from '../services/ircManager.js';
import { sign as signCookie } from 'cookie-signature';
import { createSession } from '../db/sessions.js';
import { SESSION_COOKIE, getCookieOptions } from '../middleware/auth.js';

// Orchestrator-driven control surface for a cell. Mounted only in node edition
// (see server.ts behind isNodeMode()), and every route requires the node secret
// — a trust channel entirely separate from tenant sessions/api_tokens. A tenant
// can never reach this.
const router = Router();
router.use(requireNodeAuth);

// Health + capacity. `users.count` is the TOTAL provisioned accounts on this
// cell (not currently-online users) — that's the figure fill-then-pin placement
// keys on, since a cell's load is the tenants assigned to it. A4 will push the
// same shape on a heartbeat.
router.get('/status', (_req: Request, res: Response) => {
  res.json({
    edition: getEdition(),
    version: APP_VERSION,
    users: { count: countUsers() },
  });
});

// Provision a tenant account. The orchestrator owns identity, so this creates
// the bare account row only; wiring how a provisioned user gets a session on
// the cell is the routing/session-ownership work (B3). Role is ALWAYS 'user' —
// a SaaS tenant must never be admin (the cell's lone admin is the operator), so
// any role in the body is deliberately ignored.
router.post('/users', (req: Request, res: Response) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  // Same rule as the human signup/auth flows so a node-provisioned account is
  // valid everywhere (length bounds + charset, no control characters).
  if (!isValidUsername(username)) {
    res.status(400).json({ error: 'invalid username' });
    return;
  }
  // Case-insensitive: 'acct-5' and 'ACCT-5' are the same tenant, and the
  // orchestrator retrying with different case must reconcile, not create a
  // second row.
  const taken = usernameTaken(username);
  const existing = taken ? findUserByUsername(username) : undefined;
  if (existing) {
    // Surface the existing id so a retried provision can reconcile rather than
    // guess. Deliberately not an idempotent 200 — a real username clash should
    // be visible to the orchestrator.
    res.status(409).json({ error: 'username already exists', id: existing.id });
    return;
  }
  if (taken) {
    // Taken, but by MORE THAN ONE row that folds to this name — only possible on
    // a cell carrying grandfathered case-twins, which hosted provisioning
    // (`acct-<id>`) never creates. The cell genuinely cannot say which account to
    // reconcile to, and guessing would bind a paying customer to the wrong row,
    // so this fails and asks for a human. `id` is OMITTED rather than sent as
    // null: the control plane recovers a 409 only when an id is present
    // (cellClient.ts provisionUserOnCell), so this deliberately lands as
    // provision_failed instead of a silent mis-reconcile.
    res.status(409).json({
      error:
        'username matches more than one existing account (case-insensitive); resolve on the cell',
    });
    return;
  }
  const user = createUser(username); // role defaults to 'user'
  res.status(201).json({ id: user.id, username: user.username });
});

// Deprovision a tenant account: tear down live IRC + WS first (mirrors the
// admin delete path, so an in-flight PRIVMSG can't hit a FK violation on the
// about-to-vanish rows), then hard-delete — per-user FKs cascade.
router.delete('/users/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'invalid id' });
    return;
  }
  const target = findUserById(id);
  if (!target) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  // The orchestrator manages tenants, never the operator — refuse to delete an
  // admin through the node API.
  if (target.role === 'admin') {
    res.status(409).json({ error: 'refusing to delete an admin account' });
    return;
  }
  ircManager.disposeUser(id, 'deprovisioned');
  deleteUser(id);
  res.json({ ok: true });
});

// Mint a real cell session for a provisioned tenant and return the signed
// `lurker_session` cookie value. The reverse proxy sets this on the customer's
// browser, so the cell authenticates them through its OWN existing session
// logic — HTTP (requireAuth) and the WS upgrade alike — with no new trust path.
// Fleet-authenticated; never reachable by a tenant.
router.post('/users/:id/session', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'invalid id' });
    return;
  }
  const target = findUserById(id);
  if (!target) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  // The operator's admin account is not a tenant — never mint a session for it
  // through the node API (D1 × node-mode invariant).
  if (target.role === 'admin') {
    res.status(409).json({ error: 'refusing to mint a session for an admin account' });
    return;
  }
  // Sign with the exact secret cookie-parser validates with (attached to req by
  // the cookieParser middleware) — always accepted by the cell's normal auth,
  // no per-request disk IO, no chance of divergence from the live key.
  const secret = req.secret;
  if (!secret) {
    res.status(500).json({ error: 'session secret unavailable' });
    return;
  }
  const { token } = createSession(id);
  const value = 's:' + signCookie(token, secret);
  res.json({ cookieName: SESSION_COOKIE, value, maxAgeMs: getCookieOptions().maxAge });
});

// Pause a tenant account: flip the read-only flag and tear down live IRC, but
// keep all data and the session (the opposite of DELETE). The control plane
// calls this when an account is suspended / past-due / canceled — the cell
// stays billing-blind and only mirrors this one verdict. Idempotent: re-pausing
// an already-paused account is a no-op success, which is what the orchestrator's
// reconciliation sweep relies on.
router.post('/users/:id/pause', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'invalid id' });
    return;
  }
  const target = findUserById(id);
  if (!target) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  // The operator's admin account is not a tenant — never let the orchestrator
  // pause it (mirrors the delete/session guards).
  if (target.role === 'admin') {
    res.status(409).json({ error: 'refusing to pause an admin account' });
    return;
  }
  // Already paused → quiet no-op. The orchestrator's reconciliation re-pushes
  // pauses on every cell heartbeat; short-circuiting here keeps that sweep from
  // re-running suspendUser + re-fanning the read-only event every 30s.
  if (target.is_paused) {
    res.json({ ok: true, alreadyPaused: true });
    return;
  }
  // Flag first so the startNetwork gate is already closed before suspendUser
  // drops the connections — no window for an in-flight reconnect to slip back in.
  setUserPaused(id, true);
  ircManager.suspendUser(id);
  res.json({ ok: true });
});

// Resume a paused tenant account: clear the flag, then re-establish autoconnect
// networks. Idempotent. Order matters — setUserPaused(false) must land before
// resumeUser so the startNetwork gate lets the reconnect through.
router.post('/users/:id/resume', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'invalid id' });
    return;
  }
  const target = findUserById(id);
  if (!target) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  if (target.role === 'admin') {
    res.status(409).json({ error: 'refusing to resume an admin account' });
    return;
  }
  // Already active → quiet no-op, so a redundant resume doesn't re-init networks.
  if (!target.is_paused) {
    res.json({ ok: true, alreadyActive: true });
    return;
  }
  setUserPaused(id, false);
  ircManager.resumeUser(id);
  res.json({ ok: true });
});

// Moderation takedown: the control plane has removed an upload's object from
// storage and tells the cell to tombstone the owner's history row (flip it to
// `removed`, drop any inline thumbnail). `:id` is the cell's own upload_history
// id. Idempotent; a missing row is a 404 the CP treats as success (nothing to
// tombstone), mirroring the pause/deprovision endpoints.
router.post('/uploads/:id/takedown', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'invalid id' });
    return;
  }
  if (!markUploadRemovedById(id)) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json({ ok: true });
});

// OAuth (#891). One registration is valid on every cell, so the orchestrator keeps
// the registry and a cell takes none itself (routes/oauth.ts). The orchestrator
// checks each registration here, under the rules a self-hosted server applies,
// before telling the client it registered, and hands a cell each app a member is
// about to approve. Idempotent: an app a cell already holds keeps its metadata.
const CLIENT_ID = /^[A-Za-z0-9_-]{1,256}$/;

router.put('/oauth/apps/:clientId', (req: Request, res: Response) => {
  const clientId = String(req.params.clientId);
  if (!CLIENT_ID.test(clientId)) {
    res.status(400).json({ error: 'invalid client_id' });
    return;
  }
  const result = validateRegistration(req.body);
  if (!result.ok) {
    res.status(400).json({ error: result.error, error_description: result.description });
    return;
  }
  const app = upsertAppFromFleet(clientId, result.metadata);
  res.json({
    client_id: app.clientId,
    client_name: app.clientName,
    ...(app.clientUri ? { client_uri: app.clientUri } : {}),
    redirect_uris: app.redirectUris,
  });
});

// Revoke every app a tenant approved: their tokens, any code not yet exchanged,
// and the sockets those tokens opened. The orchestrator calls this when the
// member resets their password, as account recovery does on a self-hosted server.
// Idempotent; an unknown user is a 404 the orchestrator treats as done.
router.post('/users/:id/oauth/revoke', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'invalid id' });
    return;
  }
  const target = findUserById(id);
  if (!target) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  if (target.role === 'admin') {
    res.status(409).json({ error: 'refusing to revoke apps for an admin account' });
    return;
  }
  const tokenIds = deleteOAuthForUser(id);
  closeSocketsForOAuthTokens(id, tokenIds, 'app access revoked');
  res.json({ ok: true, revoked: tokenIds.length });
});

export default router;
