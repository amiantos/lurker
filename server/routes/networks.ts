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
  setNetworkClientCert,
} from '../db/networks.js';
import {
  generateClientCert,
  describeClientCert,
  validateClientCertPair,
  isClientCertProblem,
  clientCertBundle,
} from '../utils/clientCert.js';
import { listChannelsForNetwork, seedAutojoinChannel } from '../db/buffers.js';
import ircManager from '../services/ircManager.js';
import { isNetworkHostAllowed, hostAllowedChecker } from '../services/networkPolicy.js';
import { fanOutToUser, favoritesChangedFrame } from '../services/wsHub.js';
import { renumberFavorites } from '../db/favoriteBuffers.js';

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

function safeDescribe(certPem: string): ReturnType<typeof describeClientCert> | null {
  try {
    return describeClientCert(certPem);
  } catch {
    return null;
  }
}

// `isAllowed` is injectable so a caller mapping over several networks can resolve
// the (instance-global) policy once instead of re-reading it per row.
function networkPayload(
  network: Network | undefined | null,
  isAllowed: (host: string) => boolean = isNetworkHostAllowed,
): Record<string, unknown> | null {
  if (!network) return null;
  // client_key is destructured only to keep it OUT of `safe` — the private key
  // leaves the server through exactly one route, and never in a listing.
  const { server_password, sasl_password, client_cert, client_key: _key, ...safe } = network;
  return {
    ...safe,
    tls: !!network.tls,
    trusted_certificates: !!network.trusted_certificates,
    autoconnect: !!network.autoconnect,
    has_password: !!server_password,
    has_sasl_password: !!sasl_password,
    // CertFP (#459). Neither PEM is in the payload: the key is a secret, and the
    // certificate on its own is of no use to the UI, which needs the digests to
    // paste at NickServ. `null` when no cert is attached — and also when a
    // stored cert can't be parsed, which is unreachable through the routes below
    // (they validate before writing) but must not take out the whole listing.
    client_cert: client_cert ? safeDescribe(client_cert) : null,
    // Channel rows in the retired channels-table wire shape (`joined` is the
    // autojoin flag), sourced from the buffers registry.
    channels: listChannelsForNetwork(network.id).map((b) => ({
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
  // The network's buffers cascaded away and took their favorite rows with
  // them, leaving holes mid-sequence in the user's global favorites order.
  // Re-densify and re-publish so open tabs drop the dead entries instead of
  // keeping them until the next reconnect re-seeds.
  renumberFavorites(req.user!.id);
  fanOutToUser(req.user!.id, favoritesChangedFrame(req.user!.id));
  res.json({ ok: true });
});

// CertFP (#459). The cert is a validated PEM pair, so it moves through these
// dedicated routes rather than the PATCH allowlist — nothing that hasn't been
// parsed and pair-checked can reach the dialer (or, in engine mode, the engine's
// tls.connect, where a malformed key throws synchronously).
//
// A change takes effect on the next connect: the certificate is presented during
// the TLS handshake, so there is nothing to renegotiate on a live socket. The
// client says so; reconnecting is the user's call, the same as for every other
// network edit.
// Not an async handler: Express 5 turns a rejection out of one into an
// unhandled rejection rather than a response, so the async body answers its own
// failures and the promise handed back here never rejects.
router.post('/:id/certificate', (req: Request, res: Response) => {
  void attachCertificate(req, res);
});

async function attachCertificate(req: Request, res: Response): Promise<void> {
  try {
    await attachCertificateInner(req, res);
  } catch (err) {
    console.error('[lurker] client certificate write failed:', err);
    res.status(500).json({ error: 'failed to store the client certificate' });
  }
}

async function attachCertificateInner(req: Request, res: Response): Promise<void> {
  const id = Number(req.params.id);
  const network = getNetwork(id, req.user!.id);
  if (!network) {
    res.status(404).json({ error: 'network not found' });
    return;
  }
  const mode = (req.body || {}).mode;
  let pair;
  if (mode === 'generate') {
    pair = await generateClientCert(network.nick || network.name);
  } else if (mode === 'import') {
    const result = validateClientCertPair((req.body || {}).cert, (req.body || {}).key);
    if (isClientCertProblem(result)) {
      res.status(400).json({ error: result.error });
      return;
    }
    pair = result;
  } else {
    res.status(400).json({ error: "mode must be 'generate' or 'import'" });
    return;
  }
  const updated = setNetworkClientCert(id, req.user!.id, pair);
  res.json({ network: networkPayload(updated), certificate: describeClientCert(pair.cert) });
}

router.delete('/:id/certificate', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!getNetwork(id, req.user!.id)) {
    res.status(404).json({ error: 'network not found' });
    return;
  }
  const updated = setNetworkClientCert(id, req.user!.id, null);
  res.json({ network: networkPayload(updated) });
});

// The pair in the single-file form other clients keep on disk (HexChat's
// client.pem, WeeChat's ssl.crt). Its own route, never part of a listing: a
// certificate you can't take with you is lock-in, but a private key must be
// asked for explicitly rather than shipped with every sidebar refresh.
router.get('/:id/certificate/export', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const network = getNetwork(id, req.user!.id);
  if (!network) {
    res.status(404).json({ error: 'network not found' });
    return;
  }
  if (!network.client_cert || !network.client_key) {
    res.status(404).json({ error: 'this network has no client certificate' });
    return;
  }
  res.type('application/x-pem-file');
  res.setHeader('Content-Disposition', `attachment; filename="lurker-${id}-client.pem"`);
  res.send(clientCertBundle({ cert: network.client_cert, key: network.client_key }));
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
