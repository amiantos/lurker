// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import net from 'net';
import {
  createIdentdServer,
  registerIdent,
  unregisterIdent,
  isPrivateAddress,
  getIdentdMetrics,
  resetIdentdMetrics,
  identdBindHost,
} from './identd.js';

let server: net.Server;
let port: number;

beforeAll(async () => {
  // The address-mismatch tests exercise the NO-USER diagnostic path (warn/error)
  // and the grace path logs a line on every rescue; mute all three so the run
  // output stays clean.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  // A short grace window keeps the legitimate-miss cases (which now route
  // through the grace path before answering NO-USER) fast; the dedicated
  // grace-window describe below pins the timing behavior itself.
  server = createIdentdServer({ graceMs: 150, graceStepMs: 30 });
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

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Send one ident query line to `p` and collect the reply. halfClose mirrors an
// RFC 1413 querier that shutdown(SHUT_WR)s right after the query (write + FIN).
function queryOn(p: number, line: string, halfClose = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = net.connect(p, '127.0.0.1', () => (halfClose ? c.end(line) : c.write(line)));
    let out = '';
    c.on('data', (d) => (out += d.toString()));
    c.on('end', () => resolve(out));
    c.on('error', reject);
  });
}

const query = (line: string): Promise<string> => queryOn(port, line);

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

  // A syntactically-valid but out-of-range port (the regex allows 5 digits)
  // must fail fast as INVALID-PORT, not fall into the grace window — otherwise a
  // scanner could pin grace slots with 99999,99999.
  it('rejects an out-of-range port as INVALID-PORT', async () => {
    const res = await query('99999, 6667\r\n');
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

// The residual ~7% failure after the pre-TLS-registration fix: the IRC server's
// :113 callback can beat our own registerIdent through a busy event loop, so the
// query arrives before any matching 4-tuple exists. Answering NO-USER on that
// first miss is the bug; the grace window holds the socket and re-checks so a
// registration that lands a few ms late still yields USERID. (issue #374)
describe('identd grace window (registration race)', () => {
  let graceServer: net.Server;
  let gracePort: number;

  beforeAll(async () => {
    resetIdentdMetrics();
    // Short window so the race cases stay fast and deterministic.
    graceServer = createIdentdServer({ graceMs: 600, graceStepMs: 40, graceMaxPending: 4 });
    await new Promise<void>((resolve) => graceServer.listen(0, '127.0.0.1', resolve));
    gracePort = (graceServer.address() as net.AddressInfo).port;
  });

  afterAll(() => graceServer.close());

  const graceQuery = (line: string): Promise<string> => queryOn(gracePort, line);

  // The core fix: a query that arrives before the outbound connection registers
  // its 4-tuple must wait out the window, not get an instant NO-USER.
  it('rescues a query when registration lands during the grace window', async () => {
    const pending = graceQuery('42100, 6667\r\n'); // nothing registered yet
    await delay(120); // a few rechecks in, still well inside the 600ms window
    registerIdent({
      localAddress: LOOPBACK,
      localPort: 42100,
      remoteAddress: LOOPBACK,
      remotePort: 6667,
      ident: 'raced',
    });
    expect(await pending).toContain('USERID : UNIX : raced');
    expect(getIdentdMetrics().rescued).toBeGreaterThanOrEqual(1);
  });

  // A querier that half-closes its write side after the query (shutdown(SHUT_WR))
  // must STILL receive a grace-rescued USERID. With the server socket's
  // allowHalfOpen=false (the net default), the peer's FIN auto-ends our writable
  // side before the delayed reply is written, silently dropping it — which would
  // defeat the grace window for exactly the race it targets.
  it('delivers a grace-rescued USERID even when the querier half-closes after the query', async () => {
    const pending = queryOn(gracePort, '42103, 6667\r\n', true); // write + FIN
    await delay(120);
    registerIdent({
      localAddress: LOOPBACK,
      localPort: 42103,
      remoteAddress: LOOPBACK,
      remotePort: 6667,
      ident: 'halfclose',
    });
    expect(await pending).toContain('USERID : UNIX : halfclose');
  });

  it('answers NO-USER when nothing registers before the window expires', async () => {
    const before = getIdentdMetrics().silentMiss;
    expect(await graceQuery('42199, 6667\r\n')).toContain('ERROR : NO-USER');
    expect(getIdentdMetrics().silentMiss).toBe(before + 1);
  });

  // A query whose connection is RESET mid-grace (peer crashes / network breaks
  // before a verdict) must be metered as `abandoned`, not vanish — and not be
  // mistaken for `noData` (which means no query line was ever sent). NB a
  // graceful half-close (FIN) is NOT an abandonment: with allowHalfOpen the
  // server rides out the window and answers (see the half-close test above), so
  // this forces a true RST via resetAndDestroy.
  it('meters a query whose socket is reset mid-grace as `abandoned`, not noData', async () => {
    const before = getIdentdMetrics();
    const c = net.connect(gracePort, '127.0.0.1', () => c.write('42198, 6667\r\n'));
    c.on('error', () => {});
    await delay(80); // query parsed, inside the 600ms window, nothing registered
    c.resetAndDestroy(); // RST, not a graceful FIN
    // Poll (not a fixed sleep) for the server-side close to be processed.
    for (let i = 0; i < 50 && getIdentdMetrics().abandoned === before.abandoned; i++) {
      await delay(10);
    }
    const after = getIdentdMetrics();
    expect(after.abandoned).toBe(before.abandoned + 1);
    expect(after.noData).toBe(before.noData);
  });

  // A first-lookup hit must answer without entering the grace recheck loop.
  // Asserted via the metrics (served up, rescued unchanged) rather than a
  // wall-clock threshold, which flakes on a loaded CI runner.
  it('answers an exact match on the first lookup (no grace recheck)', async () => {
    registerIdent({
      localAddress: LOOPBACK,
      localPort: 42101,
      remoteAddress: LOOPBACK,
      remotePort: 6667,
      ident: 'fast',
    });
    const before = getIdentdMetrics();
    expect(await graceQuery('42101, 6667\r\n')).toContain('USERID : UNIX : fast');
    const after = getIdentdMetrics();
    expect(after.served).toBe(before.served + 1);
    expect(after.rescued).toBe(before.rescued);
  });

  // Enumeration protection must not be softened by the grace window: a ports
  // match with the wrong source address is refused on the first lookup, not held
  // open. Asserted by addrMiss up + rescued unchanged (never entered the loop).
  it('refuses an address mismatch on the first lookup (no grace for enumeration)', async () => {
    registerIdent({
      localAddress: LOOPBACK,
      localPort: 42102,
      remoteAddress: '198.51.100.9', // a different server than the loopback querier
      remotePort: 6667,
      ident: 'secret',
    });
    const before = getIdentdMetrics();
    const res = await graceQuery('42102, 6667\r\n');
    expect(res).toContain('ERROR : NO-USER');
    expect(res).not.toContain('secret');
    const after = getIdentdMetrics();
    expect(after.addrMiss).toBe(before.addrMiss + 1);
    expect(after.rescued).toBe(before.rescued);
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

describe('identdBindHost', () => {
  const prev = process.env.LURKER_IDENTD_BIND;
  afterEach(() => {
    if (prev === undefined) delete process.env.LURKER_IDENTD_BIND;
    else process.env.LURKER_IDENTD_BIND = prev;
  });

  it('is undefined when unset', () => {
    delete process.env.LURKER_IDENTD_BIND;
    expect(identdBindHost()).toBeUndefined();
  });

  it('returns the trimmed address when set', () => {
    process.env.LURKER_IDENTD_BIND = '  2001:db8::dead  ';
    expect(identdBindHost()).toBe('2001:db8::dead');
  });

  it('treats a whitespace-only value as unset', () => {
    process.env.LURKER_IDENTD_BIND = '   ';
    expect(identdBindHost()).toBeUndefined();
  });
});

async function exchange(parts: string[], target = port, host = LOOPBACK): Promise<string> {
  const client = net.connect(target, host);
  let out = '';
  const result = new Promise<string>((resolve, reject) => {
    client.on('data', (chunk) => (out += chunk.toString()));
    client.on('close', () => resolve(out));
    client.on('error', reject);
  });
  await new Promise<void>((resolve) => client.once('connect', resolve));
  for (const part of parts) {
    if (client.destroyed) break;
    client.write(part);
    if (parts.length > 1) await delay(10);
  }
  return result;
}

describe('identd PROXY v1', () => {
  const source = '198.51.100.8';
  const destination = '192.0.2.9';
  const header = `PROXY TCP4 ${source} ${destination} 12345 113\r\n`;
  const request = '43100, 6697\r\n';
  const handles: number[] = [];

  function register(localAddress = destination, remoteAddress = source): void {
    handles.push(
      registerIdent({
        localAddress,
        remoteAddress,
        localPort: 43100,
        remotePort: 6697,
        ident: 'forwarded',
      }),
    );
  }

  afterEach(() => {
    for (const handle of handles.splice(0)) unregisterIdent(handle);
  });

  it.each([
    ['one read', [header + request]],
    ['separate reads', [header, request]],
    [
      'fragmented reads',
      ['P', 'ROXY TCP4 ', `${source} `, `${destination} 12345 113\r`, '\n431', '00, 6697\r', '\n'],
    ],
  ])('uses forwarded addresses and query ports with %s', async (_name, parts) => {
    register();
    const before = getIdentdMetrics();
    expect(await exchange(parts)).toContain('USERID : UNIX : forwarded');
    expect(getIdentdMetrics().served).toBe(before.served + 1);
    expect(getIdentdMetrics().queries).toBe(before.queries + 1);
  });

  it('accepts a long IPv6 header fragmented before CRLF', async () => {
    const remote = '2001:0db8:1111:2222:3333:4444:5555:6666';
    const local = '2001:0db8:aaaa:bbbb:cccc:dddd:eeee:ffff';
    register(local, remote);
    const line = `PROXY TCP6 ${remote} ${local} 65535 65535\r\n`;
    expect(line.length).toBeGreaterThan(100);
    expect(await exchange([line.slice(0, -2), '\r', '\n' + request])).toContain(
      'USERID : UNIX : forwarded',
    );
  });

  it.each(['::1', '::ffff:127.0.0.1'])('trusts the loopback peer %s', async (host) => {
    register();
    const dual = createIdentdServer();
    await new Promise<void>((resolve) => dual.listen(0, '::', resolve));
    try {
      expect(
        await exchange([header + request], (dual.address() as net.AddressInfo).port, host),
      ).toContain('USERID : UNIX : forwarded');
    } finally {
      await new Promise<void>((resolve) => dual.close(() => resolve()));
    }
  });

  it('matches equivalent IPv6 spellings and mapped IPv4 addresses', async () => {
    register('2001:db8::2', '2001:db8::1');
    expect(
      await exchange(['PROXY TCP6 2001:0DB8:0:0:0:0:0:1 2001:0DB8::2 113 113\r\n' + request]),
    ).toContain('USERID : UNIX : forwarded');
    unregisterIdent(handles.pop()!);
    register();
    expect(
      await exchange([`PROXY TCP6 ::ffff:${source} ::ffff:${destination} 113 113\r\n` + request]),
    ).toContain('USERID : UNIX : forwarded');
  });

  it('accepts the specified zero proxy ports without using them for lookup', async () => {
    register();
    expect(await exchange([header.replace('12345 113', '0 0') + request])).toContain(
      'USERID : UNIX : forwarded',
    );
  });

  it.each([
    ['bad source', header.replace(source, '999.1.1.1')],
    ['bad destination', header.replace(destination, 'invalid')],
    ['TCP4 family mismatch', header.replace(source, '2001:db8::1')],
    ['TCP6 family mismatch', header.replace('TCP4', 'TCP6')],
    ['source port overflow', header.replace('12345', '65536')],
    ['destination port overflow', header.replace('113', '65536')],
    ['negative port', header.replace('12345', '-1')],
    ['leading zero port', header.replace('12345', '01234')],
    ['extra field', header.replace('\r\n', ' extra\r\n')],
    ['bare newline', header.replace('\r\n', '\n')],
    ['extra space', header.replace('TCP4 ', 'TCP4  ')],
    ['UNKNOWN', 'PROXY UNKNOWN\r\n'],
    ['unsupported transport', header.replace('TCP4', 'UDP4')],
    ['scoped IPv6', 'PROXY TCP6 fe80::1%eth0 fe80::2 113 113\r\n'],
    ['oversized complete header', 'PROXY ' + 'x'.repeat(102) + '\r\n'],
    ['oversized incomplete header', 'PROXY ' + 'x'.repeat(102)],
    ['second header', header + header],
  ])('rejects %s', async (_name, line) => {
    register();
    const before = getIdentdMetrics();
    expect(await exchange([line + request])).not.toContain('USERID');
    const after = getIdentdMetrics();
    expect(after.invalid).toBe(before.invalid + 1);
    expect(after.queries).toBe(before.queries);
    expect(after.noData).toBe(before.noData);
  });

  it.each(['', header])('bounds the ident line after %j', async (prefix) => {
    for (const ending of ['', '\r\n']) {
      const before = getIdentdMetrics().invalid;
      expect(await exchange([prefix + '43100, 6697' + ' '.repeat(100) + ending])).toBe('');
      expect(getIdentdMetrics().invalid).toBe(before + 1);
    }
  });

  it.each(['198.51.100.1', '10.0.0.1', '172.17.0.1', '::ffff:192.168.1.2', 'fd00::1'])(
    'refuses headers from untrusted peer %s',
    async (remoteAddress) => {
      register();
      const untrusted = createIdentdServer();
      // Override only the peer address; exercise the real socket parser and cleanup.
      untrusted.prependListener('connection', (socket) =>
        Object.defineProperty(socket, 'remoteAddress', { value: remoteAddress }),
      );
      await new Promise<void>((resolve) => untrusted.listen(0, LOOPBACK, resolve));
      try {
        const before = getIdentdMetrics().invalid;
        expect(
          await exchange([header + request], (untrusted.address() as net.AddressInfo).port),
        ).toBe('');
        expect(getIdentdMetrics().invalid).toBe(before + 1);
      } finally {
        await new Promise<void>((resolve) => untrusted.close(() => resolve()));
      }
    },
  );

  it.each(['source', 'destination'])(
    'refuses matching ports with the wrong forwarded %s',
    async (field) => {
      register();
      const wrong = header.replace(field === 'source' ? source : destination, '203.0.113.1');
      const before = getIdentdMetrics().addrMiss;
      expect(await exchange([wrong + request])).toContain('ERROR : NO-USER');
      expect(getIdentdMetrics().addrMiss).toBe(before + 1);
    },
  );

  it('times out a header without a query as noData', async () => {
    const idle = createIdentdServer();
    idle.on('connection', (socket) => socket.setTimeout(50));
    await new Promise<void>((resolve) => idle.listen(0, LOOPBACK, resolve));
    try {
      const before = getIdentdMetrics();
      expect(await exchange([header], (idle.address() as net.AddressInfo).port)).toBe('');
      for (let i = 0; i < 50 && getIdentdMetrics().noData === before.noData; i++) {
        await delay(10);
      }
      expect(getIdentdMetrics().noData).toBe(before.noData + 1);
      expect(getIdentdMetrics().invalid).toBe(before.invalid);
    } finally {
      await new Promise<void>((resolve) => idle.close(() => resolve()));
    }
  });

  it('rescues forwarded half-closed queries and releases the grace slot', async () => {
    const grace = createIdentdServer({ graceMs: 600, graceStepMs: 20, graceMaxPending: 1 });
    await new Promise<void>((resolve) => grace.listen(0, LOOPBACK, resolve));
    const target = (grace.address() as net.AddressInfo).port;
    try {
      const beforeAbandon = getIdentdMetrics();
      const abandoned = net.connect(target, LOOPBACK, () => abandoned.write(header + request));
      abandoned.on('error', () => {});
      for (let i = 0; i < 50 && getIdentdMetrics().queries === beforeAbandon.queries; i++) {
        await delay(10);
      }
      expect(getIdentdMetrics().queries).toBe(beforeAbandon.queries + 1);
      abandoned.resetAndDestroy();
      for (let i = 0; i < 50 && getIdentdMetrics().abandoned === beforeAbandon.abandoned; i++) {
        await delay(10);
      }
      expect(getIdentdMetrics().abandoned).toBe(beforeAbandon.abandoned + 1);
      expect(getIdentdMetrics().noData).toBe(beforeAbandon.noData);
      for (let i = 0; i < 2; i++) {
        const before = getIdentdMetrics();
        const pending = queryOn(target, header + request, true);
        await delay(80);
        register();
        expect(await pending).toContain('USERID : UNIX : forwarded');
        expect(getIdentdMetrics().rescued).toBe(before.rescued + 1);
        expect(getIdentdMetrics().graceSkipped).toBe(before.graceSkipped);
        unregisterIdent(handles.pop()!);
      }
    } finally {
      await new Promise<void>((resolve) => grace.close(() => resolve()));
    }
  });
});
