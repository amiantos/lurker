// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Point the DB layer at a throwaway file before importing anything that
// touches it. db/index.js reads DATABASE_PATH at module-load time, so this
// must happen before the dynamic imports below.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let db: typeof import('./index.js').default;
let createUser: typeof import('./users.js').createUser;
let createNetwork: typeof import('./networks.js').createNetwork;
let getNetwork: typeof import('./networks.js').getNetwork;
let updateNetwork: typeof import('./networks.js').updateNetwork;
let ownsNetwork: typeof import('./networks.js').ownsNetwork;
let listNetworksForUser: typeof import('./networks.js').listNetworksForUser;
let reorderNetworks: typeof import('./networks.js').reorderNetworks;

beforeAll(async () => {
  db = (await import('./index.js')).default;
  ({ createUser } = await import('./users.js'));
  ({ createNetwork, getNetwork, updateNetwork, ownsNetwork, listNetworksForUser, reorderNetworks } =
    await import('./networks.js'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('ownsNetwork', () => {
  it('returns true for a network owned by the user', () => {
    const alice = createUser('alice');
    const net = createNetwork(alice.id, {
      name: 'libera',
      host: 'irc.libera.chat',
      port: 6697,
      tls: true,
      nick: 'alice',
    });
    expect(ownsNetwork(alice.id, net!.id)).toBe(true);
  });

  it('returns false when the network belongs to a different user', () => {
    const bob = createUser('bob');
    const carol = createUser('carol');
    const carolNet = createNetwork(carol.id, {
      name: 'libera',
      host: 'irc.libera.chat',
      port: 6697,
      tls: true,
      nick: 'carol',
    });
    expect(ownsNetwork(bob.id, carolNet!.id)).toBe(false);
    expect(ownsNetwork(carol.id, carolNet!.id)).toBe(true);
  });

  it('returns false for nonexistent networks', () => {
    const dave = createUser('dave');
    expect(ownsNetwork(dave.id, 999999)).toBe(false);
  });

  it('returns false for falsy or invalid inputs', () => {
    // The implementation guards !userId || !networkId at runtime
    expect(ownsNetwork(null as unknown as number, 1)).toBe(false);
    expect(ownsNetwork(undefined as unknown as number, 1)).toBe(false);
    expect(ownsNetwork(1, null as unknown as number)).toBe(false);
    expect(ownsNetwork(1, undefined as unknown as number)).toBe(false);
    expect(ownsNetwork(0, 0)).toBe(false);
  });
});

describe('reorderNetworks', () => {
  it('rewrites position so listNetworksForUser returns the new order', () => {
    const erin = createUser('erin');
    const a = createNetwork(erin.id, {
      name: 'a',
      host: 'a.example',
      port: 6697,
      tls: true,
      nick: 'erin',
    });
    const b = createNetwork(erin.id, {
      name: 'b',
      host: 'b.example',
      port: 6697,
      tls: true,
      nick: 'erin',
    });
    const c = createNetwork(erin.id, {
      name: 'c',
      host: 'c.example',
      port: 6697,
      tls: true,
      nick: 'erin',
    });
    // Sanity: initial order matches creation order.
    expect(listNetworksForUser(erin.id).map((n) => n.id)).toEqual([a!.id, b!.id, c!.id]);

    const result = reorderNetworks(erin.id, [c!.id, a!.id, b!.id]);
    expect(result).toEqual([c!.id, a!.id, b!.id]);
    expect(listNetworksForUser(erin.id).map((n) => n.id)).toEqual([c!.id, a!.id, b!.id]);
  });

  it('returns null when the supplied set does not match the user’s networks', () => {
    const frank = createUser('frank');
    const n1 = createNetwork(frank.id, {
      name: 'n1',
      host: 'n1.example',
      port: 6697,
      tls: true,
      nick: 'frank',
    });
    const n2 = createNetwork(frank.id, {
      name: 'n2',
      host: 'n2.example',
      port: 6697,
      tls: true,
      nick: 'frank',
    });

    expect(reorderNetworks(frank.id, [n1!.id])).toBeNull();
    expect(reorderNetworks(frank.id, [n1!.id, n2!.id, 9999])).toBeNull();
    // Order stays untouched after rejected calls.
    expect(listNetworksForUser(frank.id).map((n) => n.id)).toEqual([n1!.id, n2!.id]);
  });

  it('cannot reorder another user’s networks', () => {
    const gina = createUser('gina');
    const henri = createUser('henri');
    const gNet = createNetwork(gina.id, {
      name: 'g',
      host: 'g.example',
      port: 6697,
      tls: true,
      nick: 'gina',
    });
    const hNet = createNetwork(henri.id, {
      name: 'h',
      host: 'h.example',
      port: 6697,
      tls: true,
      nick: 'henri',
    });

    // henri can't pass gina's id even alongside his own.
    expect(reorderNetworks(henri.id, [gNet!.id, hNet!.id])).toBeNull();
    expect(listNetworksForUser(gina.id).map((n) => n.id)).toEqual([gNet!.id]);
    expect(listNetworksForUser(henri.id).map((n) => n.id)).toEqual([hNet!.id]);
  });
});

describe('network secrets without an encryption key (self-host)', () => {
  it('stores and returns secrets as plaintext (no envelope)', () => {
    // This suite sets no LURKER_SECRET_KEY, so encryption is a no-op.
    const iris = createUser('iris');
    const net = createNetwork(iris.id, {
      name: 'libera',
      host: 'irc.libera.chat',
      port: 6697,
      tls: true,
      nick: 'iris',
      server_password: 'plain-srv',
      sasl_password: 'plain-sasl',
      connect_commands: 'PRIVMSG NickServ :identify plain',
    })!;
    const raw = db.prepare('SELECT * FROM networks WHERE id = ?').get(net.id) as Record<
      string,
      string | null
    >;
    expect(raw.server_password).toBe('plain-srv');
    expect(raw.sasl_password).toBe('plain-sasl');
    expect(raw.connect_commands).toBe('PRIVMSG NickServ :identify plain');
    expect(getNetwork(net.id, iris.id)!.server_password).toBe('plain-srv');
  });

  describe('trusted_certificates', () => {
    it('defaults to enabled when omitted', () => {
      const user = createUser('trusted-default');
      const net = createNetwork(user.id, {
        name: 'libera',
        host: 'irc.libera.chat',
        port: 6697,
        tls: true,
        nick: 'default',
      });
      expect(net!.trusted_certificates).toBe(1);
    });

    it('can be disabled and updated', () => {
      const user = createUser('trusted-off');
      const net = createNetwork(user.id, {
        name: 'libera',
        host: 'irc.libera.chat',
        port: 6697,
        tls: true,
        trusted_certificates: false,
        nick: 'off',
      })!;
      expect(net.trusted_certificates).toBe(0);
      const updated = updateNetwork(net.id, user.id, { trusted_certificates: true });
      expect(updated!.trusted_certificates).toBe(1);
    });

    it('treats numeric 0 as disabled when creating', () => {
      const user = createUser('trusted-num-zero');
      const net = createNetwork(user.id, {
        name: 'libera',
        host: 'irc.libera.chat',
        port: 6697,
        tls: true,
        trusted_certificates: 0,
        nick: 'zero',
      })!;
      expect(net.trusted_certificates).toBe(0);
    });
  });
});
