// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import express, { Router } from 'express';
import type { Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { getNetwork } from '../db/networks.js';
import type { Network } from '../db/networks.js';
import ircManager from '../services/ircManager.js';
import type { IrcConnection } from '../services/ircConnection.js';
import { fanOutToUser } from '../services/wsHub.js';
import {
  isChannelTarget,
  mintVoiceToken,
  roomFor,
  voiceEnabled,
  meetsJoinMode,
  canModerateCall,
  canAdminCall,
  guestIdentity,
  removeFromCall,
  muteParticipant,
  rememberRoom,
  receiveWebhook,
  applyWebhookEvent,
  foldKey,
  type CallPresenceChange,
} from '../services/voice.js';
import { getPolicy, setPolicy, normalizeMinJoinMode } from '../db/voicePolicy.js';
import {
  createGuestLink,
  listActiveGuestLinks,
  revokeGuestLink,
  getGuestLink,
  getUsableGuestLink,
  bumpGuestLinkUse,
} from '../db/voiceLinks.js';

// Voice write/control surface. Lurker is the token authority + call moderator;
// it never carries media. Two routers:
//   - the authed router (requireAuth): mint token, moderate, policy, guest-link
//   - the public router (no cookie): LiveKit webhook + guest join token, each
//     verified by its own capability (webhook signature / guest-link token)

/** A caller's IRC prefix modes in a channel (e.g. ['o','v']), or [] if absent. */
function memberModes(conn: IrcConnection, channel: string, nick: string): string[] {
  return conn.channels.get(channel.toLowerCase())?.members.get(nick.toLowerCase())?.modes ?? [];
}

interface CallCtx {
  network: Network;
  conn: IrcConnection;
  nick: string;
}

/** Resolve + gate the common preconditions (voice on, network owned, live
 *  connection). Sends the error response and returns null on any failure. */
function resolveCall(req: Request, res: Response, networkId: number): CallCtx | null {
  if (!voiceEnabled()) {
    res.status(503).json({ error: 'voice not enabled on this server' });
    return null;
  }
  if (!Number.isInteger(networkId) || networkId <= 0) {
    res.status(400).json({ error: 'networkId required' });
    return null;
  }
  const network = getNetwork(networkId, req.user!.id);
  if (!network) {
    res.status(404).json({ error: 'network not found' });
    return null;
  }
  const conn = ircManager.getConnection(req.user!.id, networkId);
  if (!conn || !conn.currentNick) {
    res.status(409).json({ error: 'network not connected' });
    return null;
  }
  return { network, conn, nick: conn.currentNick };
}

const router = Router();
router.use(requireAuth);

// ─── Join: mint a room-scoped token, gated by membership + channel policy ───
router.post('/token', async (req: Request, res: Response) => {
  const networkId = Number(req.body?.networkId);
  const target = typeof req.body?.target === 'string' ? req.body.target.trim() : '';
  if (!target) {
    res.status(400).json({ error: 'target required' });
    return;
  }
  const ctx = resolveCall(req, res, networkId);
  if (!ctx) return;
  const { network, conn, nick } = ctx;

  if (isChannelTarget(target)) {
    if (!conn.channels.has(target.toLowerCase())) {
      res.status(403).json({ error: 'not a member of that channel' });
      return;
    }
    // Per-channel join gating: caller must meet the channel's min join mode.
    const min = getPolicy(foldKey(network.host), foldKey(target));
    if (!meetsJoinMode(memberModes(conn, target, nick), min)) {
      res
        .status(403)
        .json({ error: `this call is restricted to ${min}+ — you don't have that mode` });
      return;
    }
  }

  const room = roomFor(network.host, target, nick);
  rememberRoom(room, network.host, isChannelTarget(target) ? target : room);
  try {
    const minted = await mintVoiceToken({ identity: nick, room });
    res.json(minted); // { token, room, url }
  } catch {
    res.status(500).json({ error: 'failed to mint token' });
  }
});

// ─── Moderate: op-only mute / remove another participant ───────────────────
router.post('/moderate', async (req: Request, res: Response) => {
  const networkId = Number(req.body?.networkId);
  const target = typeof req.body?.target === 'string' ? req.body.target.trim() : '';
  const action = req.body?.action;
  const identity = typeof req.body?.identity === 'string' ? req.body.identity : '';
  if (!target || !identity || (action !== 'mute' && action !== 'remove')) {
    res.status(400).json({ error: 'target, identity, action (mute|remove) required' });
    return;
  }
  const ctx = resolveCall(req, res, networkId);
  if (!ctx) return;
  const { network, conn, nick } = ctx;
  if (!isChannelTarget(target) || !canModerateCall(memberModes(conn, target, nick))) {
    res.status(403).json({ error: 'you must be a channel operator to moderate this call' });
    return;
  }
  const room = roomFor(network.host, target, nick);
  try {
    if (action === 'remove') await removeFromCall(room, identity);
    else await muteParticipant(room, identity);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'moderation action failed' });
  }
});

