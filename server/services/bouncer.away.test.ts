// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Away through the bouncer (the plan's "Away" section). A client's AWAY sets the
// network it's attached to (#994), as in ZNC and soju, and that network's clients
// hear a change as a 305 or 306. A control connection's sets every network.
// `AWAY *` (draft/pre-away) marks a connection that isn't the user, and any other
// attached client holds auto-away off. Against real IrcConnections on the fake
// ircd, with the real bouncer in front of them.

import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { setupTestDb } from '../test-utils/testApp.js';
import { FakeIrcd } from '../test-utils/fakeIrcd.js';
import { until } from '../test-utils/until.js';

const ctx = setupTestDb('services-bouncer-away');

let harnessMod: typeof import('../test-utils/bouncerHarness.js');
let bouncerMod: typeof import('./bouncer.js');
let ircManager: typeof import('./ircManager.js').default;
let presence: typeof import('./presence.js');
let users: typeof import('../db/users.js');
let networks: typeof import('../db/networks.js');
let settings: typeof import('../db/settings.js');
let awayState: typeof import('../db/networkAwayState.js');
let hashPassword: typeof import('./password.js').hashPassword;
let harness: import('../test-utils/bouncerHarness.js').Harness;
let ircd: FakeIrcd;

beforeAll(async () => {
  process.env.LURKER_BOUNCER_ENABLED = 'true';
  // A network the fake ircd drops comes back after the 1 s reconnect floor, not
  // 2–5 s. Read when the connection module loads, so set before the imports below.
  process.env.LURKER_RECONNECT_BASE_MS = '50';
  process.env.LURKER_RECONNECT_JITTER_MS = '0';
  harnessMod = await import('../test-utils/bouncerHarness.js');
  bouncerMod = await import('./bouncer.js');
  ircManager = (await import('./ircManager.js')).default;
  presence = await import('./presence.js');
  users = await import('../db/users.js');
  networks = await import('../db/networks.js');
  settings = await import('../db/settings.js');
  awayState = await import('../db/networkAwayState.js');
  ({ hashPassword } = await import('./password.js'));
  ircd = await FakeIrcd.start({});
  harness = await harnessMod.startHarness();
});

