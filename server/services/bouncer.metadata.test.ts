// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// draft/metadata-2 through the bouncer (#607). A bouncer is a mirror of the
// account: a client that subscribes to a key gets the network's lines for it,
// on the people it can see, and only those; its own GET/LIST replies come back
// to it alone; a client without the cap gets none of it. Against a real
// IrcConnection on the fake ircd (which speaks metadata the way ergo does),
// with the real bouncer in front.

import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { setupTestDb } from '../test-utils/testApp.js';
import { FakeIrcd, rawClient } from '../test-utils/fakeIrcd.js';
import { until } from '../test-utils/until.js';

const ctx = setupTestDb('services-bouncer-metadata');

let harnessMod: typeof import('../test-utils/bouncerHarness.js');
let bouncerMod: typeof import('./bouncer.js');
let ircManager: typeof import('./ircManager.js').default;
let users: typeof import('../db/users.js');
let networks: typeof import('../db/networks.js');
let hashPassword: typeof import('./password.js').hashPassword;
let harness: import('../test-utils/bouncerHarness.js').Harness;
let ircd: FakeIrcd;

beforeAll(async () => {
  process.env.LURKER_BOUNCER_ENABLED = 'true';
  harnessMod = await import('../test-utils/bouncerHarness.js');
  bouncerMod = await import('./bouncer.js');
  ircManager = (await import('./ircManager.js')).default;
  users = await import('../db/users.js');
  networks = await import('../db/networks.js');
  ({ hashPassword } = await import('./password.js'));
  ircd = await FakeIrcd.start({ metadata: true });
  harness = await harnessMod.startHarness();
});

afterAll(async () => {
  harness.stop();
  await ircd.close();
  ctx.cleanup();
});

beforeEach(() => {
  bouncerMod.resetAuthThrottle();
});

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

type Client = Awaited<ReturnType<import('../test-utils/bouncerHarness.js').Harness['connect']>>;
type Conn = import('./ircConnection.js').IrcConnection;

interface Account {
  userId: number;
  username: string;
  name: string;
  nick: string;
  networkId: number;
  conn: Conn;
}

const PASSWORD = 'hunter2hunter2';
const NUL = String.fromCharCode(0);
let seq = 0;

async function seedAccount(): Promise<Account> {
  seq += 1;
  const user = users.createUser(`meta_${seq}`);
  users.setPasswordHash(user.id, hashPassword(PASSWORD));
  const name = 'neta';
  const nick = `meta${seq}`;
  const network = networks.createNetwork(user.id, {
    name,
    host: '127.0.0.1',
    port: ircd.port,
    tls: false,
    nick,
    autoconnect: false,
  } as Parameters<typeof networks.createNetwork>[1])!;
  const conn = ircManager.startNetwork(user.id, network.id)!;
  cleanups.push(() => {
    conn.dispose();
    ircManager.connectionsForUser(user.id).delete(network.id);
  });
  await until(() => conn.state === 'connected', 5000, 'connected');
  // Lurker's own SUB and the SYNC it draws have settled.
  const me = await ircd.waitForRegistration(nick);
  await until(() => me.sent.some((l) => l === 'METADATA *ALL SYNC'), 5000, 'synced');
  return { userId: user.id, username: user.username, name, nick, networkId: network.id, conn };
}

/** Attach over SASL, asking for `caps` beside it. */
async function attach(acct: Account, caps: string[] = []): Promise<Client> {
  const c = await harness.connect();
  cleanups.push(() => c.close());
  c.send('CAP LS 302');
  await c.waitFor((l) => l.includes('CAP') && l.includes('LS'));
  c.send('NICK client');
  c.send('USER client 0 * :client');
  c.send(`CAP REQ :${['sasl', ...caps].join(' ')}`);
  await c.waitFor((l) => l.includes('ACK'));
  c.send('AUTHENTICATE PLAIN');
  await c.waitFor((l) => l === 'AUTHENTICATE +');
  const login = `${acct.username}/${acct.name}`;
  c.send(`AUTHENTICATE ${Buffer.from(['', login, PASSWORD].join(NUL)).toString('base64')}`);
  await c.waitForCommand('903');
  c.send('CAP END');
  await c.waitForCommand('422');
  return c;
}

