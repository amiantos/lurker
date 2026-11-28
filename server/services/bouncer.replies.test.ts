// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// A reply goes only to whoever asked for it (replyRouter.ts, #931): Lurker, the
// user, or one attached IRC client. Against a real IrcConnection on the fake
// ircd, with the real bouncer in front of it. See bouncerHarness.ts.

import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { setupTestDb } from '../test-utils/testApp.js';
import { FakeIrcd, rawClient } from '../test-utils/fakeIrcd.js';
import { until } from '../test-utils/until.js';

const ctx = setupTestDb('services-bouncer-replies');

let harnessMod: typeof import('../test-utils/bouncerHarness.js');
let bouncerMod: typeof import('./bouncer.js');
let ircManager: typeof import('./ircManager.js').default;
let users: typeof import('../db/users.js');
let networks: typeof import('../db/networks.js');
let chanlistDb: typeof import('../db/chanlist.js');
let hashPassword: typeof import('./password.js').hashPassword;
let harness: import('../test-utils/bouncerHarness.js').Harness;
let ircd: FakeIrcd;

type Client = Awaited<ReturnType<import('../test-utils/bouncerHarness.js').Harness['connect']>>;
type Conn = import('./ircConnection.js').IrcConnection;
type Event = Record<string, unknown>;

interface Live {
  userId: number;
  username: string;
  networkId: number;
  password: string;
  nick: string;
  conn: Conn;
  events: Event[];
}

beforeAll(async () => {
  process.env.LURKER_BOUNCER_ENABLED = 'true';
  harnessMod = await import('../test-utils/bouncerHarness.js');
  bouncerMod = await import('./bouncer.js');
  ircManager = (await import('./ircManager.js')).default;
  users = await import('../db/users.js');
  networks = await import('../db/networks.js');
  chanlistDb = await import('../db/chanlist.js');
  ({ hashPassword } = await import('./password.js'));
  ircd = await FakeIrcd.start({ whox: true, creationTime: true });
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
  ircd.hold = null;
  for (const cleanup of cleanups.splice(0)) cleanup();
});

let seq = 0;

// A user whose network is a real IrcConnection, registered on the fake ircd.
async function seedLive(): Promise<Live> {
  seq += 1;
  const nick = `lurk${seq}`;
  const password = 'hunter2hunter2';
  const user = users.createUser(`replies_${seq}`);
  users.setPasswordHash(user.id, hashPassword(password));
  const network = networks.createNetwork(user.id, {
    name: 'fake',
    host: '127.0.0.1',
    port: ircd.port,
    tls: false,
    nick,
    autoconnect: false,
  } as Parameters<typeof networks.createNetwork>[1])!;
  const events: Event[] = [];
  const listener = (event: Event) => {
    if (event.networkId === network.id) events.push(event);
  };
  ircManager.on('event', listener);
  const conn = ircManager.startNetwork(user.id, network.id)!;
  cleanups.push(() => {
    ircManager.off('event', listener);
    conn.dispose();
    ircManager.connectionsForUser(user.id).delete(network.id);
  });
  await until(() => conn.state === 'connected', 5000, 'connected');
  return {
    userId: user.id,
    username: user.username,
    networkId: network.id,
    password,
    nick,
    conn,
    events,
  };
}

// Someone else on the fake ircd, in `channel`.
async function peer(name: string, channel?: string): Promise<string> {
  const nick = `${name}${seq}`;
  const client = await rawClient(ircd.port, nick);
  cleanups.push(() => client.socket.destroy());
  if (channel) {
    client.send(`JOIN ${channel}`);
    await client.waitFor(new RegExp(` 366 ${nick} ${channel} `));
  }
  return nick;
}

const NUL = String.fromCharCode(0);

