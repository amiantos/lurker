// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { Router } from 'express';
import type { Request, Response } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import {
  listUsers,
  findUserById,
  deleteUser,
  countAdmins,
  setUserPaused,
  setUserIdent,
} from '../db/users.js';
import type { User } from '../db/users.js';
import {
  createInvite,
  listInvites,
  deleteInvite,
  getInvite,
  isInviteSpent,
} from '../db/invites.js';
import {
  createRecoveryToken,
  getRecoveryTokenForUser,
  deleteRecoveryTokensForUser,
  listRecoveryExpiries,
} from '../db/accountRecovery.js';
import ircManager from '../services/ircManager.js';
import { presenceDiagnostics } from '../services/wsHub.js';
import { isIdentdEnabled, isOidentdFileEnabled } from '../services/identd.js';
import { isNodeMode } from '../utils/edition.js';
import { deriveIdent, isValidIdentOverride, MAX_IDENT_LENGTH } from '../../shared/ident.js';
import adminUploadersRouter from './adminUploaders.js';
import adminNetworksRouter from './adminNetworks.js';
import adminStorageRouter from './adminStorage.js';

const router = Router();
router.use(requireAuth, requireAdmin);

// Instance uploaders + upload policy (#514). Its own module — it inherits the
// requireAuth + requireAdmin above.
router.use('/uploaders', adminUploadersRouter);

// Instance network presets + the network lockdown (#298). Same deal.
router.use('/networks', adminNetworksRouter);

// Storage stats + retention ceilings (lurker-dev/RETENTION_PLAN.md §3.4).
router.use('/storage', adminStorageRouter);

// invites.ts is still untyped — row shape inferred as any from the JS module
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function deriveInviteStatus(row: any): string {
  if (isInviteSpent(row)) return 'consumed';
  if (row.expiresAt && Date.parse(row.expiresAt) < Date.now()) return 'expired';
  return 'pending';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function publicInvite(row: any, { origin }: { origin: string }): Record<string, unknown> {
  return {
    token: row.token,
    url: `${origin}/invite/${row.token}`,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    usedAt: row.usedAt,
    usedByUsername: row.usedByUsername || null,
    createdByUsername: row.createdByUsername || null,
    status: deriveInviteStatus(row),
  };
}

// Prefer the browser-supplied Origin header so the link reflects the URL the
// admin is actually using — through Vite's dev proxy that's
// https://irc.local.bradroot.me:5173, and in prod it's whatever the public
// origin is, regardless of how the reverse proxy forwards to Express.
// req.protocol/req.get('host') would otherwise leak the upstream Express
// scheme + host (http://localhost:8010). Falls back to scheme://host for the
// rare request without an Origin header.
function originFromRequest(req: Request): string {
  const origin = req.get('origin');
  if (origin) return origin;
  return `${req.protocol}://${req.get('host')}`;
}

function effectiveIdent(u: User): string {
  return deriveIdent({
    nodeMode: isNodeMode(),
    accountUsername: u.username,
    accountIdent: u.ident,
  });
}

router.get('/users', (_req: Request, res: Response) => {
  const all = listUsers();
  // Accounts are only unique as USERNAMES, which are still looser than idents
  // (64 chars vs 16, and leading punctuation is legal in one but not the other),
  // so two of them can legitimately derive one ident — see shared/ident.ts for
  // the full list, which is longer on an instance with grandfathered names. No
  // signup path consults idents. The PUT below refuses to CREATE a collision,
  // but it can't prevent one arriving with a new account, and a silent duplicate
  // is precisely the ambiguity this feature exists to remove. Count them here so
  // the panel can show the operator which rows to settle with an override.
  const identCounts = new Map<string, number>();
  for (const u of all) {
    const key = effectiveIdent(u).toLowerCase();
    identCounts.set(key, (identCounts.get(key) ?? 0) + 1);
  }
  // One query for the whole roster rather than one per row — same shape as the
  // ident tally above. Per-user lookups here meant an instance with 200 accounts
  // prepared and ran 200 statements on every load of this screen.
  const recoveryExpiries = listRecoveryExpiries();
  res.json({
    users: all.map((u) => ({
      id: u.id,
      username: u.username,
      role: u.role,
      createdAt: u.created_at,
      lastSeenAt: u.last_seen_at,
      isPaused: !!u.is_paused,
      // The stored override (null = derived from the username) alongside what
      // the identd would actually answer, so the admin can see both without
      // re-deriving the rule in the client.
      ident: u.ident,
      effectiveIdent: effectiveIdent(u),
      // Another account answers this same ident — neither is attributable until
      // the operator assigns one of them something else.
      identConflict: (identCounts.get(effectiveIdent(u).toLowerCase()) ?? 0) > 1,
      // Whether an unredeemed recovery link is outstanding for this account
      // (#855). The token itself is never returned — only its hash is stored,
      // so re-showing a link is impossible by construction; an admin who lost
      // the URL issues a new one, which invalidates the old.
      recoveryExpiresAt: recoveryExpiries.get(u.id) ?? null,
    })),
    // Whether either ident mode is running. When neither is, the idents above
    // are inert — the UI says so rather than implying networks see them. (The
    // other half of the story, "may these be edited at all", is node edition,
    // which the client already knows from /api/config.)
    identdEnabled: isIdentdEnabled() || isOidentdFileEnabled(),
  });
});

// Assign (or clear, with null/'') an account's ident — the name a network sees
// in nick!ident@host for that member (#643). Admin-only on purpose: on a
// multi-user instance the ident is what lets an operator ban or blame ONE
// member of a shared IP, so a member who could pick their own could wear a
// neighbour's identity or churn away from a ban.
router.put('/users/:id/ident', (req: Request, res: Response) => {
  if (isNodeMode()) {
    // Hosted idents are `lu<controlPlaneAccountId>` — fleet-unique and stable
    // across cell moves. A cell-local override would break both.
    res.status(409).json({ error: 'the ident is managed by the control plane in node edition' });
    return;
  }
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: 'invalid id' });
    return;
  }
  const target = findUserById(id);
  if (!target) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const raw = req.body?.ident;
  if (raw != null && typeof raw !== 'string') {
    res.status(400).json({ error: 'ident must be a string' });
    return;
  }
  const value = (raw ?? '').trim();
  if (value && !isValidIdentOverride(value)) {
    res.status(400).json({
      error: `ident must start with a letter or number and use only letters, numbers, . _ - (max ${MAX_IDENT_LENGTH})`,
    });
    return;
  }
  const next = value || null;
  // Two members answering the same ident is the exact ambiguity the identd
  // exists to remove, so refuse to CREATE one. Compared case-insensitively (an
  // operator reading a ban list won't distinguish Bob from bob) and against
  // every other account's EFFECTIVE ident, not just the stored overrides —
  // most accounts derive theirs from the username.
  //
  // Clearing is exempt. The cleared value is the account's own default, which
  // the admin never chose and can't edit, so refusing it would trap the
  // override permanently — there'd be no way back to the default once some
  // other account's ident happened to match it. A duplicate that arises this
  // way is reported by identConflict above rather than made unfixable here.
  if (next) {
    const candidate = deriveIdent({
      nodeMode: false,
      accountUsername: target.username,
      accountIdent: next,
    }).toLowerCase();
    const clash = listUsers().find(
      (u) => u.id !== id && effectiveIdent(u).toLowerCase() === candidate,
    );
    if (clash) {
      res.status(409).json({ error: `that ident is already in use by ${clash.username}` });
      return;
    }
  }
  setUserIdent(id, next);
  const updated = findUserById(id)!;
  // Deliberately no reconnect: the ircd asks for the ident once, during
  // registration, so live connections keep the one they registered with until
  // they next connect. Saying so beats silently doing nothing.
  res.json({
    ok: true,
    ident: updated.ident,
    effectiveIdent: effectiveIdent(updated),
    appliesOnNextConnect: true,
  });
});