const commandOf = (line: string) => harnessMod.commandOf(line);

let probeSeq = 0;
// A round trip after the line under test: once the probe's 366 lands, anything
// the network wrote earlier has reached this client. A fresh name each time
// (waitFor matches past lines too).
async function roundTrip(c: Client): Promise<void> {
  const probe = `#probe${++probeSeq}`;
  c.send(`NAMES ${probe}`);
  await c.waitFor((l) => commandOf(l) === '366' && l.includes(probe), 5000);
}

async function join(acct: Account, chan: string): Promise<void> {
  ircManager.joinChannel(acct.userId, acct.networkId, chan);
  await until(() => acct.conn.isChannelJoined(chan), 5000, `joined ${chan}`);
}

describe('bouncer metadata', () => {
  it('advertises the cap with the network’s limits, and answers SUB/UNSUB/SUBS itself', async () => {
    const acct = await seedAccount();
    const c = await harness.connect();
    cleanups.push(() => c.close());
    c.send('CAP LS 302');
    const ls = await c.waitFor((l) => l.includes('CAP') && l.includes('LS'));
    // Offered before binding, bare; the value needs the network.
    expect(ls).toContain('draft/metadata-2');
    c.close();

    const client = await attach(acct, ['draft/metadata-2']);
    client.send('METADATA * SUB avatar display-name');
    const ok = await client.waitForCommand('770');
    expect(ok).toContain(`770 ${acct.nick} avatar display-name`);
    client.send('METADATA * SUBS');
    const subs = await client.waitForCommand('772');
    expect(subs).toMatch(/772 \S+ (avatar display-name|display-name avatar)$/);
    client.send('METADATA * UNSUB display-name');
    expect(await client.waitForCommand('771')).toContain(`771 ${acct.nick} display-name`);
    client.send('METADATA * SUB Bad%Key');
    expect(await client.waitForCommand('FAIL')).toContain('FAIL METADATA KEY_INVALID bad%key');
    // None of that went upstream as a SUB of its own beyond the keys Lurker
    // doesn't hold (none here: both are Lurker's).
    const me = ircd.client(acct.nick)!;
    expect(me.sent.filter((l) => l.startsWith('METADATA * SUB'))).toHaveLength(1);
  });

  it('relays a peer’s change to a subscribed client that can see them, and to nobody else', async () => {
    const acct = await seedAccount();
    await join(acct, '#shared');
    const peer = await rawClient(ircd.port, `peer${seq}`);
    cleanups.push(() => peer.socket.destroy());
    peer.send('JOIN #shared');
    await until(() => acct.conn.channelState('#shared')?.members.has(`peer${seq}`) ?? false, 5000);

    const subscribed = await attach(acct, ['draft/metadata-2']);
    const unsubscribed = await attach(acct, ['draft/metadata-2']);
    const noCap = await attach(acct, []);
    subscribed.send('METADATA * SUB display-name');
    await subscribed.waitForCommand('770');

    ircd.setMetadata(`peer${seq}`, 'display-name', 'The Peer');
    const got = await subscribed.waitFor((l) => commandOf(l) === '761' && l.includes('The Peer'));
    expect(got).toContain(`761 * peer${seq} display-name * :The Peer`);
    await roundTrip(unsubscribed);
    await roundTrip(noCap);
    expect(unsubscribed.lines.filter((l) => commandOf(l) === '761')).toEqual([]);
    expect(noCap.lines.filter((l) => commandOf(l) === '761')).toEqual([]);

    // A nick it shares no channel with: not its.
    const stranger = await rawClient(ircd.port, `far${seq}`);
    cleanups.push(() => stranger.socket.destroy());
    const before = subscribed.lines.filter((l) => commandOf(l) === '761').length;
    ircd.setMetadata(`far${seq}`, 'display-name', 'Far Away');
    await roundTrip(subscribed);
    expect(subscribed.lines.filter((l) => commandOf(l) === '761')).toHaveLength(before);
  });

  it('gives a client its own LIST reply alone, as a batch', async () => {
    const acct = await seedAccount();
    await join(acct, '#listed');
    const peer = await rawClient(ircd.port, `lp${seq}`);
    cleanups.push(() => peer.socket.destroy());
    peer.send('JOIN #listed');
    await until(() => acct.conn.channelState('#listed')?.members.has(`lp${seq}`) ?? false, 5000);
    ircd.setMetadata(`lp${seq}`, 'pronouns', 'they/them');

    const asker = await attach(acct, ['draft/metadata-2', 'batch']);
    const other = await attach(acct, ['draft/metadata-2', 'batch']);
    asker.send(`METADATA lp${seq} LIST`);
    const start = await asker.waitFor((l) => commandOf(l) === 'BATCH' && l.includes('+'), 5000);
    const ref = start.split(' ')[2].slice(1);
    const row = await asker.waitFor((l) => l.includes(`761 ${acct.nick} lp${seq} pronouns`), 5000);
    expect(row).toContain(`@batch=${ref}`);
    await asker.waitFor((l) => l.includes(`BATCH -${ref}`), 5000);
    await roundTrip(other);
    expect(other.lines.filter((l) => l.includes('pronouns'))).toEqual([]);
  });

  it('replays what the connection knows on attach, and SUBs the network for a key Lurker doesn’t hold', async () => {
    const acct = await seedAccount();
    await join(acct, '#known');
    const peer = await rawClient(ircd.port, `kp${seq}`);
    cleanups.push(() => peer.socket.destroy());
    peer.send('JOIN #known');
    await until(() => acct.conn.channelState('#known')?.members.has(`kp${seq}`) ?? false, 5000);
    ircd.setMetadata(`kp${seq}`, 'display-name', 'Known Peer');
    await until(() => acct.conn.userMetadataRecord(`kp${seq}`)?.['display-name'] === 'Known Peer');

    const client = await attach(acct, ['draft/metadata-2']);
    client.send('METADATA * SUB display-name bot');
    await client.waitForCommand('770');
    // The SUB's own replay of current values.
    expect(await client.waitFor((l) => l.includes('Known Peer'))).toContain(
      `761 ${acct.nick} kp${seq} display-name * :Known Peer`,
    );
    // `bot` isn't one of Lurker's keys: the socket's subscription grows.
    const me = ircd.client(acct.nick)!;
    await until(() => me.sent.some((l) => l === 'METADATA * SUB bot'), 5000, 'bot SUB upstream');
    ircd.setMetadata(`kp${seq}`, 'bot', 'yes');
    expect(await client.waitFor((l) => l.includes(' bot '))).toContain(`761 * kp${seq} bot * :yes`);
    // Kept beside Lurker's own keys, so a later SUB can be answered from
    // state; the web client's view never carries it (ircMetadata.test.ts).
    expect(acct.conn.userMetadataRecord(`kp${seq}`)).toEqual({
      'display-name': 'Known Peer',
      bot: 'yes',
    });

    // A second client attaching later: the join burst carries nothing until it
    // subscribes, then its SUB replays.
    const late = await attach(acct, ['draft/metadata-2']);
    await roundTrip(late);
    expect(late.lines.filter((l) => commandOf(l) === '761')).toEqual([]);
    late.send('METADATA * SUB display-name bot');
    expect(await late.waitFor((l) => l.includes('Known Peer'))).toContain(`761 ${acct.nick}`);
    expect(await late.waitFor((l) => l.includes(' bot '))).toContain(
      `761 ${acct.nick} kp${seq} bot * :yes`,
    );
  });
});