// ─── Join policy: read (any member) / set (ops only) ───────────────────────
router.get('/policy', (req: Request, res: Response) => {
  const networkId = Number(req.query?.networkId);
  const target = typeof req.query?.target === 'string' ? req.query.target.trim() : '';
  if (!target) {
    res.status(400).json({ error: 'target required' });
    return;
  }
  const ctx = resolveCall(req, res, networkId);
  if (!ctx) return;
  res.json({ minJoinMode: getPolicy(foldKey(ctx.network.host), foldKey(target)) });
});

router.put('/policy', (req: Request, res: Response) => {
  const networkId = Number(req.body?.networkId);
  const target = typeof req.body?.target === 'string' ? req.body.target.trim() : '';
  const minJoinMode = normalizeMinJoinMode(req.body?.minJoinMode);
  if (!target || !isChannelTarget(target)) {
    res.status(400).json({ error: 'channel target required' });
    return;
  }
  const ctx = resolveCall(req, res, networkId);
  if (!ctx) return;
  const { network, conn, nick } = ctx;
  if (!canAdminCall(memberModes(conn, target, nick))) {
    res.status(403).json({ error: 'you must be a channel operator to set the call policy' });
    return;
  }
  setPolicy(foldKey(network.host), foldKey(target), minJoinMode, nick);
  res.json({ minJoinMode });
});

// ─── Guest links: op mints / lists / revokes a public capability URL ───────
router.post('/guest-link', (req: Request, res: Response) => {
  const networkId = Number(req.body?.networkId);
  const target = typeof req.body?.target === 'string' ? req.body.target.trim() : '';
  const canPublish = req.body?.canPublish !== false; // default talk
  if (!target || !isChannelTarget(target)) {
    res.status(400).json({ error: 'channel target required' });
    return;
  }
  const ctx = resolveCall(req, res, networkId);
  if (!ctx) return;
  const { network, conn, nick } = ctx;
  if (!canAdminCall(memberModes(conn, target, nick))) {
    res.status(403).json({ error: 'you must be a channel operator to create a guest link' });
    return;
  }
  const room = roomFor(network.host, target, nick);
  rememberRoom(room, network.host, target);
  const link = createGuestLink({
    networkHost: foldKey(network.host),
    channelFolded: foldKey(target),
    room,
    canPublish,
    createdBy: nick,
  });
  res.json({
    url: `https://${req.get('host')}/call/${link.token}`,
    token: link.token,
    canPublish: link.canPublish,
    expiresAt: link.expiresAt,
  });
});

router.get('/guest-link', (req: Request, res: Response) => {
  const networkId = Number(req.query?.networkId);
  const target = typeof req.query?.target === 'string' ? req.query.target.trim() : '';
  if (!target || !isChannelTarget(target)) {
    res.status(400).json({ error: 'channel target required' });
    return;
  }
  const ctx = resolveCall(req, res, networkId);
  if (!ctx) return;
  const { network, conn, nick } = ctx;
  if (!canAdminCall(memberModes(conn, target, nick))) {
    res.status(403).json({ error: 'operators only' });
    return;
  }
  const host = req.get('host');
  const links = listActiveGuestLinks(foldKey(network.host), foldKey(target)).map((l) => ({
    token: l.token,
    url: `https://${host}/call/${l.token}`,
    canPublish: l.canPublish,
    createdBy: l.createdBy,
    createdAt: l.createdAt,
    expiresAt: l.expiresAt,
    useCount: l.useCount,
  }));
  res.json({ links });
});

