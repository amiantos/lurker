// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Admin → Notifications: the opt-in to push.lurker.chat for the official apps
// (lurker-dev/RELAY_PLAN.md §5a). Mounted under routes/admin.ts, so requireAuth +
// requireAdmin are inherited.
//
// The VAPID public key is here because it's what the admin registers with the
// relay when paying — /api/push/config has it too, but nobody should need
// devtools to find it.
//
// The relay's status (§6.5) is only fetched once the admin has opted in, or when
// they ask with "check": until then this server doesn't contact the relay at all.

import { Router } from 'express';
import type { Request, Response } from 'express';
import { getPublicKey, vapidSubjectStatus } from '../services/pushService.js';
import { senderFor } from '../services/push/index.js';
import { PUSH_TRANSPORTS } from '../db/pushSubscriptions.js';
import { pushRelayEnabled } from '../db/instanceSettings.js';
import { RELAY_ORIGIN, relayDeviceCount, setRelayEnabled } from '../services/push/relay.js';
import { peekRelayStatus, relayStatus, type RelayStatus } from '../services/push/relayStatus.js';
import { listPushLog } from '../db/pushLog.js';
import { parseBefore, parseLogLimit } from './push.js';

const router = Router();

function payload(status: RelayStatus | null) {
  return {
    publicKey: getPublicKey(),
    vapidSubject: vapidSubjectStatus(),
    transports: PUSH_TRANSPORTS.filter((t) => senderFor(t).isConfigured()),
    relay: {
      url: RELAY_ORIGIN,
      enabled: pushRelayEnabled(),
      devices: relayDeviceCount(),
      status,
    },
  };
}

// Every PUT /relay takes a number. Turning on waits for the relay's answer, and an
// off (or another on) that finished meanwhile must not be overwritten by it.
let toggleGeneration = 0;

router.get('/', (_req: Request, res: Response) => {
  // Never waits on the relay: the last answer, refreshed in the background.
  res.json(payload(pushRelayEnabled() ? peekRelayStatus() : null));
});

// The status alone, for the pane after it loads: the GET above never waits, so
// this is how a background refresh (or a cold cache after a restart) reaches it.
// Waits for the shared request, bounded by its timeout. Only while opted in:
// otherwise this server doesn't contact the relay, and the answer is null.
router.get('/relay/status', async (_req: Request, res: Response) => {
  res.json({ status: pushRelayEnabled() ? await relayStatus() : null });
});

// The admin asking, before turning the relay on (or any time after). (Express 5
// passes a rejected handler promise to the error handler.)
router.post('/relay/check', async (_req: Request, res: Response) => {
  res.json(payload(await relayStatus({ fresh: true })));
});

router.put('/relay', async (req: Request, res: Response) => {
  const enabled = req.body?.enabled;
  if (typeof enabled !== 'boolean') {
    res.status(400).json({ error: 'enabled must be a boolean' });
    return;
  }
  const generation = ++toggleGeneration;
  // Turning on asks the relay first: with the key not active there, every push
  // would be refused and count against the devices. Turning off never asks, and
  // a failed check never switches an enabled relay off. The words for a refusal
  // are the pane's: it renders `relay.status`, the one place they live.
  let status: RelayStatus | null = null;
  if (enabled) {
    status = await relayStatus({ fresh: true });
    if (generation !== toggleGeneration) {
      // Another change landed while we waited; it stands.
      res.status(409).json({ code: 'superseded', ...payload(status) });
      return;
    }
    if (status.state !== 'active') {
      res.status(409).json({ code: 'relay_inactive', ...payload(status) });
      return;
    }
  }
  const removed = setRelayEnabled(enabled);
  res.json({ ...payload(status), removed });
});

// Every user's push log (#1272), newest first, with the username on each row;
// `?user=<id>` narrows it to one. What an admin pastes into a bug report when
// someone says the relay dropped a notification.
router.get('/log', (req: Request, res: Response) => {
  const raw = req.query.user;
  let userId: number | null = null;
  if (raw !== undefined) {
    userId = Number(raw);
    if (!Number.isInteger(userId) || userId < 1) {
      res.status(400).json({ error: 'user must be a positive integer' });
      return;
    }
  }
  res.json({
    log: listPushLog(parseLogLimit(req.query.limit), userId, parseBefore(req.query.before)),
  });
});

export default router;