async function attach(live: Live): Promise<Client> {
  const c = await harness.connect();
  cleanups.push(() => c.close());
  c.send('CAP LS 302');
  await c.waitFor((l) => l.includes('CAP') && l.includes('LS'));
  c.send('NICK client');
  c.send('USER client 0 * :client');
  c.send('CAP REQ :sasl');
  await c.waitFor((l) => l.includes('ACK'));
  c.send('AUTHENTICATE PLAIN');
  await c.waitFor((l) => l === 'AUTHENTICATE +');
  const plain = Buffer.from(['', live.username, live.password].join(NUL)).toString('base64');
  c.send(`AUTHENTICATE ${plain}`);
  await c.waitForCommand('903');
  c.send('CAP END');
  await c.waitForCommand('422');
  return c;
}

const commandOf = (line: string) => harnessMod.commandOf(line);

// Wait until each client has everything the network sent Lurker before now:
// the fake ircd writes this NOTICE after every earlier line.
let sentinels = 0;
async function sentinel(live: Live, clients: Client[]): Promise<void> {
  const text = `sentinel${++sentinels}`;
  ircd.sendRaw(live.nick, `:fake.test NOTICE ${live.nick} :${text}`);
  for (const c of clients) await c.waitFor((l) => l.endsWith(`:${text}`));
  await until(() => live.events.some((e) => e.text === text), 5000, text);
}

// What Lurker sent the network, and what it wrote to the web app's server buffer.
const sentBy = (live: Live) => ircd.client(live.nick)?.sent ?? [];
const serverRows = (live: Live) =>
  live.events.filter((e) => e.type === 'motd').map((e) => String(e.text));

