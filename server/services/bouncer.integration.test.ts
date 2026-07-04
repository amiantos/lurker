// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Socket-driven end-to-end tests for the bouncer: a real TCP client attaches to
// the real listener against a fake upstream. See test-utils/bouncerHarness.ts.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb } from '../test-utils/testApp.js';

const ctx = setupTestDb('services-bouncer-integration');

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

describe('PASS login (ZNC-compat floor)', () => {
  it('attaches with PASS user:secret and replays a welcome burst', async () => {
    const acct = harnessMod.seedAccount({ nick: 'welcomer' });
    const c = await harness.connect();
    c.send(`PASS ${acct.user.username}:${acct.password}`);
    c.send('NICK client');
    c.send('USER client 0 * :client');
    const welcome = await c.waitForCommand('001');
    expect(welcome).toContain('001');
    // Nick moves onto the live upstream nick, then MOTD-missing closes the burst.
    await c.waitFor((l) => l.includes('NICK') && l.includes('welcomer'));
    await c.waitForCommand('422');
    expect(harnessMod.attachedFor(acct)).toBe(1);
  });

  it('rejects a bad password with 464 and no attach', async () => {
    const acct = harnessMod.seedAccount();
    const c = await harness.connect();
    c.send(`PASS ${acct.user.username}:wrongpassword`);
    c.send('NICK client');
    c.send('USER client 0 * :client');
    await c.waitForCommand('464');
    expect(harnessMod.attachedFor(acct)).toBe(0);
  });

  it('accepts a read-write API token as the secret', async () => {
    const acct = harnessMod.seedAccount({ nick: 'tokuser' });
    const c = await harness.connect();
    c.send(`PASS ${acct.user.username}:${acct.token}`);
    c.send('NICK client');
    c.send('USER client 0 * :client');
    await c.waitForCommand('001');
    expect(harnessMod.attachedFor(acct)).toBe(1);
  });
});

function saslPlain(authcid: string, passwd: string, authzid = ''): string {
  const NUL = String.fromCharCode(0);
  return Buffer.from([authzid, authcid, passwd].join(NUL), 'utf8').toString('base64');
}

