// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Socket-driven tests for IRCv3 draft/chathistory: CHATHISTORY BEFORE/AFTER/
// LATEST/BETWEEN/AROUND/TARGETS over the message store. See bouncerHarness.ts.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb } from '../test-utils/testApp.js';

const ctx = setupTestDb('services-bouncer-chathistory');

let harnessMod: typeof import('../test-utils/bouncerHarness.js');
let bouncerMod: typeof import('./bouncer.js');
let insertMessage: typeof import('../db/messages.js').insertMessage;
let harness: import('../test-utils/bouncerHarness.js').Harness;

beforeAll(async () => {
  process.env.LURKER_BOUNCER_ENABLED = 'true';
  harnessMod = await import('../test-utils/bouncerHarness.js');
  bouncerMod = await import('./bouncer.js');
  ({ insertMessage } = await import('../db/messages.js'));
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

type Client = Awaited<ReturnType<import('../test-utils/bouncerHarness.js').Harness['connect']>>;

const HISTORY_CAPS = 'sasl batch server-time message-tags draft/chathistory';

// Bind a single-network account (auto-binds without bouncer-networks) with the
// history-relevant caps negotiated.
async function attachBound(
  c: Client,
  acct: { user: { username: string }; password: string },
  caps = HISTORY_CAPS,
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
  c.send('CAP END');
  await c.waitForCommand('422');
}

function seedMessages(networkId: number, target: string, n: number): number[] {
  const ids: number[] = [];
  for (let i = 1; i <= n; i++) {
    ids.push(
      Number(
        insertMessage({
          networkId,
          target,
          time: `2023-05-23T06:00:0${i}.000Z`,
          type: 'message',
          nick: 'bob',
          userhost: 'bob!u@h',
          text: `msg${i}`,
          self: false,
        }).id,
      ),
    );
  }
  return ids;
}

// Collect the BOUNCER... err, chathistory batch lines between BATCH +/- for a ref.
function batchBodies(lines: string[], ref: string): string[] {
  return lines.filter((l) => l.includes(`@batch=${ref}`) || l.includes(`;batch=${ref}`));
}

describe('CHATHISTORY advertisement', () => {
  it('advertises CHATHISTORY + MSGREFTYPES in ISUPPORT when the cap is negotiated', async () => {
    const acct = harnessMod.seedAccount({ nick: 'ch1' });
    const c = await harness.connect();
    await attachBound(c, acct);
    const isupport = c.lines.find((l) => l.includes('CHATHISTORY='));
    expect(isupport).toBeTruthy();
    expect(isupport).toContain('CHATHISTORY=1000');
    expect(isupport).toContain('MSGREFTYPES=timestamp');
    c.close();
  });
});

describe('CHATHISTORY LATEST', () => {
  it('returns the newest messages oldest-first, in a chathistory batch with msgid+time', async () => {
    const acct = harnessMod.seedAccount({ nick: 'ch2' });
    const ids = seedMessages(acct.network.id, '#room', 3);
    const c = await harness.connect();
    await attachBound(c, acct);
    c.send('CHATHISTORY LATEST #room * 100');
    const open = await c.waitFor((l) => l.includes('BATCH +') && l.includes('chathistory'));
    const ref = open.split('BATCH +')[1].split(' ')[0];
    expect(open).toContain('chathistory #room');
    const m1 = await c.waitFor((l) => l.includes('PRIVMSG #room :msg1'));
    expect(m1).toContain(`msgid=${ids[0]}`);
    expect(m1).toContain('time=2023-05-23T06:00:01.000Z');
    expect(m1).toContain(`batch=${ref}`);
    await c.waitFor((l) => l.includes('msg3') && l.includes(`msgid=${ids[2]}`));
    await c.waitFor((l) => l.includes(`BATCH -${ref}`));
  });

  it('still emits the INTERNAL row id as msgid for a row that stored an upstream msgid', async () => {
    // The stored IRCv3 msgid (#450) and the bouncer's playback msgid are
    // different namespaces (MSGREFTYPES=timestamp, see SUPPORTED_CAPS notes) —
    // storing the upstream tag must not leak it into chathistory playback.
    const acct = harnessMod.seedAccount({ nick: 'ch2b' });
    const rowId = Number(
      insertMessage({
        networkId: acct.network.id,
        target: '#tagged',
        time: '2023-05-23T06:00:01.000Z',
        type: 'message',
        nick: 'bob',
        userhost: 'bob!u@h',
        text: 'tagged msg',
        self: false,
        msgid: 'upstream-uuid-1',
      }).id,
    );
    const c = await harness.connect();
    await attachBound(c, acct);
    c.send('CHATHISTORY LATEST #tagged * 100');
    const line = await c.waitFor((l) => l.includes('PRIVMSG #tagged :tagged msg'));
    expect(line).toContain(`msgid=${rowId}`);
    expect(line).not.toContain('upstream-uuid-1');
    c.close();
  });
});

describe('CHATHISTORY BEFORE / AFTER (timestamp, exclusive)', () => {
  it('BEFORE excludes messages at or after the timestamp', async () => {
    const acct = harnessMod.seedAccount({ nick: 'ch3' });
    seedMessages(acct.network.id, '#r', 4); // at :01 :02 :03 :04
    const c = await harness.connect();
    await attachBound(c, acct);
    c.send('CHATHISTORY BEFORE #r timestamp=2023-05-23T06:00:03.000Z 100');
    await c.waitFor((l) => l.includes('BATCH +') && l.includes('chathistory'));
    await c.waitFor((l) => l.includes('msg1'));
    await c.waitFor((l) => l.includes('msg2'));
    await c.waitFor((l) => l.includes('BATCH -'));
    // msg3 (at the bound) and msg4 must NOT appear.
    expect(c.lines.some((l) => l.includes('PRIVMSG #r :msg3'))).toBe(false);
    expect(c.lines.some((l) => l.includes('PRIVMSG #r :msg4'))).toBe(false);
  });

  it('AFTER excludes messages at or before the timestamp', async () => {
    const acct = harnessMod.seedAccount({ nick: 'ch4' });
    seedMessages(acct.network.id, '#r', 4);
    const c = await harness.connect();
    await attachBound(c, acct);
    c.send('CHATHISTORY AFTER #r timestamp=2023-05-23T06:00:02.000Z 100');
    await c.waitFor((l) => l.includes('BATCH +'));
    await c.waitFor((l) => l.includes('msg3'));
    await c.waitFor((l) => l.includes('msg4'));
    await c.waitFor((l) => l.includes('BATCH -'));
    expect(c.lines.some((l) => l.includes('PRIVMSG #r :msg1'))).toBe(false);
    expect(c.lines.some((l) => l.includes('PRIVMSG #r :msg2'))).toBe(false);
  });

  it('a netsplit of joins does not truncate the batch (limit counts real messages)', async () => {
    const acct = harnessMod.seedAccount({ nick: 'chns' });
    seedMessages(acct.network.id, '#split', 1); // one real message at :01
    // Then a flood of joins (non-replayable) at :02..:09.
    for (let i = 2; i <= 9; i++) {
      insertMessage({
        networkId: acct.network.id,
        target: '#split',
        time: `2023-05-23T06:00:0${i}.000Z`,
        type: 'join',
        nick: `joiner${i}`,
        self: false,
      });
    }
    const c = await harness.connect();
    await attachBound(c, acct);
    c.send('CHATHISTORY LATEST #split * 3');
    await c.waitFor((l) => l.includes('BATCH +'));
    // The real message is returned even though the newest rows are all joins.
    const line = await c.waitFor((l) => l.includes('PRIVMSG #split :msg1'));
    expect(line).toContain('PRIVMSG #split :msg1');
    await c.waitFor((l) => l.includes('BATCH -'));
  });
});

describe('CHATHISTORY msgid rejected', () => {
  it('rejects a msgid selector (timestamp-only, MSGREFTYPES=timestamp)', async () => {
    const acct = harnessMod.seedAccount({ nick: 'chm' });
    const c = await harness.connect();
    await attachBound(c, acct);
    const isupport = c.lines.find((l) => l.includes('MSGREFTYPES'));
    expect(isupport).toContain('MSGREFTYPES=timestamp');
    expect(isupport).not.toContain('msgid');
    c.send('CHATHISTORY BEFORE #r msgid=5 100');
    const fail = await c.waitForCommand('FAIL');
    expect(fail).toContain('Invalid first bound');
    c.close();
  });
});

describe('CHATHISTORY TARGETS', () => {
  it('lists active buffers with their last-activity time', async () => {
    const acct = harnessMod.seedAccount({ nick: 'ch6' });
    seedMessages(acct.network.id, '#alpha', 2);
    seedMessages(acct.network.id, '#beta', 1);
    const c = await harness.connect();
    await attachBound(c, acct);
    c.send(
      'CHATHISTORY TARGETS timestamp=2023-05-23T00:00:00.000Z timestamp=2023-05-24T00:00:00.000Z 100',
    );
    const open = await c.waitFor((l) => l.includes('draft/chathistory-targets'));
    const ref = open.split('BATCH +')[1].split(' ')[0];
    const alpha = await c.waitFor((l) => l.includes('CHATHISTORY TARGETS #alpha'));
    // The target line carries the buffer's last-activity server-time.
    expect(alpha).toContain('2023-05-23T06:00:02.000Z');
    expect(alpha).toContain(`@batch=${ref}`);
    await c.waitFor((l) => l.includes('CHATHISTORY TARGETS #beta'));
    await c.waitFor((l) => l.includes(`BATCH -${ref}`));
  });
});

describe('CHATHISTORY errors', () => {
  it('rejects a limit over the advertised maximum', async () => {
    const acct = harnessMod.seedAccount({ nick: 'ch7' });
    const c = await harness.connect();
    await attachBound(c, acct);
    c.send('CHATHISTORY LATEST #r * 99999');
    const fail = await c.waitForCommand('FAIL');
    expect(fail).toContain('INVALID_PARAMS');
    expect(fail).toContain('Invalid limit');
    c.close();
  });

  it('rejects a malformed bound', async () => {
    const acct = harnessMod.seedAccount({ nick: 'ch8' });
    const c = await harness.connect();
    await attachBound(c, acct);
    c.send('CHATHISTORY BEFORE #r msgid=notanumber 100');
    const fail = await c.waitForCommand('FAIL');
    expect(fail).toContain('INVALID_PARAMS');
    expect(fail).toContain('Invalid first bound');
    c.close();
  });

  it('refuses CHATHISTORY on a control (unbound) connection', async () => {
    const acct = harnessMod.seedAccount({ nick: 'ch9' });
    harnessMod.seedNetwork(acct.user, { networkName: 'second', nick: 'ch9b' });
    const c = await harness.connect();
    // Control mode: bouncer-networks cap, no network selector.
    c.send('CAP LS 302');
    await c.waitFor((l) => l.includes('CAP') && l.includes('LS'));
    c.send('NICK client');
    c.send('USER client 0 * :client');
    c.send('CAP REQ :sasl draft/chathistory soju.im/bouncer-networks');
    await c.waitFor((l) => l.includes('ACK'));
    c.send('AUTHENTICATE PLAIN');
    await c.waitFor((l) => l === 'AUTHENTICATE +');
    c.send(`AUTHENTICATE ${saslPlain(acct.user.username, acct.password)}`);
    await c.waitForCommand('903');
    c.send('CAP END');
    await c.waitForCommand('422');
    c.send('CHATHISTORY LATEST #r * 100');
    const fail = await c.waitForCommand('FAIL');
    expect(fail).toContain('INVALID_TARGET');
    c.close();
  });

  it('returns an empty batch (not a FAIL) when there is no history', async () => {
    const acct = harnessMod.seedAccount({ nick: 'ch10' });
    const c = await harness.connect();
    await attachBound(c, acct);
    c.send('CHATHISTORY LATEST #empty * 100');
    const open = await c.waitFor((l) => l.includes('BATCH +') && l.includes('chathistory'));
    const ref = open.split('BATCH +')[1].split(' ')[0];
    const close = await c.waitFor((l) => l.includes(`BATCH -${ref}`));
    expect(close).toBeTruthy();
    expect(batchBodies(c.lines, ref)).toHaveLength(0);
  });
});