describe('bouncer metadata, the harder cases', () => {
  it('answers a SYNC from what the connection holds, for that client’s keys only', async () => {
    const acct = await seedAccount();
    await join(acct, '#synced');
    const peer = await rawClient(ircd.port, `sp${seq}`);
    cleanups.push(() => peer.socket.destroy());
    peer.send('JOIN #synced');
    await until(() => acct.conn.channelState('#synced')?.members.has(`sp${seq}`) ?? false, 5000);
    ircd.setMetadata(`sp${seq}`, 'display-name', 'Synced Peer');
    ircd.setMetadata(`sp${seq}`, 'pronouns', 'she/her');
    await until(() => acct.conn.userMetadataRecord(`sp${seq}`)?.pronouns === 'she/her');

    const a = await attach(acct, ['draft/metadata-2', 'batch']);
    a.send('METADATA * SUB display-name');
    await a.waitForCommand('770');
    const me = ircd.client(acct.nick)!;
    const upstreamBefore = me.sent.filter((l) => l.includes('SYNC')).length;
    a.send('METADATA #synced SYNC');
    const start = await a.waitFor((l) => commandOf(l) === 'BATCH' && l.includes('+'), 5000);
    const ref = start.split(' ')[2].slice(1);
    await a.waitFor((l) => l.includes(`BATCH -${ref}`), 5000);
    const inBatch = a.lines.filter((l) => l.startsWith(`@batch=${ref}`));
    expect(inBatch).toHaveLength(1);
    expect(inBatch[0]).toContain(`761 ${acct.nick} sp${seq} display-name * :Synced Peer`);
    // Nothing went up: the answer came from state.
    expect(me.sent.filter((l) => l.includes('SYNC'))).toHaveLength(upstreamBefore);
  });

  it('takes a key off the socket when its last holder lets go, and refuses past max-subs', async () => {
    const acct = await seedAccount();
    const me = ircd.client(acct.nick)!;
    const a = await attach(acct, ['draft/metadata-2']);
    const b = await attach(acct, ['draft/metadata-2']);
    a.send('METADATA * SUB bot');
    b.send('METADATA * SUB bot');
    await a.waitForCommand('770');
    await b.waitForCommand('770');
    await until(() => me.sent.some((l) => l === 'METADATA * SUB bot'), 5000, 'bot up');
    a.send('METADATA * UNSUB bot');
    await a.waitForCommand('771');
    await roundTrip(a);
    expect(me.sent.some((l) => l.startsWith('METADATA * UNSUB'))).toBe(false);
    b.send('METADATA * UNSUB bot');
    await b.waitForCommand('771');
    await until(() => me.sent.some((l) => l === 'METADATA * UNSUB bot'), 5000, 'bot off');

    // The fake allows 10; Lurker's seven leave room for three more.
    a.send('METADATA * SUB k1 k2 k3 k4');
    // Not waitForCommand: the 770 for `bot` above is already there to match.
    const ok = await a.waitFor((l) => commandOf(l) === '770' && l.includes('k1'), 5000);
    expect(ok).toContain('770 ' + acct.nick + ' k1 k2 k3');
    expect(await a.waitForCommand('FAIL')).toContain('FAIL METADATA TOO_MANY_SUBS k4');
    // A client leaving releases what only it held.
    a.close();
    await until(() => me.sent.some((l) => l.startsWith('METADATA * UNSUB k1')), 5000, 'released');
  });

  it("relays the web user's own SET to the other clients that subscribed", async () => {
    const acct = await seedAccount();
    const a = await attach(acct, ['draft/metadata-2']);
    a.send('METADATA * SUB display-name');
    await a.waitForCommand('770');
    acct.conn.raw('METADATA * SET display-name :Web Me');
    const got = await a.waitFor((l) => l.includes('Web Me'), 5000);
    expect(got).toContain(`761 * ${acct.nick} display-name * :Web Me`);
    // Once, not twice (the raw relay gave it to nobody: the user asked).
    await roundTrip(a);
    expect(a.lines.filter((l) => l.includes('Web Me'))).toHaveLength(1);
  });
});