afterAll(async () => {
  harness.stop();
  await ircd.close();
  ctx.cleanup();
  delete process.env.LURKER_RECONNECT_BASE_MS;
  delete process.env.LURKER_RECONNECT_JITTER_MS;
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

interface Net {
  name: string;
  nick: string;
  networkId: number;
  conn: Conn;
}

interface Account {
  userId: number;
  username: string;
  nets: Net[];
  // Everything the account's connections published.
  events: Array<Record<string, unknown>>;
}

const PASSWORD = 'hunter2hunter2';
const NUL = String.fromCharCode(0);
let seq = 0;

// A user with two networks, each a real IrcConnection registered on the fake ircd.
async function seedAccount(): Promise<Account> {
  seq += 1;
  const user = users.createUser(`away_${seq}`);
  users.setPasswordHash(user.id, hashPassword(PASSWORD));
  const events: Array<Record<string, unknown>> = [];
  const listener = (event: Record<string, unknown>) => {
    if (event.userId === user.id) events.push(event);
  };
  ircManager.on('event', listener);
  cleanups.push(() => ircManager.off('event', listener));
  const nets: Net[] = [];
  for (const name of ['neta', 'netb']) {
    const nick = `${name}${seq}`;
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
    await until(() => conn.state === 'connected', 5000, `${name} connected`);
    nets.push({ name, nick, networkId: network.id, conn });
  }
  return { userId: user.id, username: user.username, nets, events };
}

// Auto-away after 50 ms for this account. It's switched off again before the
// test's clients close, so no timer outlives the test.
function fastAutoAway(acct: Account): void {
  settings.setUserSetting(acct.userId, 'away.auto.delay_seconds', 0.05);
  cleanups.push(() => {
    settings.setUserSetting(acct.userId, 'away.auto.enabled', false);
    presence.clearAutoAway(acct.userId);
  });
}

// Log in over SASL to `network`, or register a control connection for null, send
// `before` ahead of CAP END, and wait for the end of the welcome.
async function attach(
  acct: Account,
  network: string | null,
  opts: { caps?: string; before?: string[] } = {},
): Promise<Client> {
  const c = await harness.connect();
  cleanups.push(() => c.close());
  c.send('CAP LS 302');
  await c.waitFor((l) => l.includes('CAP') && l.includes('LS'));
  c.send('NICK client');
  c.send('USER client 0 * :client');
  c.send(`CAP REQ :${opts.caps ?? 'sasl'}`);
  await c.waitFor((l) => l.includes('ACK'));
  c.send('AUTHENTICATE PLAIN');
  await c.waitFor((l) => l === 'AUTHENTICATE +');
  const login = network ? `${acct.username}/${network}` : acct.username;
  c.send(`AUTHENTICATE ${Buffer.from(['', login, PASSWORD].join(NUL)).toString('base64')}`);
  await c.waitForCommand('903');
  for (const line of opts.before ?? []) c.send(line);
  c.send('CAP END');
  await c.waitForCommand('422');
  return c;
}

const commandOf = (line: string) => harnessMod.commandOf(line);

// The fake ircd's latest connection with this nick: after a reconnect, the new one.
function fakeOf(nick: string) {
  const client = ircd.clients.filter((c) => c.nick === nick).at(-1);
  if (!client) throw new Error(`no ${nick} on the fake ircd`);
  return client;
}

// The AWAY lines a network's latest connection got from Lurker.
function aways(net: Net): string[] {
  return fakeOf(net.nick).sent.filter((line) => commandOf(line) === 'AWAY');
}

// The 305s and 306s a client got, from line `from` on.
function awayReplies(c: Client, from = 0): string[] {
  return c.lines.slice(from).filter((line) => ['305', '306'].includes(commandOf(line)));
}

function rowOf(net: Net) {
  return awayState.getNetworkAwayState(net.networkId);
}

function isAway(net: Net): boolean {
  return awayState.isAwayRow(rowOf(net));
}

// The server-buffer rows a network's connection published after `from`.
function rows(acct: Account, net: Net, from: number): unknown[] {
  return acct.events
    .slice(from)
    .filter((e) => e.type === 'motd' && e.networkId === net.networkId)
    .map((e) => e.text);
}

let tokens = 0;
// Every line the clients sent has been handled, every line Lurker sent the
// networks has arrived, and every line they sent back has reached Lurker and the
// clients. The bouncer answers a PING after the lines before it, and the fake
// ircd writes the NOTICE after the lines before it.
async function settle(acct: Account, clients: Client[]): Promise<void> {
  const token = `settle${++tokens}`;
  const pong = async (suffix: string) => {
    for (const c of clients) {
      c.send(`PING ${token}${suffix}`);
      await c.waitFor((l) => commandOf(l) === 'PONG' && l.endsWith(`:${token}${suffix}`));
    }
  };
  await pong('a');
  const live = acct.nets.filter((net) => net.conn.state === 'connected');
  for (const net of live) net.conn.client.raw(`PING ${token}`);
  await until(
    () => live.every((net) => fakeOf(net.nick).sent.includes(`PING ${token}`)),
    5000,
    `${token} at the ircd`,
  );
  for (const net of live) {
    ircd.sendRaw(net.nick, `:fake.test NOTICE ${net.nick} :${token}`);
    await until(
      () => acct.events.some((e) => e.networkId === net.networkId && e.text === token),
      5000,
      `${token} back from ${net.name}`,
    );
  }
  await pong('b');
}

describe('a client’s AWAY', () => {
  it('goes to its own network, and that network’s clients hear it once, from the bouncer', async () => {
    const acct = await seedAccount();
    const [a, b] = acct.nets;
    const c1 = await attach(acct, 'neta');
    const c2 = await attach(acct, 'neta');
    const cb = await attach(acct, 'netb');
    await settle(acct, [c1, c2, cb]);
    const marks = [c1, c2, cb].map((c) => c.lines.length);
    const published = acct.events.length;

    c1.send('AWAY :lunch');
    await settle(acct, [c1, c2, cb]);

    expect(aways(a)).toEqual(['AWAY :lunch']);
    expect(aways(b)).toEqual([]);
    expect(rowOf(a)).toMatchObject({ away_message: 'lunch', back_datetime: null, auto_set: 0 });
    expect(rowOf(b)).toBeNull();
    // c1's reply and c2's news are the bouncer's. The network's 306 answers
    // Lurker, so it reaches no client and writes no server-buffer row.
    [c1, c2].forEach((c, i) => {
      expect(awayReplies(c, marks[i])).toEqual([
        expect.stringMatching(/^:lurker\.bouncer 306 \S+ :You have been marked as being away$/),
      ]);
    });
    expect(awayReplies(cb, marks[2])).toEqual([]);
    expect(acct.events.slice(published).filter((e) => e.type === 'motd')).toEqual([]);
  });

  it('sends a new message to the network, and only the client that sent it hears back', async () => {
    const acct = await seedAccount();
    const [a, b] = acct.nets;
    const c1 = await attach(acct, 'neta');
    const c2 = await attach(acct, 'neta');
    c1.send('AWAY :lunch');
    await settle(acct, [c1, c2]);
    const marks = [c1.lines.length, c2.lines.length];

    c1.send('AWAY :dinner');
    await settle(acct, [c1, c2]);

    expect(aways(a)).toEqual(['AWAY :lunch', 'AWAY :dinner']);
    expect(aways(b)).toEqual([]);
    expect(awayReplies(c1, marks[0])).toEqual([expect.stringMatching(/ 306 /)]);
    expect(awayReplies(c2, marks[1])).toEqual([]);
  });

  it('answers a bare AWAY while not away, and sends the networks nothing', async () => {
    const acct = await seedAccount();
    const c = await attach(acct, 'neta');
    const mark = c.lines.length;

    c.send('AWAY');
    await settle(acct, [c]);

    expect(acct.nets.map(aways)).toEqual([[], []]);
    expect(awayReplies(c, mark)).toEqual([
      expect.stringMatching(/ 305 \S+ :You are no longer marked as being away$/),
    ]);
  });

  it('sets each network once when a client sends it on every network, as irssi does', async () => {
    const acct = await seedAccount();
    const [a, b] = acct.nets;
    const ca = await attach(acct, 'neta');
    const cb = await attach(acct, 'netb');
    await settle(acct, [ca, cb]);
    const marks = [ca.lines.length, cb.lines.length];
    const published = acct.events.length;

    ca.send('AWAY :gone');
    cb.send('AWAY :gone');
    await settle(acct, [ca, cb]);

    expect(aways(a)).toEqual(['AWAY :gone']);
    expect(aways(b)).toEqual(['AWAY :gone']);
    // Each got its own 306 and nothing from the other network.
    expect(awayReplies(ca, marks[0])).toHaveLength(1);
    expect(awayReplies(cb, marks[1])).toHaveLength(1);
    // The apps' away divider moved once on each network.
    expect(acct.events.slice(published).filter((e) => e.type === 'away-state')).toHaveLength(2);
  });

  it('reaches the clients when the apps change it, and a client’s bare AWAY undoes only its own network', async () => {
    const acct = await seedAccount();
    const [a, b] = acct.nets;
    const ca = await attach(acct, 'neta');
    const cb = await attach(acct, 'netb');
    await settle(acct, [ca, cb]);
    let marks = [ca.lines.length, cb.lines.length];

    ircManager.setAway(acct.userId, 'all', 'from the apps');
    await settle(acct, [ca, cb]);
    expect(awayReplies(ca, marks[0])).toEqual([expect.stringMatching(/ 306 /)]);
    expect(awayReplies(cb, marks[1])).toEqual([expect.stringMatching(/ 306 /)]);
    marks = [ca.lines.length, cb.lines.length];

    cb.send('AWAY');
    await settle(acct, [ca, cb]);
    expect(isAway(a)).toBe(true);
    expect(isAway(b)).toBe(false);
    expect(aways(a)).toEqual(['AWAY :from the apps']);
    expect(aways(b)).toEqual(['AWAY :from the apps', 'AWAY']);
    expect(awayReplies(ca, marks[0])).toEqual([]);
    expect(awayReplies(cb, marks[1])).toEqual([expect.stringMatching(/ 305 /)]);
  });

  it('reaches only that network’s clients when the apps set one network away', async () => {
    const acct = await seedAccount();
    const [a, b] = acct.nets;
    const ca = await attach(acct, 'neta');
    const cb = await attach(acct, 'netb');
    const control = await attach(acct, null);
    await settle(acct, [ca, cb, control]);
    const marks = [ca, cb, control].map((c) => c.lines.length);

    ircManager.setAway(acct.userId, a.networkId, 'just here');
    await settle(acct, [ca, cb, control]);

    expect(aways(a)).toEqual(['AWAY :just here']);
    expect(aways(b)).toEqual([]);
    expect(awayReplies(ca, marks[0])).toEqual([expect.stringMatching(/ 306 /)]);
    expect(awayReplies(cb, marks[1])).toEqual([]);
    // A control connection hears a change that covered every network.
    expect(awayReplies(control, marks[2])).toEqual([]);
  });

  it('tells a client that attaches while its network is away, after its channels, and a control connection too', async () => {
    const acct = await seedAccount();
    const [a] = acct.nets;
    a.conn.join('#away');
    await until(
      () => !!a.conn.channelState('#away') && !a.conn.membersPending('#away'),
      5000,
      'joined #away',
    );
    ircManager.setAway(acct.userId, 'all', 'gone');

    const c = await attach(acct, 'neta');
    const control = await attach(acct, null);
    await settle(acct, [c, control]);

    const join = c.lines.findIndex((l) => commandOf(l) === 'JOIN');
    expect(join).toBeGreaterThan(-1);
    expect(c.lines.findIndex((l) => commandOf(l) === '306')).toBeGreaterThan(join);
    expect(awayReplies(c)).toHaveLength(1);
    expect(awayReplies(control)).toHaveLength(1);
  });

  it('tells a client nothing on attach when only another network is away', async () => {
    const acct = await seedAccount();
    const [a] = acct.nets;
    ircManager.setAway(acct.userId, a.networkId, 'gone');

    const cb = await attach(acct, 'netb');
    // A control connection is away only when every network is.
    const control = await attach(acct, null);
    await settle(acct, [cb, control]);

    expect(awayReplies(cb)).toEqual([]);
    expect(awayReplies(control)).toEqual([]);
  });

  it('tells a control connection when one network’s change makes every network away, or not', async () => {
    const acct = await seedAccount();
    const [a, b] = acct.nets;
    ircManager.setAway(acct.userId, a.networkId, 'gone');
    const control = await attach(acct, null);
    await settle(acct, [control]);
    let mark = control.lines.length;

    ircManager.setAway(acct.userId, b.networkId, 'gone too');
    await settle(acct, [control]);
    expect(awayReplies(control, mark)).toEqual([expect.stringMatching(/ 306 /)]);
    mark = control.lines.length;

    // A new message on one network changes nothing for it.
    ircManager.setAway(acct.userId, b.networkId, 'still gone');
    await settle(acct, [control]);
    expect(awayReplies(control, mark)).toEqual([]);

    ircManager.clearAway(acct.userId, a.networkId);
    await settle(acct, [control]);
    expect(awayReplies(control, mark)).toEqual([expect.stringMatching(/ 305 /)]);
    mark = control.lines.length;

    // Already not every network: another network back changes nothing for it.
    ircManager.clearAway(acct.userId, b.networkId);
    await settle(acct, [control]);
    expect(awayReplies(control, mark)).toEqual([]);
  });

  it('tells a control connection when a network added or deleted changes whether every network is away', async () => {
    const acct = await seedAccount();
    ircManager.setAway(acct.userId, 'all', 'gone');
    const control = await attach(acct, null);
    await settle(acct, [control]);
    expect(awayReplies(control)).toEqual([expect.stringMatching(/ 306 /)]);
    let mark = control.lines.length;

    // A network that was never away: not every network is away any more.
    const added = networks.createNetwork(acct.userId, {
      name: 'netc',
      host: '127.0.0.1',
      port: ircd.port,
      tls: false,
      nick: `netc${seq}`,
      autoconnect: false,
    } as Parameters<typeof networks.createNetwork>[1])!;
    ircManager.networkChanged(acct.userId, added.id);
    await settle(acct, [control]);
    expect(awayReplies(control, mark)).toEqual([expect.stringMatching(/ 305 /)]);
    mark = control.lines.length;

    // An edit changes nothing for it.
    ircManager.networkChanged(acct.userId, acct.nets[0].networkId);
    await settle(acct, [control]);
    expect(awayReplies(control, mark)).toEqual([]);

    // The only network that wasn't away goes: every network is again.
    networks.deleteNetwork(added.id, acct.userId);
    ircManager.networkChanged(acct.userId, added.id);
    await settle(acct, [control]);
    expect(awayReplies(control, mark)).toEqual([expect.stringMatching(/ 306 /)]);
  });

  it('works on a control connection, which sets every network, and with a network down', async () => {
    const acct = await seedAccount();
    const [a, b] = acct.nets;
    const control = await attach(acct, null);
    const c = await attach(acct, 'neta');
    await settle(acct, [control, c]);
    let marks = [control.lines.length, c.lines.length];

    control.send('AWAY :from control');
    await settle(acct, [control, c]);
    expect(acct.nets.map(isAway)).toEqual([true, true]);
    expect(aways(a)).toEqual(['AWAY :from control']);
    expect(aways(b)).toEqual(['AWAY :from control']);
    expect(awayReplies(control, marks[0])).toEqual([expect.stringMatching(/ 306 /)]);
    expect(awayReplies(c, marks[1])).toEqual([expect.stringMatching(/ 306 /)]);
    expect(control.lines.slice(marks[0]).filter((l) => commandOf(l) === 'NOTICE')).toEqual([]);

    a.conn.disconnect();
    await until(() => a.conn.state === 'disconnected', 5000, 'neta down');
    await settle(acct, [control, c]);
    marks = [control.lines.length, c.lines.length];

    // The client's network comes back with its socket down; the other stays away.
    // Not every network is away now, so the control connection is back too.
    c.send('AWAY');
    await settle(acct, [control, c]);
    expect(acct.nets.map(isAway)).toEqual([false, true]);
    expect(awayReplies(c, marks[1])).toEqual([expect.stringMatching(/ 305 /)]);
    expect(awayReplies(control, marks[0])).toEqual([expect.stringMatching(/ 305 /)]);
    expect(aways(a)).toEqual(['AWAY :from control']);
    expect(aways(b)).toEqual(['AWAY :from control']);
    marks = [control.lines.length, c.lines.length];

    control.send('AWAY');
    await settle(acct, [control, c]);
    expect(acct.nets.map(isAway)).toEqual([false, false]);
    expect(awayReplies(control, marks[0])).toEqual([expect.stringMatching(/ 305 /)]);
    expect(awayReplies(c, marks[1])).toEqual([]);
    expect(aways(b)).toEqual(['AWAY :from control', 'AWAY']);
  });
});

describe('the AWAY Lurker sends', () => {
  it('keeps its 306 apart from the reply to an AWAY the user sent raw', async () => {
    const acct = await seedAccount();
    const [a] = acct.nets;
    await settle(acct, []);
    const published = acct.events.length;

    // Lurker's AWAY goes out first, then a bare one the user typed. The network
    // answers in that order, and only the second answer is the user's to see.
    ircManager.setAway(acct.userId, 'all', 'lunch');
    a.conn.raw('AWAY', 'user');
    await settle(acct, []);

    expect(rows(acct, a, published)).toEqual([
      expect.stringMatching(/no longer marked as being away/),
    ]);
  });

  it('sends the network’s away again when it reconnects', async () => {
    const acct = await seedAccount();
    const [a] = acct.nets;
    ircManager.setAway(acct.userId, a.networkId, 'lunch');
    await settle(acct, []);
    const before = fakeOf(a.nick);
    const published = acct.events.length;

    ircd.drop(a.nick, false);
    await until(
      () => fakeOf(a.nick) !== before && a.conn.state === 'connected',
      10000,
      'neta reconnected',
    );
    await settle(acct, []);

    expect(aways(a)).toEqual(['AWAY :lunch']);
    expect(rows(acct, a, published).filter((t) => /marked as being away/.test(String(t)))).toEqual(
      [],
    );
  });

  it('sends a message with a line break in it as one line', async () => {
    const acct = await seedAccount();
    const [a] = acct.nets;
    ircManager.setAway(acct.userId, 'all', 'out\nPRIVMSG #elsewhere :injected');
    await settle(acct, []);

    expect(aways(a)).toEqual(['AWAY :out PRIVMSG #elsewhere :injected']);
    expect(fakeOf(a.nick).sent.filter((l) => commandOf(l) === 'PRIVMSG')).toEqual([]);
  });

  it('sends nothing for an away with nothing left to say once the line is made safe', async () => {
    const acct = await seedAccount();
    // A NUL survives the trim, and becomes a space the line then loses. A bare
    // AWAY in its place would clear the networks' away while they're away.
    ircManager.setAway(acct.userId, 'all', String.fromCharCode(0));
    await settle(acct, []);

    expect(acct.nets.map(isAway)).toEqual([true, true]);
    expect(acct.nets.map(aways)).toEqual([[], []]);
  });
});

describe('draft/pre-away', () => {
  it('is offered', async () => {
    const c = await harness.connect();
    cleanups.push(() => c.close());
    c.send('CAP LS 302');
    const ls = await c.waitFor((l) => l.includes('CAP') && l.includes('LS'));
    expect(ls.replace(/^.* :/, '').split(' ')).toContain('draft/pre-away');
  });

  it('takes goguma’s AWAY * before CAP END, and leaves the networks and auto-away alone', async () => {
    const acct = await seedAccount();
    ircManager.setAway(acct.userId, 'all', 'afk', { autoSet: true });

    // goguma's background sync, as it connects.
    const sync = await attach(acct, 'neta', {
      caps: 'sasl draft/pre-away',
      before: ['AWAY *'],
    });
    await settle(acct, [sync]);

    // Its 306 came before the welcome, and the burst didn't repeat it.
    const reply = sync.lines.findIndex((l) => commandOf(l) === '306');
    expect(reply).toBeGreaterThan(-1);
    expect(reply).toBeLessThan(sync.lines.findIndex((l) => commandOf(l) === '001'));
    expect(awayReplies(sync)).toHaveLength(1);
    // It isn't the user, so the auto-away it found stays, and no `*` goes out.
    for (const net of acct.nets) {
      expect(rowOf(net)).toMatchObject({ away_message: 'afk', back_datetime: null, auto_set: 1 });
    }
    expect(acct.nets.map(aways)).toEqual([['AWAY :afk'], ['AWAY :afk']]);

    // A client that is the user brings every network back.
    await attach(acct, 'netb');
    expect(acct.nets.map(isAway)).toEqual([false, false]);
  });

  it('takes AWAY * after registration from a client without the cap', async () => {
    const acct = await seedAccount();
    fastAutoAway(acct);
    const c = await attach(acct, 'neta');
    const mark = c.lines.length;

    // Its reply is what comes before the PONG written right behind it. Read
    // after a `settle` instead, the 50 ms auto-away below had sometimes come
    // already, with a 306 of its own (#1474).
    c.send('AWAY *');
    c.send('PING awaystar');
    const pong = await c.waitFor((l) => commandOf(l) === 'PONG' && l.endsWith(':awaystar'));
    const before = c.lines.slice(mark, c.lines.indexOf(pong));
    expect(before.filter((l) => ['305', '306'].includes(commandOf(l)))).toEqual([
      expect.stringMatching(/ 306 /),
    ]);
    await settle(acct, [c]);

    // Nothing counts as the user now, so auto-away comes, with its own message.
    await until(() => acct.nets.every(isAway), 2000, 'auto-away');
    const row = rowOf(acct.nets[0])!;
    expect(row.auto_set).toBe(1);
    expect(row.away_message).toMatch(/^afk since /);
    expect(acct.nets.flatMap(aways).filter((l) => l.endsWith('*'))).toEqual([]);
  });

  it('applies an AWAY sent before registration once the network is known', async () => {
    const acct = await seedAccount();
    const c = await attach(acct, 'neta', { before: ['AWAY :early'] });
    await settle(acct, [c]);
    // One 306: its reply. The burst doesn't repeat it.
    expect(awayReplies(c)).toHaveLength(1);
    expect(rowOf(acct.nets[0])).toMatchObject({
      away_message: 'early',
      back_datetime: null,
      auto_set: 0,
    });
    expect(acct.nets.map(aways)).toEqual([['AWAY :early'], []]);
  });
});

describe('auto-away', () => {
  it('is held off by an attached client, and starts when the last one goes', async () => {
    const acct = await seedAccount();
    fastAutoAway(acct);
    ircManager.setAway(acct.userId, 'all', 'afk', { autoSet: true });

    const c = await attach(acct, 'neta');
    expect(acct.nets.map(isAway)).toEqual([false, false]);

    c.close();
    await until(() => acct.nets.every(isAway), 2000, 'auto-away');
    expect(acct.nets.map((net) => rowOf(net)?.auto_set)).toEqual([1, 1]);
  });

  it('isn’t held off by a control connection or an AWAY * client', async () => {
    const acct = await seedAccount();
    fastAutoAway(acct);
    await attach(acct, null);
    await attach(acct, 'neta', { caps: 'sasl draft/pre-away', before: ['AWAY *'] });
    await until(() => acct.nets.every(isAway), 2000, 'auto-away');
    expect(acct.nets.map((net) => rowOf(net)?.auto_set)).toEqual([1, 1]);
  });

  it('doesn’t come for an account paused while its clients were attached', async () => {
    const acct = await seedAccount();
    fastAutoAway(acct);
    await attach(acct, 'neta');

    // Pausing the account drops its clients, and each one reports leaving.
    users.setUserPaused(acct.userId, true);
    ircManager.suspendUser(acct.userId);
    // Well past the delay.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(acct.nets.map(isAway)).toEqual([false, false]);
  });

  it('never replaces an away already set', async () => {
    const acct = await seedAccount();
    const [a] = acct.nets;
    ircManager.setAway(acct.userId, 'all', 'afk since earlier', { autoSet: true });
    expect(ircManager.setAway(acct.userId, 'all', 'afk since later', { autoSet: true })).toBe(0);
    expect(rowOf(a)?.away_message).toBe('afk since earlier');

    ircManager.setAway(acct.userId, a.networkId, 'lunch');
    expect(ircManager.setAway(acct.userId, 'all', 'afk', { autoSet: true })).toBe(0);
    expect(rowOf(a)).toMatchObject({ away_message: 'lunch', auto_set: 0 });
  });

  it('skips a network set away by hand, and auto-back leaves it away', async () => {
    const acct = await seedAccount();
    const [a, b] = acct.nets;
    ircManager.setAway(acct.userId, a.networkId, 'lunch');

    expect(ircManager.setAway(acct.userId, 'all', 'afk', { autoSet: true })).toBe(1);
    expect(rowOf(a)).toMatchObject({ away_message: 'lunch', auto_set: 0 });
    expect(rowOf(b)).toMatchObject({ away_message: 'afk', auto_set: 1 });

    expect(ircManager.clearAway(acct.userId, 'all', { autoSet: true })).toBe(1);
    expect(acct.nets.map(isAway)).toEqual([true, false]);
    expect(rowOf(a)?.away_message).toBe('lunch');
  });
});

describe('resolveAwayScope', () => {
  it('is the typed-on network unless -all, or the setting, says every network', async () => {
    const acct = await seedAccount();
    const { resolveAwayScope } = await import('./ircManager.js');
    const [a] = acct.nets;
    expect(resolveAwayScope(acct.userId, a.networkId)).toBe(a.networkId);
    expect(resolveAwayScope(acct.userId, a.networkId, true)).toBe('all');
    // An older app, or luir, names no network.
    expect(resolveAwayScope(acct.userId, null)).toBe('all');

    settings.setUserSetting(acct.userId, 'away.all_networks', true);
    expect(resolveAwayScope(acct.userId, a.networkId)).toBe('all');
    expect(resolveAwayScope(acct.userId, a.networkId, false)).toBe(a.networkId);
  });
});
