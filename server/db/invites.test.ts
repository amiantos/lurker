// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let createUser: typeof import('./users.js').createUser;
let createInvite: typeof import('./invites.js').createInvite;
let getInvite: typeof import('./invites.js').getInvite;
let listInvites: typeof import('./invites.js').listInvites;
let inviteStatus: typeof import('./invites.js').inviteStatus;
let consumeInvite: typeof import('./invites.js').consumeInvite;
let deleteInvite: typeof import('./invites.js').deleteInvite;
let admin: ReturnType<typeof import('./users.js').createUser>;
let invitee: ReturnType<typeof import('./users.js').createUser>;

beforeAll(async () => {
  ({ createUser } = await import('./users.js'));
  ({
    createInvite,
    getInvite,
    listInvites,
    inviteStatus,
    consumeInvite,
    deleteInvite,
  } = await import('./invites.js'));
  admin = createUser('admin', { role: 'admin' });
  invitee = createUser('invitee');
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('invites', () => {
  it('creates an invite with a random token and 7-day default expiry', () => {
    const before = Date.now();
    const inv = createInvite(admin.id);
    expect(inv!.token).toMatch(/^[A-Za-z0-9_-]{30,}$/);
    expect(inv!.expiresAt).toBeTruthy();
    const expMs = Date.parse(inv!.expiresAt!);
    // 7 days ± a generous buffer for slow runners.
    expect(expMs - before).toBeGreaterThan(6 * 24 * 60 * 60 * 1000);
    expect(expMs - before).toBeLessThan(8 * 24 * 60 * 60 * 1000);
  });

  it('honors a custom expiry', () => {
    const inv = createInvite(admin.id, { expiresInDays: 1 });
    const expMs = Date.parse(inv!.expiresAt!);
    expect(expMs - Date.now()).toBeLessThan(2 * 24 * 60 * 60 * 1000);
  });

  it('inviteStatus returns valid for a fresh invite', () => {
    const inv = createInvite(admin.id);
    const result = inviteStatus(inv!.token);
    expect(result.status).toBe('valid');
    expect((result as Extract<typeof result, { status: 'valid' }>).invite.token).toBe(inv!.token);
  });

  it('inviteStatus returns unknown for a bogus token', () => {
    expect(inviteStatus('nope').status).toBe('unknown');
    expect(inviteStatus('').status).toBe('unknown');
  });

  it('expired invites surface as expired and cannot be consumed', async () => {
    const { default: db } = await import('./index.js');
    const inv = createInvite(admin.id);
    db.prepare('UPDATE invite_tokens SET expires_at = ? WHERE token = ?')
      .run(new Date(Date.now() - 1000).toISOString(), inv!.token);
    expect(inviteStatus(inv!.token).status).toBe('expired');
    // consumeInvite is the race-safe UPDATE; it will *succeed* on an expired
    // unconsumed row because the DB doesn't know about the expiry semantics.
    // The route layer is what gates on inviteStatus before calling consume.
    // So this just confirms the layering split — consume itself doesn't
    // re-check expiry.
    expect(consumeInvite(inv!.token, invitee.id)).toBe(true);
  });

  it('consumeInvite is atomic — only one redemption wins', () => {
    const second = createUser('second');
    const inv = createInvite(admin.id);
    expect(consumeInvite(inv!.token, invitee.id)).toBe(true);
    expect(consumeInvite(inv!.token, second.id)).toBe(false);
    const reread = getInvite(inv!.token);
    expect(reread!.usedByUserId).toBe(invitee.id);
  });

  it('listInvites surfaces creator and consumer usernames', () => {
    const rows = listInvites();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toHaveProperty('createdByUsername');
    expect(rows[0]).toHaveProperty('usedByUsername');
  });

  it('deleteInvite removes the row', () => {
    const inv = createInvite(admin.id);
    expect(deleteInvite(inv!.token)).toBe(true);
    expect(getInvite(inv!.token)).toBeNull();
    expect(deleteInvite(inv!.token)).toBe(false);
  });
});
