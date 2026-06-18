// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import net from 'net';
import { createIdentdServer, registerIdent, unregisterIdent, isPrivateAddress } from './identd.js';

let server: net.Server;
let port: number;

beforeAll(async () => {
  // The address-mismatch tests deliberately exercise the NO-USER diagnostic
  // path (which logs); keep the run output clean.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  server = createIdentdServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as net.AddressInfo).port;
});

afterAll(() => {
  server.close();
  vi.restoreAllMocks();
});

// The query connects from loopback to the loopback listener, so the identd
// server sees both the local and remote address of the query as 127.0.0.1 —
// register with those so the 4-tuple matches. (In production the registered
// remote address is the IRC server, and the query legitimately arrives FROM it.)
const LOOPBACK = '127.0.0.1';

// Send one ident query line and collect the reply.
function query(line: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = net.connect(port, '127.0.0.1', () => c.write(line));
    let out = '';
    c.on('data', (d) => (out += d.toString()));
    c.on('end', () => resolve(out));
    c.on('error', reject);
  });
}

describe('built-in identd', () => {
  it('returns USERID when the full 4-tuple matches a registered connection', async () => {
    registerIdent({
      localAddress: LOOPBACK,
      localPort: 40001,
      remoteAddress: LOOPBACK,
      remotePort: 6667,
      ident: 'u42',
    });
    const res = await query('40001, 6667\r\n');
    expect(res.trim()).toBe('40001, 6667 : USERID : UNIX : u42');
  });

  it('returns NO-USER for an unregistered port', async () => {
    const res = await query('40002, 6667\r\n');
    expect(res.trim()).toBe('40002, 6667 : ERROR : NO-USER');
  });

  it('returns NO-USER after the entry is unregistered by its handle', async () => {
    const id = registerIdent({
      localAddress: LOOPBACK,
      localPort: 40003,
      remoteAddress: LOOPBACK,
      remotePort: 6667,
      ident: 'u9',
    });
    unregisterIdent(id);
    const res = await query('40003, 6667\r\n');
    expect(res).toContain('ERROR : NO-USER');
  });

  it('rejects a malformed query', async () => {
    const res = await query('not a query\r\n');
    expect(res).toContain('ERROR : INVALID-PORT');
  });

  it('tolerates loose whitespace in the query', async () => {
    registerIdent({
      localAddress: LOOPBACK,
      localPort: 40004,
      remoteAddress: LOOPBACK,
      remotePort: 6667,
      ident: 'u1',
    });
    const res = await query('  40004 , 6667 \r\n');
    expect(res).toContain('USERID : UNIX : u1');
  });

  // GHSA-g49q-jw42-6x85: matching ports alone leaks idents to anyone who can
  // reach :113. A query whose ports match but whose remote address is not the
  // server the connection goes to must get NO-USER, never the user's ident.
  it('refuses to answer when ports match but the remote address does not (no enumeration)', async () => {
    registerIdent({
      localAddress: LOOPBACK,
      localPort: 40005,
      remoteAddress: '198.51.100.7', // a different server than the loopback querier
      remotePort: 6667,
      ident: 'secret',
    });
    const res = await query('40005, 6667\r\n');
    expect(res).toContain('ERROR : NO-USER');
    expect(res).not.toContain('secret');
  });

  it('refuses when the foreign port differs — it is part of the identifying tuple', async () => {
    registerIdent({
      localAddress: LOOPBACK,
      localPort: 40006,
      remoteAddress: LOOPBACK,
      remotePort: 6697,
      ident: 'u6',
    });
    const res = await query('40006, 9999\r\n'); // right local port, wrong foreign port
    expect(res).toContain('ERROR : NO-USER');
  });

  it('matches across IPv4-mapped-IPv6 vs bare IPv4 representation', async () => {
    registerIdent({
      localAddress: '::ffff:127.0.0.1',
      localPort: 40007,
      remoteAddress: '::ffff:127.0.0.1',
      remotePort: 6667,
      ident: 'mapped',
    });
    const res = await query('40007, 6667\r\n'); // querier reports bare 127.0.0.1
    expect(res).toContain('USERID : UNIX : mapped');
  });

  // Two simultaneous connections legally sharing a local source port (to
  // different servers) must each resolve to their own ident, and closing one
  // must not delete the other — the failure mode of port-only keying.
  it('keeps colliding local ports distinct and unregisters them independently', async () => {
    const idA = registerIdent({
      localAddress: LOOPBACK,
      localPort: 40008,
      remoteAddress: LOOPBACK,
      remotePort: 6667, // "server A"
      ident: 'alice',
    });
    registerIdent({
      localAddress: LOOPBACK,
      localPort: 40008, // same local port…
      remoteAddress: LOOPBACK,
      remotePort: 7000, // …different server B
      ident: 'bob',
    });

    expect(await query('40008, 6667\r\n')).toContain('USERID : UNIX : alice');
    expect(await query('40008, 7000\r\n')).toContain('USERID : UNIX : bob');

    // Closing A must leave B answerable.
    unregisterIdent(idA);
    expect(await query('40008, 6667\r\n')).toContain('ERROR : NO-USER');
    expect(await query('40008, 7000\r\n')).toContain('USERID : UNIX : bob');
  });

  // The canonical multi-user case identd exists for: two users on the SAME
  // network from one cell. The OS forces their local source ports to differ (the
  // 4-tuple to an identical destination must be unique), so identd tells them
  // apart by port. No cross-talk.
  it('disambiguates two users on the same network by their distinct local ports', async () => {
    registerIdent({
      localAddress: LOOPBACK,
      localPort: 41001,
      remoteAddress: LOOPBACK,
      remotePort: 6667,
      ident: 'lu1',
    });
    registerIdent({
      localAddress: LOOPBACK,
      localPort: 41002,
      remoteAddress: LOOPBACK,
      remotePort: 6667, // same server as lu1
      ident: 'lu2',
    });

    expect(await query('41001, 6667\r\n')).toContain('USERID : UNIX : lu1');
    expect(await query('41002, 6667\r\n')).toContain('USERID : UNIX : lu2');
  });
});

