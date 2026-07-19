// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { Router } from 'express';
import type { Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import type { Network } from '../db/networks.js';
import {
  listNetworksForUser,
  getNetwork,
  createNetwork,
  updateNetwork,
  deleteNetwork,
  reorderNetworks,
} from '../db/networks.js';
import { listForNetwork as listBuffersForNetwork, seedAutojoinChannel } from '../db/buffers.js';
import ircManager from '../services/ircManager.js';
import { isNetworkHostAllowed, hostAllowedChecker } from '../services/networkPolicy.js';
import { fanOutToUser } from '../services/wsHub.js';

const router = Router();
router.use(requireAuth);
// Paused accounts are read-only (every connect/reconnect/join/part and all
// network-config mutation here is blocked while GET listing still renders the
// sidebar). The write block lives centrally in requireAuth — see #573.

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

// `isAllowed` is injectable so a caller mapping over several networks can resolve
// the (instance-global) policy once instead of re-reading it per row.
function networkPayload(
  network: Network | undefined | null,
  isAllowed: (host: string) => boolean = isNetworkHostAllowed,
): Record<string, unknown> | null {
  if (!network) return null;
  const { server_password, sasl_password, ...safe } = network;
  return {
    ...safe,
    tls: !!network.tls,
    trusted_certificates: !!network.trusted_certificates,
    autoconnect: !!network.autoconnect,
    has_password: !!server_password,
    has_sasl_password: !!sasl_password,
    // Channel rows in the retired channels-table wire shape (`joined` is the
    // autojoin flag), sourced from the buffers registry.
    channels: listBuffersForNetwork(network.id)
      .filter((b) => b.kind === 'channel')
      .map((b) => ({
        id: b.id,
        network_id: network.id,
        name: b.target,
        joined: b.autojoin ? 1 : 0,
        created_at: b.createdAt,
        key: b.key,
      })),
    // True when the admin has locked the instance down and this network's host
    // isn't on the list (#298). The row survives untouched — it just can't
    // connect — so the client needs this to say why, rather than leaving the user
    // to click Connect and watch nothing happen.
    blocked: !isAllowed(network.host),
  };
}

router.get('/', (req: Request, res: Response) => {
  const isAllowed = hostAllowedChecker();
  const networks = listNetworksForUser(req.user!.id).map((n) => networkPayload(n, isAllowed));
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
  if (!isNetworkHostAllowed(host)) {
    res.status(403).json({ error: 'this server only allows the networks its admin has listed' });
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
    seedAutojoinChannel(req.user!.id, network.id, channel);
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
  const isAllowed = hostAllowedChecker();
  const next = reorderNetworks(req.user!.id, ids);
  if (next === null) {
    const networks = listNetworksForUser(req.user!.id).map((n) => networkPayload(n, isAllowed));
    res.status(409).json({ error: 'network set mismatch', networks });
    return;
  }
  const networks = listNetworksForUser(req.user!.id).map((n) => networkPayload(n, isAllowed));
  res.json({ networks });
});

router.patch('/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const existing = getNetwork(id, req.user!.id);
  if (!existing) {
    res.status(404).json({ error: 'network not found' });
    return;
  }
  // Editing the host has to clear the same bar as creating one, or the lockdown
  // is a formality: create an approved network, then point it anywhere. Only a
  // *changed* host is checked — an existing off-list network stays editable
  // (rename it, fix its nick) even while it's blocked from connecting, since the
  // policy blocks connections, not custody of the row.
  const nextHost = (req.body || {}).host;
  if (
    typeof nextHost === 'string' &&
    nextHost.toLowerCase() !== existing.host.toLowerCase() &&
    !isNetworkHostAllowed(nextHost)
  ) {
    res.status(403).json({ error: 'this server only allows the networks its admin has listed' });
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
  // startNetwork enforces the lockdown itself (that's the real gate — it also
  // covers boot autoconnect), but it enforces it by returning null. Say so out
  // loud here, or the user clicks Connect and watches nothing whatsoever happen.
  if (!isNetworkHostAllowed(network.host)) {
    res.status(403).json({ error: 'this server only allows the networks its admin has listed' });
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
  // Same as /connect: restartNetwork routes through startNetwork, which refuses
  // silently. Report it instead of a no-op "ok".
  if (!isNetworkHostAllowed(network.host)) {
    res.status(403).json({ error: 'this server only allows the networks its admin has listed' });
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