describe('SASL PLAIN', () => {
  it('advertises sasl=PLAIN under CAP 302 and bare sasl otherwise', async () => {
    const c = await harness.connect();
    c.send('CAP LS 302');
    const ls302 = await c.waitFor((l) => l.includes('CAP') && l.includes('LS'));
    expect(ls302).toContain('sasl=PLAIN');
    c.close();

    const c2 = await harness.connect();
    c2.send('CAP LS');
    const ls = await c2.waitFor((l) => l.includes('CAP') && l.includes('LS'));
    expect(ls).toContain('sasl');
    expect(ls).not.toContain('sasl=');
    c2.close();
  });

  it('authenticates via SASL PLAIN and attaches', async () => {
    const acct = harnessMod.seedAccount({ nick: 'saslnick' });
    const c = await harness.connect();
    c.send('CAP LS 302');
    await c.waitFor((l) => l.includes('CAP') && l.includes('LS'));
    c.send('NICK client');
    c.send('USER client 0 * :client');
    c.send('CAP REQ :sasl');
    await c.waitFor((l) => l.includes('ACK') && l.includes('sasl'));
    c.send('AUTHENTICATE PLAIN');
    await c.waitFor((l) => l === 'AUTHENTICATE +');
    c.send(`AUTHENTICATE ${saslPlain(acct.user.username, acct.password)}`);
    await c.waitForCommand('903');
    c.send('CAP END');
    await c.waitForCommand('001');
    expect(harnessMod.attachedFor(acct)).toBe(1);
  });

  it('reads the network from the SASL authcid', async () => {
    const acct = harnessMod.seedAccount({ nick: 'net1', networkName: 'primary' });
    const second = harnessMod.seedNetwork(acct.user, { networkName: 'secondary', nick: 'net2' });
    const c = await harness.connect();
    c.send('CAP LS 302');
    await c.waitFor((l) => l.includes('CAP') && l.includes('LS'));
    c.send('NICK client');
    c.send('USER client 0 * :client');
    c.send('CAP REQ :sasl');
    await c.waitFor((l) => l.includes('ACK'));
    c.send('AUTHENTICATE PLAIN');
    await c.waitFor((l) => l === 'AUTHENTICATE +');
    c.send(`AUTHENTICATE ${saslPlain(`${acct.user.username}/secondary`, acct.password)}`);
    await c.waitForCommand('903');
    c.send('CAP END');
    await c.waitForCommand('001');
    // Attached to the network named in the authcid, not the first one.
    expect(harnessMod.attachedFor(acct)).toBe(0);
    expect(bouncerMod.attachedSessionCount(acct.user.id, second.network.id)).toBe(1);
  });

  it('rejects a bad SASL password with 904 and does not attach', async () => {
    const acct = harnessMod.seedAccount();
    const c = await harness.connect();
    c.send('CAP LS 302');
    await c.waitFor((l) => l.includes('CAP') && l.includes('LS'));
    c.send('NICK client');
    c.send('USER client 0 * :client');
    c.send('CAP REQ :sasl');
    await c.waitFor((l) => l.includes('ACK'));
    c.send('AUTHENTICATE PLAIN');
    await c.waitFor((l) => l === 'AUTHENTICATE +');
    c.send(`AUTHENTICATE ${saslPlain(acct.user.username, 'wrongpassword')}`);
    await c.waitForCommand('904');
    expect(harnessMod.attachedFor(acct)).toBe(0);
  });

  it('rejects a paused account at SASL time (before signaling 903)', async () => {
    const acct = harnessMod.seedAccount();
    const { setUserPaused } = await import('../db/users.js');
    setUserPaused(acct.user.id, true);
    const c = await harness.connect();
    c.send('CAP LS 302');
    await c.waitFor((l) => l.includes('CAP') && l.includes('LS'));
    c.send('NICK client');
    c.send('USER client 0 * :client');
    c.send('CAP REQ :sasl');
    await c.waitFor((l) => l.includes('ACK'));
    c.send('AUTHENTICATE PLAIN');
    await c.waitFor((l) => l === 'AUTHENTICATE +');
    c.send(`AUTHENTICATE ${saslPlain(acct.user.username, acct.password)}`);
    const line = await c.waitForCommand('904');
    expect(line).toContain('paused');
    expect(harnessMod.attachedFor(acct)).toBe(0);
  });

  it('offers the mechanism list (908) for an unknown SASL mechanism', async () => {
    const c = await harness.connect();
    c.send('CAP LS 302');
    await c.waitFor((l) => l.includes('CAP') && l.includes('LS'));
    c.send('CAP REQ :sasl');
    await c.waitFor((l) => l.includes('ACK'));
    c.send('AUTHENTICATE SCRAM-SHA-256');
    const list = await c.waitForCommand('908');
    expect(list).toContain('PLAIN');
    await c.waitForCommand('904');
    c.close();
  });

  it('handles a client-aborted exchange (906)', async () => {
    const c = await harness.connect();
    c.send('CAP LS 302');
    await c.waitFor((l) => l.includes('CAP') && l.includes('LS'));
    c.send('CAP REQ :sasl');
    await c.waitFor((l) => l.includes('ACK'));
    c.send('AUTHENTICATE PLAIN');
    await c.waitFor((l) => l === 'AUTHENTICATE +');
    c.send('AUTHENTICATE *');
    const line = await c.waitForCommand('906');
    expect(line).toContain('aborted');
    c.close();
  });

  it('rejects an over-long multi-chunk SASL response (904)', async () => {
    const c = await harness.connect();
    c.send('CAP LS 302');
    await c.waitFor((l) => l.includes('CAP') && l.includes('LS'));
    c.send('CAP REQ :sasl');
    await c.waitFor((l) => l.includes('ACK'));
    c.send('AUTHENTICATE PLAIN');
    await c.waitFor((l) => l === 'AUTHENTICATE +');
    // 8 KiB cap ÷ 400 per chunk → ~21 full chunks trips it.
    const chunk = 'A'.repeat(400);
    for (let i = 0; i < 25; i++) c.send(`AUTHENTICATE ${chunk}`);
    const line = await c.waitForCommand('904');
    expect(line).toContain('too long');
    c.close();
  });

  it('rejects AUTHENTICATE before the sasl cap is requested', async () => {
    const c = await harness.connect();
    c.send('CAP LS 302');
    await c.waitFor((l) => l.includes('CAP') && l.includes('LS'));
    c.send('AUTHENTICATE PLAIN');
    const line = await c.waitForCommand('904');
    expect(line).toContain('sasl capability');
    c.close();
  });
});