// Drives the one-time "idents failing wholesale" diagnostic: a callback whose
// source is a private/gateway address means the container isn't seeing real
// source IPs. Getting a range boundary wrong here would either miss the Docker
// case or cry wolf on real public servers, so pin the classification.
describe('isPrivateAddress', () => {
  it('flags loopback, RFC 1918, and link-local IPv4', () => {
    expect(isPrivateAddress('127.0.0.1')).toBe(true);
    expect(isPrivateAddress('10.1.2.3')).toBe(true);
    expect(isPrivateAddress('192.168.1.1')).toBe(true);
    expect(isPrivateAddress('169.254.10.20')).toBe(true);
  });

  it('flags the whole 172.16.0.0/12 Docker-bridge range but not its edges', () => {
    expect(isPrivateAddress('172.16.0.1')).toBe(true);
    expect(isPrivateAddress('172.17.0.1')).toBe(true); // Docker's default gateway
    expect(isPrivateAddress('172.31.255.255')).toBe(true);
    expect(isPrivateAddress('172.15.0.1')).toBe(false); // just below /12
    expect(isPrivateAddress('172.32.0.1')).toBe(false); // just above /12
  });

  it('treats real public IPv4 as public', () => {
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
    expect(isPrivateAddress('198.51.100.7')).toBe(false);
    expect(isPrivateAddress('1.2.3.4')).toBe(false);
  });

  it('flags loopback, ULA, and link-local IPv6 but not global IPv6', () => {
    expect(isPrivateAddress('::1')).toBe(true);
    expect(isPrivateAddress('fc00::1')).toBe(true);
    expect(isPrivateAddress('fd12:3456::1')).toBe(true);
    expect(isPrivateAddress('fe80::1')).toBe(true);
    expect(isPrivateAddress('2001:db8::1')).toBe(false);
  });

  it('treats an empty/unknown address as not private', () => {
    expect(isPrivateAddress('')).toBe(false);
  });
});