router.delete('/users/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: 'invalid id' });
    return;
  }
  const target = findUserById(id);
  if (!target) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  if (target.id === req.user!.id) {
    res.status(409).json({ error: 'cannot delete yourself' });
    return;
  }
  // Last-admin guard. Refusing to delete the only admin mirrors the
  // last-passkey behaviour — irreversible loss of control.
  if (target.role === 'admin' && countAdmins() <= 1) {
    res.status(409).json({ error: 'cannot delete the only admin' });
    return;
  }
  // Tear down the user's live IRC connections (and their WS sockets via the
  // 'user-disposed' listener in wsHub) BEFORE deleting the row, so any
  // in-flight events stop trying to persist against the about-to-be-deleted
  // networks. Otherwise the next incoming PRIVMSG crashes the process on a
  // FOREIGN KEY violation in messages.network_id.
  ircManager.disposeUser(id, 'user deleted');
  deleteUser(id);
  res.json({ ok: true });
});

// Pause/resume another account (self-hosted moderation): drop their live IRC and
// make them read-only, keeping all data — the same mechanism the control plane
// drives in node edition. Gated to standalone: in node edition the CP is the
// source of truth, and a cell-side pause would desync it (CP reconciliation
// re-asserts pauses but never resumes), so we refuse and let the CP own it.
router.post('/users/:id/pause', (req: Request, res: Response) => {
  if (isNodeMode()) {
    res
      .status(409)
      .json({ error: 'account state is managed by the control plane in node edition' });
    return;
  }
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: 'invalid id' });
    return;
  }
  const target = findUserById(id);
  if (!target) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  // Pausing yourself would lock you read-only with no obvious way back; the UI
  // disables it too, but guard the route as the source of truth.
  if (target.id === req.user!.id) {
    res.status(409).json({ error: 'cannot pause yourself' });
    return;
  }
  if (target.is_paused) {
    res.json({ ok: true, alreadyPaused: true });
    return;
  }
  // Flag first so the startNetwork gate is closed before suspendUser drops the
  // connections (no window for an in-flight reconnect to slip back in).
  setUserPaused(id, true);
  ircManager.suspendUser(id);
  res.json({ ok: true });
});

