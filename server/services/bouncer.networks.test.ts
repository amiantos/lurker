// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Socket-driven tests for the soju.im/bouncer-networks control surface:
// control (unbound) mode, BOUNCER LISTNETWORKS / BIND, BOUNCER_NETID, and the
// -notify state-change pushes. See test-utils/bouncerHarness.ts.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb } from '../test-utils/testApp.js';

const ctx = setupTestDb('services-bouncer-networks');

let harnessMod: typeof import('../test-utils/bouncerHarness.js');
let bouncerMod: typeof import('./bouncer.js');
let harness: import('../test-utils/bouncerHarness.js').Harness;

beforeAll(async () => {
  process.env.LURKER_BOUNCER_ENABLED = 'true';
  harnessMod = await import('../test-utils/bouncerHarness.js');
  bouncerMod = await import('./bouncer.js');
  harness = await harnessMod.startHarness();
});

afterAll(() => {
  harness.stop();
  ctx.cleanup();
});

beforeEach(() => {
  bouncerMod.resetAuthThrottle();
});

const NUL = String.fromCharCode(0);
function saslPlain(authcid: string, passwd: string): string {
  return Buffer.from(['', authcid, passwd].join(NUL), 'utf8').toString('base64');
}

// Drive CAP + SASL to the point of registration, requesting the given caps.
// Leaves the client at CAP-END-ready (caller sends CAP END + BOUNCER as needed).
type Client = Awaited<ReturnType<import('../test-utils/bouncerHarness.js').Harness['connect']>>;
async function negotiate(
  c: Client,
  acct: { user: { username: string }; password: string },
  caps: string,
): Promise<void> {
  c.send('CAP LS 302');
  await c.waitFor((l) => l.includes('CAP') && l.includes('LS'));
  c.send('NICK client');
  c.send('USER client 0 * :client');
  c.send(`CAP REQ :${caps}`);
  await c.waitFor((l) => l.includes('ACK'));
  c.send('AUTHENTICATE PLAIN');
  await c.waitFor((l) => l === 'AUTHENTICATE +');
  c.send(`AUTHENTICATE ${saslPlain(acct.user.username, acct.password)}`);
  await c.waitForCommand('903');
}

describe('control (unbound) mode', () => {
  it('registers a bouncer-networks client with no network as a control connection', async () => {
    const acct = harnessMod.seedAccount({ nick: 'ctl1' });
    harnessMod.seedNetwork(acct.user, { networkName: 'second', nick: 'ctl1b' });
    const c = await harness.connect();
    await negotiate(c, acct, 'sasl soju.im/bouncer-networks');
    c.send('CAP END');
    const welcome = await c.waitForCommand('005');
    // Control connections must NOT advertise BOUNCER_NETID (that's the signal).
    expect(welcome).not.toContain('BOUNCER_NETID');
    expect(harnessMod.attachedFor(acct)).toBe(0); // not bound to network 1
  });

  it('refuses channel/user traffic on a control connection', async () => {
    const acct = harnessMod.seedAccount({ nick: 'ctl2' });
    const c = await harness.connect();
    await negotiate(c, acct, 'sasl soju.im/bouncer-networks');
    c.send('CAP END');
    await c.waitForCommand('422');
    c.send('PRIVMSG #chan :hi');
    const notice = await c.waitForCommand('NOTICE');
    expect(notice.toLowerCase()).toContain('bind a network');
  });
});

describe('BOUNCER LISTNETWORKS', () => {
  it('returns a batch of BOUNCER NETWORK lines, one per network', async () => {
    const acct = harnessMod.seedAccount({ nick: 'ls1', networkName: 'alpha' });
    harnessMod.seedNetwork(acct.user, { networkName: 'beta', nick: 'ls1b' });
    const c = await harness.connect();
    await negotiate(c, acct, 'sasl soju.im/bouncer-networks');
    c.send('CAP END');
    await c.waitForCommand('422');
    c.send('BOUNCER LISTNETWORKS');
    const open = await c.waitForCommand('BATCH');
    const ref = open.split('BATCH +')[1].split(' ')[0];
    expect(open).toContain('soju.im/bouncer-networks');
    const net1 = await c.waitFor((l) => l.includes('BOUNCER NETWORK') && l.includes('name=alpha'));
    expect(net1).toContain(`@batch=${ref}`);
    expect(net1).toMatch(/BOUNCER NETWORK \d+ /);
    expect(net1).toContain('state=connected'); // fake upstream is "connected"
    await c.waitFor((l) => l.includes('BOUNCER NETWORK') && l.includes('name=beta'));
    await c.waitFor((l) => l.includes(`BATCH -${ref}`));
  });
});

