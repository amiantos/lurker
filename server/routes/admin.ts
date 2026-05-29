// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { Router } from 'express';
import type { Request, Response } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { listUsers, findUserById, deleteUser, countAdmins } from '../db/users.js';
import { createInvite, listInvites, deleteInvite, getInvite } from '../db/invites.js';
import ircManager from '../services/ircManager.js';

const router = Router();
router.use(requireAuth, requireAdmin);

// invites.ts is still untyped — row shape inferred as any from the JS module
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function deriveInviteStatus(row: any): string {
  if (row.usedByUserId != null) return 'consumed';
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

router.get('/users', (_req: Request, res: Response) => {
  res.json({
    users: listUsers().map((u) => ({
      id: u.id,
      username: u.username,
      role: u.role,
      createdAt: u.created_at,
      lastSeenAt: u.last_seen_at,
    })),
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
  // Refuse to delete consumed invites — they're audit history (which user
  // joined via which admin's invitation). Pending/expired are fair game.
  const existing = getInvite(token);
  if (!existing) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  if (existing.usedByUserId != null) {
    res.status(409).json({ error: 'cannot delete a consumed invite' });
    return;
  }
  deleteInvite(token);
  res.json({ ok: true });
});

export default router;