router.delete('/guest-link/:token', (req: Request, res: Response) => {
  if (!voiceEnabled()) {
    res.status(503).json({ error: 'voice not enabled on this server' });
    return;
  }
  const token = typeof req.params.token === 'string' ? req.params.token : '';
  const link = getGuestLink(token);
  if (!link) {
    res.status(404).json({ error: 'link not found' });
    return;
  }
  // Authorize: caller must be an op of the link's channel on the matching host.
  const conn = ircManager
    .listConnections(req.user!.id)
    .find((c) => !!c.currentNick && foldKey(c.network.host) === link.networkHost);
  if (!conn || !canAdminCall(memberModes(conn, link.channelFolded, conn.currentNick!))) {
    res.status(403).json({ error: 'operators only' });
    return;
  }
  revokeGuestLink(token);
  res.json({ ok: true });
});

// ─── Public router (no cookie auth) — webhook + guest join token ────────────
export const voicePublicRouter = Router();

// LiveKit posts room/participant events here (content-type application/webhook+json,
// so the global express.json parser skips it). Verified by signature, then fed to
// the presence registry; fan out the change to other local users in the channel.
voicePublicRouter.post(
  '/webhook',
  express.text({ type: '*/*', limit: '512kb' }),
  async (req: Request, res: Response) => {
    const body = typeof req.body === 'string' ? req.body : '';
    const ev = await receiveWebhook(body, req.get('Authorization'));
    if (!ev) {
      res.status(401).end();
      return;
    }
    const change = applyWebhookEvent(ev);
    if (change) broadcastCallPresence(change);
    res.status(200).end();
  },
);

// Guest join: exchange a guest-link token + display name for a room-scoped
// LiveKit token. Public + rate-limited; the capability is the opaque link token.
const guestHits = new Map<string, number[]>(); // ip → recent request timestamps
function guestRateLimited(ip: string): boolean {
  const now = Date.now();
  const win = (guestHits.get(ip) ?? []).filter((t) => now - t < 60_000);
  win.push(now);
  guestHits.set(ip, win);
  return win.length > 10; // >10 guest-token requests/min per IP
}

voicePublicRouter.post('/guest-token', async (req: Request, res: Response) => {
  if (!voiceEnabled()) {
    res.status(503).json({ error: 'voice not enabled' });
    return;
  }
  if (guestRateLimited(req.ip ?? 'unknown')) {
    res.status(429).json({ error: 'too many requests' });
    return;
  }
  const token = typeof req.body?.token === 'string' ? req.body.token : '';
  const name = typeof req.body?.name === 'string' ? req.body.name : '';
  const link = getUsableGuestLink(token);
  if (!link) {
    res.status(404).json({ error: 'this guest link is invalid, expired, or revoked' });
    return;
  }
  rememberRoom(link.room, link.networkHost, link.channelFolded);
  try {
    const minted = await mintVoiceToken({
      identity: guestIdentity(name || 'guest'),
      room: link.room,
      canPublish: link.canPublish,
      ttlSeconds: 4 * 60 * 60,
    });
    bumpGuestLinkUse(token);
    res.json({ token: minted.token, url: minted.url, canPublish: link.canPublish });
  } catch {
    res.status(500).json({ error: 'failed to mint token' });
  }
});

/** Notify every other local account currently in this channel (any of their
 *  tabs) that a call's participant count changed, so they can show/hide a badge. */
function broadcastCallPresence(change: CallPresenceChange): void {
  for (const conn of ircManager.listAllConnections()) {
    if (foldKey(conn.network.host) !== change.host) continue;
    if (!conn.channels.has(change.channel)) continue;
    fanOutToUser(conn.network.user_id, {
      type: 'call-presence',
      networkId: conn.network.id,
      target: change.channel,
      active: change.active,
      count: change.count,
    });
  }
}

export default router;
