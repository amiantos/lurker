// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// An engine re-attach, as a client attached through the bouncer sees it. When
// the link between the app and the engine drops but the IRC socket survives, the
// app re-attaches and the engine replays the session into it: the registration
// burst, LUSERS, MOTD and a JOIN for every channel. A client that stayed
// attached has all of that already, and irssi rebuilds any channel it gets a
// second self-JOIN for. What the network said during the gap is news, though.

// MUST be first: redirects DATABASE_PATH before anything opens the db.
import '../test-utils/isolateDb.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createUser, setPasswordHash } from '../db/users.js';
import { createNetwork } from '../db/networks.js';
import type { Network } from '../db/networks.js';
import ircManager from './ircManager.js';
import { hashPassword } from './password.js';
import { EngineLink, engineConnectionId } from './engineLink.js';
import { rawClient } from '../test-utils/fakeIrcd.js';
import type { FakeIrcd } from '../test-utils/fakeIrcd.js';
import { startEngineHarness } from '../test-utils/engineHarness.js';
import type { EngineHarness } from '../test-utils/engineHarness.js';

const NICK = 'stayer';
const PASSWORD = 'hunter2hunter2';
const NUL = String.fromCharCode(0);

let harness: EngineHarness;
let ircd: FakeIrcd;
let network: Network;
let userId: number;
let username: string;
let bouncerHarness: typeof import('../test-utils/bouncerHarness.js');
let bouncer: typeof import('./bouncer.js');
let listener: import('../test-utils/bouncerHarness.js').Harness;
const sockets: Array<{ destroy(): void }> = [];

beforeAll(async () => {
  harness = await startEngineHarness({
    secret: 'bouncer-reattach-secret',
    // The link comes back after 2.5 s rather than 0.1 s, so what the network
    // says in between is the engine's backlog, not live traffic, and a client
    // has time to attach while the link is down.
    env: { LURKER_ENGINE_RETRY_BASE_MS: '2500' },
  });
  ircd = harness.ircd;
  process.env.LURKER_BOUNCER_ENABLED = 'true';
  bouncerHarness = await import('../test-utils/bouncerHarness.js');
  bouncer = await import('./bouncer.js');
  listener = await bouncerHarness.startHarness();
  const user = createUser('bouncer-reattach');
  userId = user.id;
  username = user.username;
  setPasswordHash(user.id, hashPassword(PASSWORD));
  network = createNetwork(user.id, {
    name: 'reattach',
    host: '127.0.0.1',
    port: ircd.port,
    tls: 0,
    nick: NICK,
    autoconnect: 0,
  })!;
});

afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  listener.stop();
  await harness.stop();
  delete process.env.LURKER_BOUNCER_ENABLED;
});

