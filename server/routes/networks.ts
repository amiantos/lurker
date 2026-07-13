// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { Router } from 'express';
import type { Request, Response } from 'express';
import { requireAuth, blockWritesWhenPaused } from '../middleware/auth.js';
import type { Network } from '../db/networks.js';
import {
  listNetworksForUser,
  getNetwork,
  createNetwork,
  updateNetwork,
  deleteNetwork,
  reorderNetworks,
  listChannels,
  upsertChannel,
} from '../db/networks.js';
import ircManager from '../services/ircManager.js';
import { fanOutToUser } from '../services/wsHub.js';

const router = Router();
router.use(requireAuth);
// Paused accounts are read-only: every connect/reconnect/join/part and all
// network-config mutation here is blocked, while GET listing still works so the
// sidebar renders. See blockWritesWhenPaused.
router.use(blockWritesWhenPaused);

// `default_channel` is a comma-separated channel list, matching IRC's own JOIN
// syntax ("JOIN #a,#b") — the onboarding flow and `/network add -channel` both
// send several at once. Whitespace is accepted as a separator too, since that's
// what a user typing into a free-text field tends to reach for. Names are folded
// case-insensitively when de-duplicating (servers are inconsistent about the
// casing they echo back), but the first spelling seen is what gets stored.
function parseChannelList(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of raw.split(/[,\s]+/)) {
    const channel = name.trim();
    if (!channel) continue;
    const key = channel.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(channel);
  }
  return out;
}

function networkPayload(network: Network | undefined | null): Record<string, unknown> | null {
  if (!network) return null;
  const { server_password, sasl_password, ...safe } = network;
  return {
    ...safe,
    tls: !!network.tls,
    trusted_certificates: !!network.trusted_certificates,
    autoconnect: !!network.autoconnect,
    has_password: !!server_password,
    has_sasl_password: !!sasl_password,
    channels: listChannels(network.id),
  };
}

router.get('/', (req: Request, res: Response) => {
  const networks = listNetworksForUser(req.user!.id).map(networkPayload);
  res.json({ networks });
});

router.post('/', (req: Request, res: Response) => {
  const {
    name,
    host,
    port,
    tls,
    trusted_certificates,
    nick,
    username,
    realname,
    server_password,
    autoconnect,
    sasl_account,
    sasl_password,
    default_channel,
    connect_commands,
  } = req.body || {};
  if (!name || !host || !nick) {
    res.status(400).json({ error: 'name, host, and nick are required' });
    return;
  }

  const network = createNetwork(req.user!.id, {
    name,
    host,
    port,
    tls,
    trusted_certificates,
    nick,
    username,
    realname,
    server_password,
    autoconnect,
    sasl_account,
    sasl_password,
    connect_commands,
  });
  if (!network) {
    res.status(500).json({ error: 'failed to create network' });
    return;
  }
  for (const channel of parseChannelList(default_channel)) {
    upsertChannel(network.id, channel, true);
  }
  // Creating a network is an explicit "Save & connect" action, so connect now
  // regardless of `autoconnect`. The `autoconnect` flag governs only whether a
  // network is connected automatically at cold-start (connectScheduler /
  // ircManager.initAll) and on un-pause resume — not whether this initial,
  // user-initiated setup connects.
  ircManager.startNetwork(req.user!.id, network.id);
  res.status(201).json({ network: networkPayload(network) });
});

// Rewrite sidebar order for the caller. Body: { ids: [n1, n2, ...] } in the
// new order. Must match the user's current set exactly — partial reorders
// rejected with 409 so the caller refetches and tries again.
router.post('/reorder', (req: Request, res: Response) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : null;
  if (!ids) {
    res.status(400).json({ error: 'ids array required' });
    return;
  }
  const next = reorderNetworks(req.user!.id, ids);
  if (next === null) {
    const networks = listNetworksForUser(req.user!.id).map(networkPayload);
    res.status(409).json({ error: 'network set mismatch', networks });
    return;
  }
  const networks = listNetworksForUser(req.user!.id).map(networkPayload);
  res.json({ networks });
});

router.patch('/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const existing = getNetwork(id, req.user!.id);
  if (!existing) {
    res.status(404).json({ error: 'network not found' });
    return;
  }
  const updated = updateNetwork(id, req.user!.id, req.body || {});
  res.json({ network: networkPayload(updated) });
});

router.delete('/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const existing = getNetwork(id, req.user!.id);
  if (!existing) {
    res.status(404).json({ error: 'network not found' });
    return;
  }
  ircManager.disposeNetwork(req.user!.id, id, 'network removed');
  deleteNetwork(id, req.user!.id);
  // Deleting the network cascades away its contact_targets, so re-publish the
  // contact list to every open tab — otherwise the Friends UI keeps stale
  // targets (and a possibly-dead primary DM) pointing at the gone network until
  // the next reconnect re-snapshots.
  fanOutToUser(req.user!.id, {
    kind: 'contacts-snapshot',
    contacts: ircManager.listContacts(req.user!.id),
  });
  res.json({ ok: true });
});

router.post('/:id/connect', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const network = getNetwork(id, req.user!.id);
  if (!network) {
    res.status(404).json({ error: 'network not found' });
    return;
  }
  ircManager.startNetwork(req.user!.id, id);
  res.json({ ok: true });
});

router.post('/:id/disconnect', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const network = getNetwork(id, req.user!.id);
  if (!network) {
    res.status(404).json({ error: 'network not found' });
    return;
  }
  ircManager.stopNetwork(req.user!.id, id, req.body?.reason);
  res.json({ ok: true });
});

router.post('/:id/reconnect', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const network = getNetwork(id, req.user!.id);
  if (!network) {
    res.status(404).json({ error: 'network not found' });
    return;
  }
  ircManager.restartNetwork(req.user!.id, id);
  res.json({ ok: true });
});

router.post('/:id/join', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { channel, key } = req.body || {};
  if (!channel) {
    res.status(400).json({ error: 'channel required' });
    return;
  }
  if (!ircManager.joinChannel(req.user!.id, id, channel, key)) {
    res.status(409).json({ error: 'network not connected' });
    return;
  }
  res.json({ ok: true });
});

router.post('/:id/part', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { channel, reason } = req.body || {};
  if (!channel) {
    res.status(400).json({ error: 'channel required' });
    return;
  }
  if (!ircManager.partChannel(req.user!.id, id, channel, reason)) {
    res.status(409).json({ error: 'network not connected' });
    return;
  }
  res.json({ ok: true });
});

export default router;