describe('BOUNCER BIND', () => {
  it('binds a network by id and advertises BOUNCER_NETID', async () => {
    const acct = harnessMod.seedAccount({ nick: 'bind1', networkName: 'primary' });
    const second = harnessMod.seedNetwork(acct.user, { networkName: 'secondary', nick: 'bind1b' });
    const c = await harness.connect();
    await negotiate(c, acct, 'sasl soju.im/bouncer-networks');
    c.send(`BOUNCER BIND ${second.network.id}`);
    c.send('CAP END');
    const welcome = await c.waitFor((l) => l.includes('005') && l.includes('BOUNCER_NETID'));
    expect(welcome).toContain(`BOUNCER_NETID=${second.network.id}`);
    expect(bouncerMod.attachedSessionCount(acct.user.id, second.network.id)).toBe(1);
  });

  it('rejects a non-numeric BIND with FAIL INVALID_NETID', async () => {
    const acct = harnessMod.seedAccount({ nick: 'bind2' });
    const c = await harness.connect();
    await negotiate(c, acct, 'sasl soju.im/bouncer-networks');
    c.send('BOUNCER BIND notanumber');
    const fail = await c.waitForCommand('FAIL');
    expect(fail).toContain('INVALID_NETID');
    c.close();
  });

  it('rejects BIND to an unknown id at CAP END with FAIL INVALID_NETID', async () => {
    const acct = harnessMod.seedAccount({ nick: 'bind3' });
    const c = await harness.connect();
    await negotiate(c, acct, 'sasl soju.im/bouncer-networks');
    c.send('BOUNCER BIND 999999');
    c.send('CAP END');
    const fail = await c.waitForCommand('FAIL');
    expect(fail).toContain('INVALID_NETID');
    expect(fail).toContain('999999');
  });

  it('rejects BOUNCER BIND after registration with REGISTRATION_IS_COMPLETED', async () => {
    const acct = harnessMod.seedAccount({ nick: 'bind4' });
    const c = await harness.connect();
    await negotiate(c, acct, 'sasl soju.im/bouncer-networks');
    c.send('CAP END');
    await c.waitForCommand('422');
    c.send('BOUNCER BIND 1');
    const fail = await c.waitForCommand('FAIL');
    expect(fail).toContain('REGISTRATION_IS_COMPLETED');
    c.close();
  });
});

describe('bouncer-networks-notify', () => {
  it('sends an initial batch dump then bare state-change pushes', async () => {
    const acct = harnessMod.seedAccount({ nick: 'nfy1', networkName: 'gamma' });
    const c = await harness.connect();
    await negotiate(c, acct, 'sasl soju.im/bouncer-networks soju.im/bouncer-networks-notify');
    c.send('CAP END');
    // Initial dump is a batch (arrives during/after the welcome burst).
    await c.waitFor((l) => l.includes('BOUNCER NETWORK') && l.includes('name=gamma'));

    // A later state change is an UNbatched BOUNCER NETWORK line.
    harnessMod.emitNetworkState(acct.user.id, acct.network.id, 'disconnected');
    const push = await c.waitFor(
      (l) => l.includes('BOUNCER NETWORK') && l.includes('state=disconnected'),
    );
    expect(push).not.toContain('@batch=');
    expect(push).toContain(`BOUNCER NETWORK ${acct.network.id}`);
  });

  it('does not push state changes to a client without the notify cap', async () => {
    const acct = harnessMod.seedAccount({ nick: 'nfy2' });
    const c = await harness.connect();
    await negotiate(c, acct, 'sasl soju.im/bouncer-networks');
    c.send('CAP END');
    await c.waitForCommand('422');
    harnessMod.emitNetworkState(acct.user.id, acct.network.id, 'disconnected');
    // Give the event a tick; assert no BOUNCER NETWORK push arrived.
    await new Promise((r) => setTimeout(r, 50));
    expect(c.lines.some((l) => l.includes('BOUNCER NETWORK'))).toBe(false);
    c.close();
  });
});