describe('an engine re-attach', () => {
  it('keeps the replay from a client that stayed, and gives it to one that attached', async () => {
    const until = harness.until;
    const commandOf = bouncerHarness.commandOf;
    const bob = await rawClient(ircd.port, 'bob');
    sockets.push(bob.socket);
    bob.send('JOIN #one');
    await bob.waitFor(/ 366 bob #one /);

    const conn = ircManager.startNetwork(userId, network.id)!;
    harness.tap(conn, NICK);
    await until(() => conn.state === 'connected', 5000, 'connected');
    conn.join('#one');
    conn.join('#two');
    await until(
      () => !conn.membersPending('#one') && !conn.membersPending('#two'),
      5000,
      'names heard',
    );

    const attach = async () => {
      const client = await listener.connect();
      client.send('CAP LS 302');
      await client.waitFor((l) => l.includes('CAP') && l.includes('LS'));
      client.send('NICK client');
      client.send('USER client 0 * :client');
      client.send('CAP REQ :sasl');
      await client.waitFor((l) => l.includes('ACK'));
      client.send('AUTHENTICATE PLAIN');
      await client.waitFor((l) => l === 'AUTHENTICATE +');
      client.send(
        `AUTHENTICATE ${Buffer.from(['', username, PASSWORD].join(NUL)).toString('base64')}`,
      );
      await client.waitForCommand('903');
      client.send('CAP END');
      await client.waitForCommand('422');
      return client;
    };
    type Client = Awaited<ReturnType<typeof attach>>;

    // Everything the network sent before now has reached the clients.
    let sentinels = 0;
    const sentinel = async (clients: Client[]) => {
      const text = `sentinel${++sentinels}`;
      ircd.sendRaw(NICK, `:fake.test NOTICE ${NICK} :${text}`);
      for (const client of clients) await client.waitFor((l) => l.endsWith(`:${text}`), 5000);
    };
    const stayed = await attach();
    await sentinel([stayed]);
    const mark = stayed.lines.length;
    const registrations = ircd.registrations.length;

    EngineLink.shared().simulateLoss();
    await until(() => conn.state !== 'connected', 5000, 'the link loss');
    // Said while the app is away, so it reaches the clients from the backlog.
    const engineId = engineConnectionId(userId, network.id);
    const buffered = () => harness.engine.info(engineId)?.bufferedLines ?? 0;
    const bufferedBefore = buffered();
    ircd.say('bob', '#one', 'while away');
    await until(() => buffered() > bufferedBefore, 5000, 'the engine buffered the gap');
    // This one attaches while there's no network to tell it about.
    const attachedMeanwhile = await attach();
    expect(conn.state).not.toBe('connected');
    await until(() => conn.state === 'connected' && !conn.catchingUp, 10000, 'live again');
    await until(
      () => !conn.membersPending('#one') && !conn.membersPending('#two'),
      10000,
      "the restore's NAMES",
    );
    await sentinel([stayed, attachedMeanwhile]);

    // A re-attach, not a reconnect, and both clients are still there.
    expect(ircd.registrations).toHaveLength(registrations);
    expect(bouncer.attachedSessionCount(userId, network.id)).toBe(2);
    const whileAway = (lines: string[]) =>
      lines.filter((l) => l.endsWith('PRIVMSG #one :while away'));
    const channelsIn = (lines: string[], command: string) =>
      lines
        .filter((l) => commandOf(l) === command)
        .map((l) => l.split(' ').find((word) => word.startsWith('#')))
        .toSorted();

    // The client that stayed gets what the network said in the gap, once, and
    // nothing the replay carried.
    const after = stayed.lines.slice(mark);
    expect(whileAway(after)).toHaveLength(1);
    const replayed = ['251', '375', '372', '376', 'JOIN', 'NICK', '353', '366'];
    expect(after.filter((l) => replayed.includes(commandOf(l)))).toEqual([]);

    // The one that attached meanwhile learns its channels from the replay, and
    // their members once the restore has them.
    const lines = attachedMeanwhile.lines;
    expect(channelsIn(lines, 'JOIN')).toEqual(['#one', '#two']);
    expect(channelsIn(lines, '366')).toEqual(['#one', '#two']);
    expect(
      lines.some((l) => commandOf(l) === '353' && l.includes('#one') && l.includes('bob')),
    ).toBe(true);
    expect(whileAway(lines)).toHaveLength(1);

    // A link lost while a batch is open (#1286): the engine keeps the batch's
    // lines for the app, whose irc-framework had not run them, and delivers
    // them again. The clients were relayed them the first time.
    await until(() => buffered() === 0, 5000, 'everything acked');
    const before = stayed.lines.length;
    const bobFull = ':bob!~bob@bob.fake';
    ircd.sendRaw(NICK, `${bobFull} BATCH +ml draft/multiline #one`);
    ircd.sendRaw(NICK, `@batch=ml ${bobFull} PRIVMSG #one :batched one`);
    await stayed.waitFor((l) => l.endsWith(':batched one'), 5000);
    await until(() => buffered() === 2, 5000, 'the engine kept the open batch');
    EngineLink.shared().simulateLoss();
    await until(() => conn.state !== 'connected', 5000, 'the second link loss');
    ircd.sendRaw(NICK, `@batch=ml ${bobFull} PRIVMSG #one :batched two`);
    ircd.sendRaw(NICK, `${bobFull} BATCH -ml`);
    await until(() => conn.state === 'connected' && !conn.catchingUp, 10000, 'live once more');
    await stayed.waitFor((l) => l.endsWith(':batched two'), 5000);
    await sentinel([stayed]);
    const since = stayed.lines.slice(before);
    expect(since.filter((l) => l.endsWith(':batched one'))).toHaveLength(1);
    expect(since.filter((l) => l.endsWith(':batched two'))).toHaveLength(1);
  }, 60000);
});