describe('live relay', () => {
  it('relays an upstream PRIVMSG to the attached client', async () => {
    const acct = harnessMod.seedAccount({ nick: 'relayer' });
    const c = await harness.connect();
    c.send(`PASS ${acct.user.username}:${acct.password}`);
    c.send('NICK client');
    c.send('USER client 0 * :client');
    await c.waitForCommand('422');
    acct.upstream.pushUpstream(':bob!b@h PRIVMSG #chan :hello there');
    const line = await c.waitFor((l) => l.includes('PRIVMSG #chan'));
    expect(line).toBe(':bob!b@h PRIVMSG #chan :hello there');
  });

  it('relays a client TAGMSG with its client-only typing tag to the upstream', async () => {
    const acct = harnessMod.seedAccount({ nick: 'typer' });
    const c = await harness.connect();
    c.send(`PASS ${acct.user.username}:${acct.password}`);
    c.send('NICK client');
    c.send('USER client 0 * :client');
    await c.waitForCommand('422');
    c.send('@+typing=active TAGMSG #chan');
    // PING is handled locally and in-order after TAGMSG, so a PONG proves the
    // TAGMSG was already processed and relayed.
    c.send('PING sync');
    await c.waitFor((l) => l.includes('PONG'));
    expect(acct.upstream.rawSent).toContain('@+typing=active TAGMSG #chan');
  });

  it('strips client-only tags when the upstream lacks message-tags', async () => {
    const acct = harnessMod.seedAccount({ nick: 'plainnet' });
    acct.upstream.messageTags = false;
    const c = await harness.connect();
    c.send(`PASS ${acct.user.username}:${acct.password}`);
    c.send('NICK client');
    c.send('USER client 0 * :client');
    await c.waitForCommand('422');
    c.send('@+typing=active TAGMSG #chan');
    c.send('PING sync');
    await c.waitFor((l) => l.includes('PONG'));
    // The bare command still forwards; the tag prefix is dropped so a non-IRCv3
    // server doesn't parse `@+typing=active` as the command.
    expect(acct.upstream.rawSent).toContain('TAGMSG #chan');
    expect(acct.upstream.rawSent.some((l) => l.includes('+typing'))).toBe(false);
  });

  it('never forwards a post-registration AUTHENTICATE to the upstream', async () => {
    const acct = harnessMod.seedAccount({ nick: 'noauth' });
    const c = await harness.connect();
    c.send(`PASS ${acct.user.username}:${acct.password}`);
    c.send('NICK client');
    c.send('USER client 0 * :client');
    await c.waitForCommand('422');
    c.send('AUTHENTICATE OHNOACREDENTIAL');
    await c.waitForCommand('904');
    // The credential-bearing line must not have reached the real network.
    expect(acct.upstream.rawSent.some((l) => l.includes('AUTHENTICATE'))).toBe(false);
  });
});
