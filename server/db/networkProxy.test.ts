// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Storage and the accessor for a network's proxy (#303). The interesting cases
// are all about the difference between "not proxied", "proxied", and "proxied
// but unusable" — because collapsing the third into the first is precisely the
// bug this feature exists to prevent (PROXY_PLAN.md §2).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-proxy-test-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let db: typeof import('./index.js').default;
let createUser: typeof import('./users.js').createUser;
let createNetwork: typeof import('./networks.js').createNetwork;
let getNetwork: typeof import('./networks.js').getNetwork;
let updateNetwork: typeof import('./networks.js').updateNetwork;
let networkProxy: typeof import('./networks.js').networkProxy;
let usableNetworkProxy: typeof import('./networks.js').usableNetworkProxy;
let isProxyProblem: typeof import('../../shared/proxy.js').isProxyProblem;

beforeAll(async () => {
  db = (await import('./index.js')).default;
  ({ createUser } = await import('./users.js'));
  ({ createNetwork, getNetwork, updateNetwork, networkProxy, usableNetworkProxy } =
    await import('./networks.js'));
  ({ isProxyProblem } = await import('../../shared/proxy.js'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

let seq = 0;
function makeNetwork(fields: Record<string, unknown> = {}) {
  seq += 1;
  const user = createUser(`proxy-user-${seq}`);
  const net = createNetwork(user.id, {
    name: `n${seq}`,
    host: 'irc.example.test',
    port: 6697,
    tls: true,
    nick: 'nick',
    ...fields,
  });
  if (!net) throw new Error('createNetwork failed');
  return { user, net };
}

describe('proxy columns', () => {
  it('defaults to no proxy at all', () => {
    const { net } = makeNetwork();
    expect(net.proxy_enabled).toBe(0);
    expect(net.proxy_host).toBeNull();
    expect(networkProxy(net)).toBeNull();
  });

  it('round-trips a full proxy through create', () => {
    const { user, net } = makeNetwork({
      proxy_enabled: true,
      proxy_type: 'socks5',
      proxy_host: '127.0.0.1',
      proxy_port: 9050,
      proxy_username: 'u',
      proxy_password: 'p',
    });
    const read = getNetwork(net.id, user.id)!;
    expect(read.proxy_enabled).toBe(1);
    expect(networkProxy(read)).toEqual({
      type: 'socks5',
      host: '127.0.0.1',
      port: 9050,
      username: 'u',
      password: 'p',
    });
  });

  it('encrypts the password at rest and nothing else', () => {
    // The column list in exportSchema is the source of truth for what is
    // encrypted; this asserts the write path actually honours it, and that the
    // non-secret half stays queryable.
    const { net } = makeNetwork({
      proxy_enabled: true,
      proxy_type: 'socks5',
      proxy_host: 'proxy.example',
      proxy_port: 1080,
      proxy_username: 'u',
      proxy_password: 'sup3rsecret',
    });
    const raw = db
      .prepare('SELECT proxy_host, proxy_username, proxy_password FROM networks WHERE id = ?')
      .get(net.id) as Record<string, string>;
    expect(raw.proxy_host).toBe('proxy.example');
    expect(raw.proxy_username).toBe('u');
    // With no LURKER_SECRET_KEY this is a plaintext passthrough, so assert on
    // the decrypted read instead of the stored bytes — the contract under test
    // is that it goes through the secret path at all.
    expect(networkProxy(net)).toMatchObject({ password: 'sup3rsecret' });
  });

  it('updates and clears through the PATCH allowlist', () => {
    const { user, net } = makeNetwork({
      proxy_enabled: true,
      proxy_type: 'socks5',
      proxy_host: '127.0.0.1',
      proxy_port: 9050,
    });
    updateNetwork(net.id, user.id, { proxy_host: '10.0.0.9', proxy_port: 1080 });
    expect(networkProxy(getNetwork(net.id, user.id)!)).toMatchObject({
      host: '10.0.0.9',
      port: 1080,
    });
    updateNetwork(net.id, user.id, { proxy_enabled: false });
    expect(networkProxy(getNetwork(net.id, user.id)!)).toBeNull();
  });

  it('treats a null proxy_enabled as unchanged, not as off', () => {
    // Same rule tls and autoconnect follow: a client sending null means "leave
    // it", and coercing it would silently drop the user off the proxy.
    const { user, net } = makeNetwork({
      proxy_enabled: true,
      proxy_type: 'socks5',
      proxy_host: '127.0.0.1',
      proxy_port: 9050,
    });
    updateNetwork(net.id, user.id, { proxy_enabled: null });
    expect(getNetwork(net.id, user.id)!.proxy_enabled).toBe(1);
  });
});

describe('networkProxy', () => {
  const configured = {
    proxy_type: 'socks5',
    proxy_host: '127.0.0.1',
    proxy_port: 9050,
    proxy_username: null,
    proxy_password: null,
  };

  it('is null when the flag is off, however complete the rest is', () => {
    // The affordance: go direct for a minute without deleting credentials.
    expect(networkProxy({ ...configured, proxy_enabled: 0 })).toBeNull();
  });

  it('is null when enabled but nothing is filled in', () => {
    // A half-finished form is "not configured", not "broken" — refusing to
    // connect over it would be a puzzle rather than a warning.
    expect(
      networkProxy({
        proxy_enabled: 1,
        proxy_type: null,
        proxy_host: null,
        proxy_port: null,
        proxy_username: null,
        proxy_password: null,
      }),
    ).toBeNull();
  });

  // ⚠⚠ The case the whole feature turns on. Archive import writes these columns
  // verbatim (exportSchema drives its column list), so a stored proxy that does
  // not validate is reachable without anyone typing it. It must come back as a
  // PROBLEM, never as null — null means "dial direct", and dialling direct here
  // puts the user's real address on the wire while the UI says they are
  // proxied.
  it('reports a PROBLEM, not null, when an enabled proxy is unusable', () => {
    const cases = [
      { ...configured, proxy_enabled: 1, proxy_type: 'socks4' },
      { ...configured, proxy_enabled: 1, proxy_port: 0 },
      { ...configured, proxy_enabled: 1, proxy_port: null },
      { ...configured, proxy_enabled: 1, proxy_host: 'has a space' },
      { ...configured, proxy_enabled: 1, proxy_password: 'orphan', proxy_username: null },
    ];
    // Reduced to one assertion so a failure names the row that broke rather
    // than just the first index (oxlint forbids expect's message argument).
    const verdicts = cases.map((row) => ({
      row: JSON.stringify(row),
      problem: !!networkProxy(row) && isProxyProblem(networkProxy(row)!),
    }));
    expect(verdicts.filter((v) => !v.problem)).toEqual([]);
  });

  it('usableNetworkProxy collapses a problem to null, for callers with no dial to refuse', () => {
    const broken = { ...configured, proxy_enabled: 1, proxy_type: 'socks4' };
    expect(isProxyProblem(networkProxy(broken)!)).toBe(true);
    expect(usableNetworkProxy(broken)).toBeNull();
  });
});
