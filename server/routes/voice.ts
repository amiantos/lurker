// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { Router } from 'express';
import type { Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { getNetwork } from '../db/networks.js';
import ircManager from '../services/ircManager.js';
import {
  isChannelTarget,
  mintVoiceToken,
  roomFor,
  voiceEnabled,
} from '../services/voice.js';

// The write path for voice: mint a LiveKit access token scoped to one call room.
// Lurker is the token authority only — it never carries media. Authenticated by
// requireAuth (browser cookie OR native bearer), then gated three ways:
//   1. voiceEnabled() — operator opt-in + a configured SFU, else 503.
//   2. getNetwork(id, user) — you can only call on a network you own, else 404.
//   3. for a channel target, you must actually be *in* the channel — else 403.
//      (A DM has no such check: opening a call IS the invitation.)
// The room name is derived server-side from (networkId, target, your live nick),
// so a client cannot ask for a token to an arbitrary room.

const router = Router();
router.use(requireAuth);

router.post('/token', async (req: Request, res: Response) => {
  if (!voiceEnabled()) {
    res.status(503).json({ error: 'voice not enabled on this server' });
    return;
  }

  const networkId = Number(req.body?.networkId);
  const target = typeof req.body?.target === 'string' ? req.body.target.trim() : '';
  if (!Number.isInteger(networkId) || networkId <= 0) {
    res.status(400).json({ error: 'networkId required' });
    return;
  }
  if (!target) {
    res.status(400).json({ error: 'target required' });
    return;
  }

  // Ownership: getNetwork returns undefined for a network this user doesn't own.
  const network = getNetwork(networkId, req.user!.id);
  if (!network) {
    res.status(404).json({ error: 'network not found' });
    return;
  }

  // We need the live connection for the caller's current nick (the call
  // identity) and, for a channel, to confirm membership. No connection → the
  // network is disconnected, so there is nobody to call with.
  const conn = ircManager.getConnection(req.user!.id, networkId);
  if (!conn || !conn.currentNick) {
    res.status(409).json({ error: 'network not connected' });
    return;
  }

  if (isChannelTarget(target) && !conn.channels.has(target.toLowerCase())) {
    res.status(403).json({ error: 'not a member of that channel' });
    return;
  }

  const room = roomFor(networkId, target, conn.currentNick);
  try {
    const minted = await mintVoiceToken({ identity: conn.currentNick, room });
    res.json(minted); // { token, room, url }
  } catch {
    res.status(500).json({ error: 'failed to mint token' });
  }
});

export default router;