router.post('/users/:id/resume', (req: Request, res: Response) => {
  if (isNodeMode()) {
    res
      .status(409)
      .json({ error: 'account state is managed by the control plane in node edition' });
    return;
  }
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: 'invalid id' });
    return;
  }
  const target = findUserById(id);
  if (!target) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  if (!target.is_paused) {
    res.json({ ok: true, alreadyActive: true });
    return;
  }
  setUserPaused(id, false);
  ircManager.resumeUser(id);
  res.json({ ok: true });
});

// Issue a single-use recovery link for an account (#855). Accounts carry no
// email address, so this is the whole password-reset story: the admin hands the
// URL to the member over a channel they already trust, and redeeming it sets a
// password or enrolls a passkey.
//
// The response is the ONLY time this URL exists anywhere — only its hash is
// stored — so an admin who loses it issues a new one, which invalidates the old.
//
// Standalone only, like pause/resume. On a hosted cell the control plane owns
// sign-in (it holds cp_session and injects lurker_session) and has its own
// email-based reset, so a cell-local password set here is not what hosted login
// consults — and redeeming would drop CP-injected session rows the control
// plane still believes are live.
router.post('/users/:id/recovery', (req: Request, res: Response) => {
  if (isNodeMode()) {
    res.status(409).json({ error: 'sign-in is managed by the control plane in node edition' });
    return;
  }
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: 'invalid id' });
    return;
  }
  const user = findUserById(id);
  if (!user) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const token = createRecoveryToken(user.id, req.user!.id);
  const info = getRecoveryTokenForUser(user.id)!;
  res.json({
    recovery: {
      username: user.username,
      url: `${originFromRequest(req)}/recover/${token}`,
      expiresAt: info.expiresAt,
    },
  });
});

// Revoke an outstanding link — the admin's undo for one sent to the wrong
// person, or one no longer needed.
router.delete('/users/:id/recovery', (req: Request, res: Response) => {
  if (isNodeMode()) {
    res.status(409).json({ error: 'sign-in is managed by the control plane in node edition' });
    return;
  }
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: 'invalid id' });
    return;
  }
  if (!deleteRecoveryTokensForUser(id)) {
    res.status(404).json({ error: 'no outstanding recovery link' });
    return;
  }
  res.json({ ok: true });
});

// Read-only presence diagnostic. Surfaces, per connected user, how many WS
// sockets are open vs. how many the server believes are visible — the value
// auto-away keys on — plus the persisted away row. An open socket count that
// stays above visible/away counts, or a visible socket for a user who's
// plainly gone, is the zombie-socket signature the heartbeat reaps. Safe in
// both editions: it mutates nothing (unlike pause/resume, which are node-gated).
router.get('/presence', (_req: Request, res: Response) => {
  const presence = presenceDiagnostics().map((row) => {
    const u = findUserById(row.userId);
    return { ...row, username: u?.username ?? null };
  });
  res.json({ presence });
});

router.get('/invites', (req: Request, res: Response) => {
  const origin = originFromRequest(req);
  res.json({ invites: listInvites().map((r) => publicInvite(r, { origin })) });
});

router.post('/invites', (req: Request, res: Response) => {
  const requested = Number(req.body?.expiresInDays);
  const expiresInDays = Number.isFinite(requested) && requested > 0 ? requested : 7;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const row = createInvite(req.user!.id, { expiresInDays }) as any;
  const full = listInvites().find((r) => r.token === row?.token);
  const origin = originFromRequest(req);
  res.json({ invite: publicInvite(full || row, { origin }) });
});

router.delete('/invites/:token', (req: Request<{ token: string }>, res: Response) => {
  const token = req.params.token;
  if (!token) {
    res.status(400).json({ error: 'missing token' });
    return;
  }
  // Any invite can be removed, consumed ones included (#590). The 409 that used
  // to guard consumed rows called them audit history, but the list is a
  // management view, not an audit log — and it cannot be one either way, since
  // an invite now CASCADEs with the member it let in. Refusing the delete only
  // left admins with a roster of spent links they had no way to clear. Removing
  // a consumed row cannot revive anything: the row IS the invite, so deleting it
  // makes the token unknown rather than pending.
  const existing = getInvite(token);
  if (!existing) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  deleteInvite(token);
  res.json({ ok: true });
});

export default router;
