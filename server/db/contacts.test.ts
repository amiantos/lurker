// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-contacts-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let createUser: typeof import('./users.js').createUser;
let createNetwork: typeof import('./networks.js').createNetwork;
let deleteNetwork: typeof import('./networks.js').deleteNetwork;
let mod: typeof import('./contacts.js');
let dbDefault: typeof import('./index.js').default;
let user: ReturnType<typeof import('./users.js').createUser>;
let other: ReturnType<typeof import('./users.js').createUser>;
let net: ReturnType<typeof import('./networks.js').createNetwork>;
let net2: ReturnType<typeof import('./networks.js').createNetwork>;

beforeAll(async () => {
  ({ createUser } = await import('./users.js'));
  ({ createNetwork, deleteNetwork } = await import('./networks.js'));
  mod = await import('./contacts.js');
  dbDefault = (await import('./index.js')).default;
  user = createUser('c-alice');
  other = createUser('c-bob');
  net = createNetwork(user.id, { name: 'libera', host: 'h', port: 6697, tls: true, nick: 'a' });
  net2 = createNetwork(user.id, { name: 'oftc', host: 'h2', port: 6697, tls: true, nick: 'a' });
});

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('schema', () => {
  it('messages has friend_contact_id + partial index', () => {
    const cols = (
      dbDefault.prepare(`PRAGMA table_info(messages)`).all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(cols).toContain('friend_contact_id');
    const idx = dbDefault
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_messages_friend'`)
      .get();
    expect(idx).toBeTruthy();
  });
});

describe('createContact / setContactTargets / getContact', () => {
  it('creates a contact with per-network targets and reads it back', () => {
    const id = mod.createContact({ userId: user.id, displayName: 'Darc', notifyOnline: true });
    mod.setContactTargets(id, [
      { networkId: net!.id, nick: 'darc' },
      { networkId: net2!.id, nick: 'darcy' },
    ]);
    const got = mod.getContact(id, user.id);
    expect(got).toMatchObject({ id, displayName: 'Darc', notifyOnline: true });
    expect(got!.targets).toHaveLength(2);
    expect(got!.targets.map((t) => t.nick).toSorted()).toEqual(['darc', 'darcy']);
  });

  it('setContactTargets replaces wholesale and skips blank nicks', () => {
    const id = mod.createContact({ userId: user.id, displayName: 'Jay', notifyOnline: false });
    mod.setContactTargets(id, [{ networkId: net!.id, nick: 'jay' }]);
    mod.setContactTargets(id, [
      { networkId: net2!.id, nick: 'jaybird' },
      { networkId: net!.id, nick: '   ' }, // blank → skipped
    ]);
    const got = mod.getContact(id, user.id);
    expect(got!.targets).toEqual([{ networkId: net2!.id, nick: 'jaybird', isPrimary: false }]);
  });

  it('persists the is_primary flag', () => {
    const id = mod.createContact({ userId: user.id, displayName: 'Prime', notifyOnline: false });
    mod.setContactTargets(id, [
      { networkId: net!.id, nick: 'p1', isPrimary: false },
      { networkId: net2!.id, nick: 'p2', isPrimary: true },
    ]);
    const got = mod.getContact(id, user.id);
    expect(got!.targets.find((t) => t.nick === 'p2')!.isPrimary).toBe(true);
    expect(got!.targets.find((t) => t.nick === 'p1')!.isPrimary).toBe(false);
  });

  it('scopes reads to the owner', () => {
    const id = mod.createContact({ userId: user.id, displayName: 'Mine', notifyOnline: false });
    expect(mod.getContact(id, other.id)).toBeNull();
  });
});

describe('listContactsForUser / listTargetsForNetwork / findContactIdByTarget', () => {
  it('lists a user’s contacts with their targets', () => {
    const list = mod.listContactsForUser(user.id);
    const darc = list.find((c) => c.displayName === 'Darc');
    expect(darc).toBeTruthy();
    expect(darc!.targets.length).toBe(2);
    // Never leaks another user's contacts.
    expect(mod.listContactsForUser(other.id)).toEqual([]);
  });

  it('lists hydration targets for a network (contactId + nick)', () => {
    const targets = mod.listTargetsForNetwork(net!.id);
    expect(targets.some((t) => t.nick === 'darc')).toBe(true);
  });

  it('finds the contact watching a (network, nick), case-insensitively', () => {
    const darc = mod.listContactsForUser(user.id).find((c) => c.displayName === 'Darc')!;
    expect(mod.findContactIdByTarget(user.id, net!.id, 'DARC')).toBe(darc.id);
    expect(mod.findContactIdByTarget(user.id, net!.id, 'nobody')).toBeNull();
  });
});

describe('updateContactMeta / deleteContact + cascade', () => {
  it('updates name + notify flag for the owner only', () => {
    const id = mod.createContact({ userId: user.id, displayName: 'Temp', notifyOnline: false });
    mod.updateContactMeta({
      contactId: id,
      userId: other.id,
      displayName: 'Hijack',
      notifyOnline: true,
    });
    expect(mod.getContact(id, user.id)!.displayName).toBe('Temp'); // wrong owner → no-op
    mod.updateContactMeta({
      contactId: id,
      userId: user.id,
      displayName: 'Renamed',
      notifyOnline: true,
    });
    expect(mod.getContact(id, user.id)).toMatchObject({
      displayName: 'Renamed',
      notifyOnline: true,
    });
  });

  it('deleteContact cascades to targets and is owner-scoped', () => {
    const id = mod.createContact({ userId: user.id, displayName: 'Doomed', notifyOnline: false });
    mod.setContactTargets(id, [{ networkId: net!.id, nick: 'doomed' }]);
    expect(mod.deleteContact(id, other.id)).toBe(false); // wrong owner
    expect(mod.deleteContact(id, user.id)).toBe(true);
    expect(mod.getContact(id, user.id)).toBeNull();
    expect(mod.findContactIdByTarget(user.id, net!.id, 'doomed')).toBeNull();
  });

  it('deleting a network cascades away its contact_targets', () => {
    const id = mod.createContact({ userId: user.id, displayName: 'NetBound', notifyOnline: false });
    const doomedNet = createNetwork(user.id, {
      name: 'doomednet',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'a',
    })!;
    mod.setContactTargets(id, [{ networkId: doomedNet.id, nick: 'x' }]);
    expect(mod.listTargetsForNetwork(doomedNet.id)).toHaveLength(1);
    deleteNetwork(doomedNet.id, user.id);
    expect(mod.listTargetsForNetwork(doomedNet.id)).toHaveLength(0);
    // The contact itself survives (it just lost that one target).
    expect(mod.getContact(id, user.id)).toBeTruthy();
  });
});
