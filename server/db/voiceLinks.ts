// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import crypto from 'crypto';
import db from './index.js';

// Public guest call links — capability tokens that let an account-less guest
// join exactly one LiveKit room. The token is opaque and unguessable, the link
// expires after GUEST_LINK_TTL_MS, and it is soft-revocable via revoked_at. Not
// tied to a user row: it outlives the op who minted it (revoke to kill access).

export interface GuestLink {
  token: string;
  networkHost: string;
  channelFolded: string;
  room: string;
  canPublish: boolean;
  createdBy: string | null;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  useCount: number;
}

interface RawGuestLink {
  token: string;
  networkHost: string;
  channelFolded: string;
  room: string;
  canPublish: number;
  createdBy: string | null;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  useCount: number;
}

export const GUEST_LINK_TTL_MS = 24 * 60 * 60 * 1000;

const COLS = `
  token, network_host AS networkHost, channel_folded AS channelFolded, room,
  can_publish AS canPublish, created_by AS createdBy, created_at AS createdAt,
  expires_at AS expiresAt, revoked_at AS revokedAt, use_count AS useCount
`;

const insertStmt = db.prepare(`
  INSERT INTO voice_guest_link
    (token, network_host, channel_folded, room, can_publish, created_by, expires_at)
  VALUES (@token, @host, @channel, @room, @canPublish, @by, @expiresAt)
`);
const getStmt = db.prepare(`SELECT ${COLS} FROM voice_guest_link WHERE token = ?`);
const listActiveStmt = db.prepare(`
  SELECT ${COLS} FROM voice_guest_link
  WHERE network_host = ? AND channel_folded = ?
    AND revoked_at IS NULL AND expires_at > datetime('now')
  ORDER BY created_at DESC
`);
const revokeStmt = db.prepare(`
  UPDATE voice_guest_link SET revoked_at = datetime('now')
  WHERE token = ? AND revoked_at IS NULL
`);
const bumpStmt = db.prepare(
  `UPDATE voice_guest_link SET use_count = use_count + 1 WHERE token = ?`,
);

function toGuestLink(row: RawGuestLink): GuestLink {
  return { ...row, canPublish: !!row.canPublish };
}

export function createGuestLink(args: {
  networkHost: string;
  channelFolded: string;
  room: string;
  canPublish: boolean;
  createdBy: string;
}): GuestLink {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + GUEST_LINK_TTL_MS).toISOString();
  insertStmt.run({
    token,
    host: args.networkHost,
    channel: args.channelFolded,
    room: args.room,
    canPublish: args.canPublish ? 1 : 0,
    by: args.createdBy,
    expiresAt,
  });
  return getGuestLink(token) as GuestLink;
}

export function getGuestLink(token: string): GuestLink | null {
  const row = getStmt.get(token) as RawGuestLink | undefined;
  return row ? toGuestLink(row) : null;
}

/** The link only if it exists, is not revoked, and has not expired; else null.
 *  This is the gate the public guest-token endpoint uses. */
export function getUsableGuestLink(token: string): GuestLink | null {
  const link = getGuestLink(token);
  if (!link || link.revokedAt || Date.parse(link.expiresAt) <= Date.now()) return null;
  return link;
}

export function listActiveGuestLinks(host: string, channelFolded: string): GuestLink[] {
  return (listActiveStmt.all(host, channelFolded) as RawGuestLink[]).map(toGuestLink);
}

export function revokeGuestLink(token: string): boolean {
  return revokeStmt.run(token).changes > 0;
}

export function bumpGuestLinkUse(token: string): void {
  bumpStmt.run(token);
}