describe('replies go only to whoever asked', () => {
  it("answers a client's MODE and WHO once, with none of Lurker's own replies (#931)", async () => {
    const live = await seedLive();
    await peer('bob', '#room');
    const c = await attach(live);
    // rekkals' exchange: JOIN, then MODE and WHO as soon as the JOIN is back.
    c.send('JOIN #room');
    await c.waitFor((l) => commandOf(l) === 'JOIN' && l.includes('#room'));
    c.send('MODE #room');
    c.send('WHO #room');
    await c.waitFor((l) => commandOf(l) === '315');
    await sentinel(live, [c]);

    const lines = (command: string) => c.lines.filter((l) => commandOf(l) === command);
    expect(lines('324')).toHaveLength(1);
    expect(lines('329')).toHaveLength(1);
    expect(lines('354')).toEqual([]);
    expect(lines('315')).toHaveLength(1);
    expect(lines('352')).toHaveLength(2);
    // Lurker's own WHOX went out, and the client's MODE was answered from its reply.
    const sent = sentBy(live);
    expect(sent.some((l) => /^WHO #room %tcuhsnfdaor,\d+$/.test(l))).toBe(true);
    expect(sent.filter((l) => l === 'WHO #room')).toHaveLength(1);
    expect(sent.filter((l) => l === 'MODE #room')).toHaveLength(1);
    // Nor did any of it reach the web app's server buffer.
    expect(
      serverRows(live).filter((t) => t.includes('#room') || t.includes('End of /WHO')),
    ).toEqual([]);
  });

  it("parses Lurker's own WHOX as before", async () => {
    const live = await seedLive();
    const dave = await peer('dave', '#whox');
    live.conn.join('#whox');
    // Only the WHO reply carries dave's host: the fake's NAMES has bare nicks.
    await until(
      () => live.conn.channelState('#whox')?.members.get(dave)?.host === 'fake.host',
      5000,
      "dave's host from the WHOX",
    );
    await sentinel(live, []);
    expect(
      serverRows(live).filter((t) => t.includes('#whox') || t.includes('End of /WHO')),
    ).toEqual([]);
  });

  it("takes Lurker's WHOX token only as its WHO goes out", async () => {
    const live = await seedLive();
    await peer('dave', '#tok');
    live.conn.join('#tok');
    await until(() => sentBy(live).some((l) => l.startsWith('WHO #tok %')), 5000, "Lurker's WHO");
    await sentinel(live, []);
    // A client's WHOX carrying the token Lurker takes next, answered late.
    const next = (live.conn.client.whox_token as unknown as { value: number }).value + 1;
    ircd.hold = (cmd, params) => cmd === 'WHO' && params[0] === '#tok';
    const c = await attach(live);
    c.send(`WHO #tok %tcuhsnfdaor,${next}`);
    await until(
      () => sentBy(live).includes(`WHO #tok %tcuhsnfdaor,${next}`),
      5000,
      "the client's WHO",
    );
    // Lurker's own WHO for another channel waits behind it.
    const erin = await peer('erin', '#tok2');
    live.conn.join('#tok2');
    await until(() => live.conn.channelState('#tok2')?.members.has(erin) === true, 5000, '#tok2');
    await sentinel(live, [c]);
    ircd.sendRaw(
      live.nick,
      `:fake.test 354 ${live.nick} ${next} #tok ~u fake.host fake.test dave H 0 0 n/a :dave`,
    );
    ircd.sendRaw(live.nick, `:fake.test 315 ${live.nick} #tok :End of WHO list`);
    await c.waitFor((l) => commandOf(l) === '354');
    // Had Lurker taken the token when its WHO was queued, the client's reply would
    // have used it up, and irc-framework would have dropped Lurker's own.
    await until(
      () => live.conn.channelState('#tok2')?.members.get(erin)?.host === 'fake.host',
      5000,
      "erin's host from Lurker's WHOX",
    );
    // The client got its own reply, and none of Lurker's.
    expect(c.lines.filter((l) => commandOf(l) === '354')).toHaveLength(1);
  });

  it("keeps a client's WHOIS out of the web app, found or not", async () => {
    const live = await seedLive();
    const carol = await peer('carol');
    const c = await attach(live);
    // The user just messaged nobody, so a 401 of the user's own lands in that DM.
    live.conn.noteUserSend('nobody');
    c.send(`WHOIS ${carol}`);
    c.send('WHOIS nobody');
    await c.waitFor((l) => commandOf(l) === '318');
    await c.waitFor((l) => commandOf(l) === '401');
    await sentinel(live, [c]);
    expect(live.events.filter((e) => e.type === 'whois_result' || e.type === 'error')).toEqual([]);
    expect(serverRows(live).filter((t) => t.includes(carol) || t.includes('nobody'))).toEqual([]);

    // The user's own still reaches the profile modal.
    live.conn.raw(`WHOIS ${carol}`);
    await until(() => live.events.some((e) => e.type === 'whois_result'), 5000, 'whois_result');
  });

  it("keeps the 301 for a DM to someone away out of the server buffer, and a WHOIS's", async () => {
    const live = await seedLive();
    const nick = `dave${seq}`;
    const dave = await rawClient(ircd.port, nick);
    cleanups.push(() => dave.socket.destroy());
    const c = await attach(live);
    const away = () =>
      live.events.findLast((e) => e.type === 'peer-presence' && e.nick === nick)?.awayMessage;
    const rows = (text: string) => serverRows(live).filter((t) => t.includes(text));

    dave.send('AWAY :gone fishing');
    await dave.waitFor(/ 306 /);
    live.conn.say(nick, 'you there?');
    // A bouncer client still hears it: the line is the network's.
    await c.waitFor((l) => commandOf(l) === '301');
    await sentinel(live, [c]);
    expect(rows('gone fishing')).toEqual([]);
    // The DM is where it shows instead, reason and all.
    expect(away()).toBe('gone fishing');

    // Already away, and a different reason: the row is not the only place it was.
    dave.send('AWAY :at the dentist');
    dave.send('PING dentist');
    await dave.waitFor(/PONG .*dentist/);
    live.conn.say(nick, 'still there?');
    await until(() => away() === 'at the dentist', 5000, 'the new reason');
    await sentinel(live, [c]);
    expect(rows('at the dentist')).toEqual([]);

    live.conn.raw(`WHOIS ${nick}`);
    await until(() => live.events.some((e) => e.type === 'whois_result'), 5000, 'whois_result');
    await sentinel(live, [c]);
    // The user's WHOIS is the profile's: the reason rides the whois_result.
    expect(rows('at the dentist')).toEqual([]);
    expect(live.events.findLast((e) => e.type === 'whois_result')?.whois).toMatchObject({
      away: 'at the dentist',
    });
    expect(rows(nick)).toEqual([]);
  });

  it('keeps the 301 from someone with no DM, which has nowhere else to show', async () => {
    const live = await seedLive();
    const nick = `erin${seq}`;
    const erin = await rawClient(ircd.port, nick);
    cleanups.push(() => erin.socket.destroy());
    erin.send('AWAY :out to lunch');
    await erin.waitFor(/ 306 /);
    live.conn.raw(`PRIVMSG ${nick} :\u0001VERSION\u0001`);
    // The sentinel only follows what the network has already sent, and the 301
    // is sent when the PRIVMSG is read: without this wait the sentinel could be
    // written first, and under load the row was not there yet (#1474).
    await until(() => sentBy(live).some((l) => l.startsWith(`PRIVMSG ${nick} `)), 5000, 'the CTCP');
    await sentinel(live, []);
    expect(serverRows(live).filter((t) => t.includes('out to lunch'))).toHaveLength(1);
  });

  it('sends each client only its own WHOIS and LIST replies', async () => {
    const live = await seedLive();
    const carol = await peer('carol');
    const a = await attach(live);
    const b = await attach(live);
    a.send(`WHOIS ${carol}`);
    b.send('LIST');
    await a.waitFor((l) => commandOf(l) === '318');
    await b.waitFor((l) => commandOf(l) === '323');
    await sentinel(live, [a, b]);
    const has = (c: Client, commands: string[]) =>
      c.lines.filter((l) => commands.includes(commandOf(l)));
    expect(has(a, ['311', '318'])).toHaveLength(2);
    expect(has(b, ['311', '318'])).toEqual([]);
    expect(has(a, ['321', '322', '323'])).toEqual([]);
    expect(has(b, ['321', '323'])).toHaveLength(2);
  });

  it("keeps the user's own WHO and LIST in the web app, and away from clients", async () => {
    const live = await seedLive();
    const c = await attach(live);
    live.conn.raw('WHO #nobody');
    live.conn.raw('LIST');
    await until(
      () => serverRows(live).includes('End of /WHO list for #nobody.'),
      5000,
      "the user's WHO",
    );
    await until(() => chanlistDb.getMeta(live.networkId).fetchedAt != null, 5000, 'the LIST');
    await sentinel(live, [c]);
    expect(c.lines.filter((l) => ['315', '321', '323'].includes(commandOf(l)))).toEqual([]);
  });

  it("keeps a client's WHO, LIST and NAMES out of the web app", async () => {
    const live = await seedLive();
    await peer('erin', '#quiet');
    live.conn.join('#quiet');
    await until(() => sentBy(live).some((l) => l.startsWith('WHO #quiet')), 5000, "Lurker's WHO");
    const c = await attach(live);
    await sentinel(live, [c]);
    const whosBefore = sentBy(live).filter((l) => l.startsWith('WHO ')).length;

    c.send('WHO #quiet');
    c.send('LIST');
    c.send('NAMES #quiet');
    await c.waitFor((l) => commandOf(l) === '323');
    await c.waitFor(
      (l) => commandOf(l) === '366' && l.includes('#quiet') && c.lines.indexOf(l) > 0,
    );
    await sentinel(live, [c]);

    expect(
      serverRows(live).filter((t) => t.includes('#quiet') || t.includes('End of /WHO')),
    ).toEqual([]);
    expect(live.events.filter((e) => String(e.type).startsWith('chanlist-'))).toEqual([]);
    expect(chanlistDb.getMeta(live.networkId).fetchedAt).toBeNull();
    // Only the client's own WHO: its NAMES didn't send Lurker's away-sync again.
    expect(sentBy(live).filter((l) => l.startsWith('WHO ')).length).toBe(whosBefore + 1);
  });

  it('sends nothing of a reply nobody here asked for', async () => {
    const live = await seedLive();
    const c = await attach(live);
    ircd.sendRaw(live.nick, `:fake.test 352 ${live.nick} #gone ~u h fake.test phantom H :0 Ghost`);
    ircd.sendRaw(live.nick, `:fake.test 315 ${live.nick} #gone :End of WHO list`);
    await sentinel(live, [c]);
    expect(c.lines.filter((l) => ['352', '315'].includes(commandOf(l)))).toEqual([]);
    expect(serverRows(live).filter((t) => t.includes('phantom') || t.includes('#gone'))).toEqual(
      [],
    );
  });
});

describe('queries that can’t finish', () => {
  it('ends a client query the network never answers, then sends the next', async () => {
    process.env.LURKER_REPLY_TIMEOUT_MS = '300';
    try {
      const live = await seedLive();
      const a = await attach(live);
      const b = await attach(live);
      ircd.hold = (cmd, params) => cmd === 'WHO' && params[0] === '#phantom';
      a.send('WHO #phantom');
      await until(() => sentBy(live).includes('WHO #phantom'), 5000, 'WHO #phantom');
      b.send('WHO #real');
      await sentinel(live, [a, b]);
      // b's WHO waits behind a's: a WHO's replies name nothing to tell them apart by.
      expect(sentBy(live)).not.toContain('WHO #real');
      const aborted = await a.waitFor((l) => commandOf(l) === '315', 3000);
      expect(aborted).toMatch(/ 315 \S+ #phantom :Command aborted$/);
      const answered = await b.waitFor((l) => commandOf(l) === '315', 3000);
      expect(answered).toMatch(/ 315 \S+ #real :End of WHO list$/);
    } finally {
      delete process.env.LURKER_REPLY_TIMEOUT_MS;
    }
  });

  it('forgets the queries of a client that detached', async () => {
    process.env.LURKER_REPLY_TIMEOUT_MS = '300';
    try {
      const live = await seedLive();
      const a = await attach(live);
      const b = await attach(live);
      // The bouncer handles a client's lines in order, so its PONG comes after them.
      const handled = async (c: Client) => {
        const token = `handled${++sentinels}`;
        c.send(`PING ${token}`);
        await c.waitFor((l) => commandOf(l) === 'PONG' && l.endsWith(`:${token}`));
      };
      ircd.hold = (cmd, params) => cmd === 'WHO' && params[0] === '#stuck';
      a.send('WHO #stuck');
      await until(() => sentBy(live).includes('WHO #stuck'), 5000, 'WHO #stuck');
      a.send('WHO #mine');
      await handled(a);
      b.send('WHO #theirs');
      await handled(b);
      a.close();
      await until(
        () => bouncerMod.attachedSessionCount(live.userId, live.networkId) === 1,
        5000,
        'a detached',
      );
      await b.waitFor((l) => / 315 \S+ #theirs :End of WHO list$/.test(l), 3000);
      expect(sentBy(live)).not.toContain('WHO #mine');
    } finally {
      delete process.env.LURKER_REPLY_TIMEOUT_MS;
    }
  });

  it('ends every waiting client query when the network drops', async () => {
    const live = await seedLive();
    const a = await attach(live);
    ircd.hold = (cmd, params) => cmd === 'WHO' && params[0] === '#held';
    a.send('WHO #held');
    a.send('WHO #queued');
    await until(() => sentBy(live).includes('WHO #held'), 5000, 'WHO #held');
    ircd.drop(live.nick);
    const held = await a.waitFor((l) => / 315 \S+ #held :Command aborted$/.test(l));
    const queued = await a.waitFor((l) => / 315 \S+ #queued :Command aborted$/.test(l));
    expect(a.lines.indexOf(held)).toBeLessThan(a.lines.indexOf(queued));
    // The WHO still waiting never reached the network.
    expect(ircd.clients.some((client) => client.sent.includes('WHO #queued'))).toBe(false);
  });
});

describe("a client's MODE #chan", () => {
  it('is answered from the last reply until a mode it shows changes', async () => {
    const live = await seedLive();
    live.conn.join('#modes');
    await until(
      () => live.conn.channelState('#modes')?.modes.has('n') === true,
      5000,
      "Lurker's 324",
    );
    const c = await attach(live);
    await sentinel(live, [c]);

    c.send('MODE #modes');
    await c.waitFor((l) => commandOf(l) === '329');
    expect(c.lines.filter((l) => commandOf(l) === '324')).toHaveLength(1);
    expect(sentBy(live).filter((l) => l === 'MODE #modes')).toHaveLength(1);

    ircd.sendRaw(live.nick, `:op!~op@peer.fake MODE #modes +k sesame`);
    await sentinel(live, [c]);
    c.send('MODE #modes');
    await until(
      () => sentBy(live).filter((l) => l === 'MODE #modes').length === 2,
      5000,
      'a second MODE',
    );
    await until(() => c.lines.filter((l) => commandOf(l) === '324').length === 2, 5000, '324');
  });
});

describe('the attach burst', () => {
  type Account = import('../test-utils/bouncerHarness.js').HarnessAccount;

  async function attachAccount(acct: Account): Promise<Client> {
    return attach({
      userId: acct.user.id,
      username: acct.user.username,
      networkId: acct.network.id,
      password: acct.password,
      nick: acct.upstream.currentNick,
      conn: acct.upstream as unknown as Conn,
      events: [],
    });
  }

  function publishNames(acct: Account, target: string): void {
    ircManager.emit('event', {
      userId: acct.user.id,
      networkId: acct.network.id,
      type: 'names',
      target,
    });
  }

  async function flush(acct: Account, c: Client): Promise<void> {
    const text = `flush${++sentinels}`;
    acct.upstream.pushUpstream(`:irc.test NOTICE ${acct.upstream.currentNick} :${text}`);
    await c.waitFor((l) => l.endsWith(`:${text}`));
  }

  const namesFor = (c: Client, channel: string) =>
    c.lines.filter((l) => ['353', '366'].includes(commandOf(l)) && l.includes(` ${channel} `));

  it("holds back a channel's NAMES until the connection has heard them", async () => {
    const acct = harnessMod.seedAccount();
    acct.upstream.addChannel('#pending', { members: ['@op', 'bob'] });
    acct.upstream.pendingNames.add('#pending');
    const c = await attachAccount(acct);
    await flush(acct, c);
    expect(c.lines.some((l) => commandOf(l) === 'JOIN' && l.includes('#pending'))).toBe(true);
    expect(namesFor(c, '#pending')).toEqual([]);

    acct.upstream.pendingNames.delete('#pending');
    publishNames(acct, '#pending');
    await c.waitFor((l) => commandOf(l) === '366' && l.includes('#pending'));
    // Later publishes of the same list send nothing more.
    publishNames(acct, '#pending');
    await flush(acct, c);
    expect(namesFor(c, '#pending')).toHaveLength(2);
    expect(namesFor(c, '#pending')[0]).toContain('@op bob');
  });

  it("sends nothing more once the network's own NAMES reached the client", async () => {
    const acct = harnessMod.seedAccount();
    acct.upstream.addChannel('#joining', { members: ['bob'] });
    acct.upstream.pendingNames.add('#joining');
    const c = await attachAccount(acct);
    const nick = acct.upstream.currentNick;
    acct.upstream.pushUpstream(`:irc.test 353 ${nick} = #joining :${nick} bob`);
    acct.upstream.pushUpstream(`:irc.test 366 ${nick} #joining :End of /NAMES list.`);
    acct.upstream.pendingNames.delete('#joining');
    publishNames(acct, '#joining');
    await flush(acct, c);
    expect(namesFor(c, '#joining')).toHaveLength(2);
  });

  it("gives a replayed line only to a client it's news to", async () => {
    const acct = harnessMod.seedAccount();
    const up = acct.upstream;
    const nick = up.currentNick;
    up.addChannel('#known', { members: ['bob'] });
    // Its burst has #known.
    const burst = await attachAccount(acct);
    // Attached while the network was down (the engine link dropped), then saw a
    // live line.
    up.state = 'reconnecting';
    const early = await attachAccount(acct);
    await flush(acct, burst);
    await flush(acct, early);
    // A JOIN the network sent live reaches the two clients attached now, and
    // welcomes neither again.
    up.pushUpstream(`:${nick}!~u@fake.host JOIN #live`);
    await flush(acct, burst);
    await flush(acct, early);
    // Attached while the network was down, and has seen nothing since.
    const fresh = await attachAccount(acct);
    up.state = 'connected';
    const marks = [burst, early, fresh].map((c) => c.lines.length);
    up.restoring = true;
    up.pushUpstream(`:irc.test 375 ${nick} :- irc.test Message of the day -`);
    for (const channel of ['#known', '#live', '#new']) {
      up.pushUpstream(`:${nick}!~u@fake.host JOIN ${channel}`);
    }
    up.restoring = false;
    for (const c of [burst, early, fresh]) await flush(acct, c);

    const since = (c: Client, i: number) => c.lines.slice(marks[i]);
    const joins = (lines: string[]) =>
      lines.filter((l) => commandOf(l) === 'JOIN').map((l) => l.split(' ')[2]);
    const motd = (lines: string[]) => lines.filter((l) => commandOf(l) === '375');
    // Each gets a replayed JOIN only for a channel it hasn't been sent one for.
    expect(joins(since(burst, 0))).toEqual(['#new']);
    expect(joins(since(early, 1))).toEqual(['#known', '#new']);
    expect(joins(since(fresh, 2))).toEqual(['#known', '#live', '#new']);
    // The replayed MOTD only reaches the client that hasn't had a welcome.
    expect(motd(since(burst, 0))).toEqual([]);
    expect(motd(since(early, 1))).toEqual([]);
    expect(motd(since(fresh, 2))).toHaveLength(1);
  });
});

describe('a disposed connection', () => {
  it('relays nothing its socket still delivers, a reply to Lurker included (#936)', async () => {
    const live = await seedLive();
    const c = await attach(live);
    // The network answers Lurker's WHO only after our QUIT: a reply still on
    // its way when the connection was thrown away (a network edit, a reconnect).
    let whoHeld = false;
    ircd.hold = (cmd, p) => {
      if (cmd === 'WHO' && p[0] === '#late') return (whoHeld = true);
      if (cmd !== 'QUIT' || !whoHeld) return false;
      ircd.sendRaw(live.nick, `:fake.test 315 ${live.nick} #late :End of WHO list`);
      ircd.drop(live.nick);
      return true;
    };
    live.conn.join('#late');
    await until(() => whoHeld, 5000, "Lurker's WHO");
    await sentinel(live, [c]);
    live.conn.dispose();
    await until(() => live.conn.state === 'disconnected', 5000, 'socket closed');
    // The bouncer answers a PING itself, after anything it relayed before.
    c.send('PING :after');
    await c.waitFor((l) => l.endsWith(':after'));
    expect(c.lines.filter((l) => commandOf(l) === '315')).toEqual([]);
  });
});
