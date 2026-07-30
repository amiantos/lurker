// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-voicelinks-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let vl: typeof import('./voiceLinks.js');

const base = {
  networkHost: 'irc.libera.chat',
  channelFolded: '#dev',
  room: 'net-irc.libera.chat-c-#dev',
  canPublish: true,
  createdBy: 'jawsh',
};

beforeAll(async () => {
  vl = await import('./voiceLinks.js');
});

describe('voiceLinks', () => {
  it('creates a usable link with an opaque token and ~24h expiry', () => {
    const link = vl.createGuestLink(base);
    expect(link.token.length).toBeGreaterThan(30);
    expect(link.canPublish).toBe(true);
    expect(link.room).toBe(base.room);
    expect(vl.getUsableGuestLink(link.token)?.token).toBe(link.token);
    const ttl = Date.parse(link.expiresAt) - Date.now();
    expect(ttl).toBeGreaterThan(vl.GUEST_LINK_TTL_MS - 60_000);
    expect(ttl).toBeLessThanOrEqual(vl.GUEST_LINK_TTL_MS + 1_000);
  });

  it('carries a listen-only (canPublish:false) flag', () => {
    const link = vl.createGuestLink({ ...base, canPublish: false });
    expect(vl.getGuestLink(link.token)?.canPublish).toBe(false);
  });

  it('revoking makes it unusable but still fetchable', () => {
    const link = vl.createGuestLink(base);
    expect(vl.revokeGuestLink(link.token)).toBe(true);
    expect(vl.getUsableGuestLink(link.token)).toBeNull();
    expect(vl.getGuestLink(link.token)?.revokedAt).toBeTruthy();
  });

  it('lists only active links for a host+channel', () => {
    const a = vl.createGuestLink({ ...base, channelFolded: '#list' });
    const b = vl.createGuestLink({ ...base, channelFolded: '#list' });
    vl.revokeGuestLink(b.token);
    const active = vl.listActiveGuestLinks('irc.libera.chat', '#list').map((l) => l.token);
    expect(active).toContain(a.token);
    expect(active).not.toContain(b.token);
  });

  it('bumps the use count', () => {
    const link = vl.createGuestLink(base);
    vl.bumpGuestLinkUse(link.token);
    vl.bumpGuestLinkUse(link.token);
    expect(vl.getGuestLink(link.token)?.useCount).toBe(2);
  });

  it('returns null for an unknown token', () => {
    expect(vl.getUsableGuestLink('does-not-exist')).toBeNull();
    expect(vl.getGuestLink('does-not-exist')).toBeNull();
  });
});
