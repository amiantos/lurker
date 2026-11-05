// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Message redaction through the bouncer (#1013): the cap is offered while the
// network has it, a REDACT from the network reaches the clients that asked for
// it, a client's own REDACT goes up and its echo comes back applied, and a
// deleted line is left out of playback. A real IrcConnection to the fake ircd,
// as bouncer.replies.test.ts does, so every line takes the road it would.

import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { setupTestDb } from '../test-utils/testApp.js';
import { DEFAULT_CAPS, FakeIrcd } from '../test-utils/fakeIrcd.js';
import { until } from '../test-utils/until.js';

const ctx = setupTestDb('services-bouncer-redaction');

let harnessMod: typeof import('../test-utils/bouncerHarness.js');
let bouncerMod: typeof import('./bouncer.js');
let ircManager: typeof import('./ircManager.js').default;
let users: typeof import('../db/users.js');
let networks: typeof import('../db/networks.js');
let messagesDb: typeof import('../db/messages.js');
let hashPassword: typeof import('./password.js').hashPassword;
let harness: import('../test-utils/bouncerHarness.js').Harness;
let ircd: FakeIrcd;
// A network without the cap.
let plainIrcd: FakeIrcd;

type Client = Awaited<ReturnType<import('../test-utils/bouncerHarness.js').Harness['connect']>>;
type Conn = import('./ircConnection.js').IrcConnection;
type Event = Record<string, unknown>;

const REDACTION_CAP = 'draft/message-redaction';

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
  messagesDb = await import('../db/messages.js');
  ({ hashPassword } = await import('./password.js'));
  ircd = await FakeIrcd.start({ caps: [...DEFAULT_CAPS, REDACTION_CAP] });
  plainIrcd = await FakeIrcd.start();
  harness = await harnessMod.startHarness();
});

afterAll(async () => {
  harness.stop();
  await ircd.close();
  await plainIrcd.close();
  ctx.cleanup();
});

beforeEach(() => {
  bouncerMod.resetAuthThrottle();
});

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

let seq = 0;

async function seedLive(on: FakeIrcd = ircd): Promise<Live> {
  seq += 1;
  const nick = `lurk${seq}`;
  const password = 'hunter2hunter2';
  const user = users.createUser(`redact_${seq}`);
  users.setPasswordHash(user.id, hashPassword(password));
  const network = networks.createNetwork(user.id, {
    name: 'fake',
    host: '127.0.0.1',
    port: on.port,
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

const NUL = String.fromCharCode(0);

// Attach a client, requesting `caps` beside sasl before CAP END.
async function attach(live: Live, caps: string[] = [], name = 'client'): Promise<Client> {
  const c = await harness.connect();
  cleanups.push(() => c.close());
  c.send('CAP LS 302');
  await c.waitFor((l) => l.includes('CAP') && l.includes('LS'));
  c.send(`NICK ${name}`);
  c.send(`USER ${name} 0 * :${name}`);
  c.send('CAP REQ :sasl');
  await c.waitFor((l) => l.includes('ACK'));
  c.send('AUTHENTICATE PLAIN');
  await c.waitFor((l) => l === 'AUTHENTICATE +');
  const plain = Buffer.from(['', live.username, live.password].join(NUL)).toString('base64');
  c.send(`AUTHENTICATE ${plain}`);
  await c.waitForCommand('903');
  if (caps.length) {
    c.send(`CAP REQ :${caps.join(' ')}`);
    await c.waitFor((l) => l.includes('CAP') && (l.includes('ACK') || l.includes('NAK')));
  }
  c.send('CAP END');
  await c.waitForCommand('422');
  return c;
}

const commandOf = (line: string) => harnessMod.commandOf(line);

let sentinels = 0;
async function sentinel(live: Live, clients: Client[]): Promise<void> {
  const text = `sentinel${++sentinels}`;
  ircd.sendRaw(live.nick, `:fake.test NOTICE ${live.nick} :${text}`);
  for (const c of clients) await c.waitFor((l) => l.endsWith(`:${text}`));
  await until(() => live.events.some((e) => e.text === text), 5000, text);
}

const sentBy = (live: Live) => ircd.client(live.nick)?.sent ?? [];
const redactedEvents = (live: Live) => live.events.filter((e) => e.type === 'message-redacted');

async function joinedChannel(live: Live, c: Client, chan: string): Promise<void> {
  c.send(`JOIN ${chan}`);
  await c.waitFor((l) => commandOf(l) === 'JOIN' && l.includes(chan));
  await until(() => live.conn.isChannelJoined(chan), 5000, `upstream in ${chan}`);
}

async function peerSays(live: Live, from: string, chan: string, text: string): Promise<string> {
  const msgid = ircd.say(from, chan, text);
  await until(
    () =>
      messagesDb.listMessages(live.networkId, chan, { limit: 50 }).some((m) => m.msgid === msgid),
    5000,
    `stored "${text}"`,
  );
  return msgid;
}

describe('the cap', () => {
  it('is offered while the network has it, and acknowledged', async () => {
    const live = await seedLive();
    const c = await attach(live, [REDACTION_CAP]);
    const acks = c.lines.filter((l) => commandOf(l) === 'CAP' && l.includes('ACK'));
    expect(acks.some((l) => l.includes(REDACTION_CAP))).toBe(true);
    expect(c.lines.some((l) => commandOf(l) === 'CAP' && l.includes('NAK'))).toBe(false);
  });
});

describe('a REDACT from the network', () => {
  it('reaches the client that negotiated the cap, and not the one that did not', async () => {
    const live = await seedLive();
    const withCap = await attach(live, ['message-tags', REDACTION_CAP], 'withcap');
    const plain = await attach(live, [], 'plain');
    await joinedChannel(live, withCap, '#rd1');
    plain.send('JOIN #rd1');
    await plain.waitFor((l) => commandOf(l) === 'JOIN' && l.includes('#rd1'));

    const msgid = await peerSays(live, 'bob', '#rd1', 'wrong window');
    ircd.redact('bob', '#rd1', msgid, 'wrong window');
    const line = await withCap.waitFor((l) => commandOf(l) === 'REDACT');
    expect(line).toMatch(
      new RegExp(`^(@\\S+ )?:bob!~bob@peer.fake REDACT #rd1 ${msgid} :wrong window$`),
    );
    await sentinel(live, [withCap, plain]);
    expect(plain.lines.some((l) => commandOf(l) === 'REDACT')).toBe(false);
    // The web app saw it too.
    expect(redactedEvents(live)).toHaveLength(1);
    expect(redactedEvents(live)[0]).toMatchObject({ target: '#rd1', by: 'bob' });
  });
});

describe('a client’s REDACT', () => {
  it('goes up to the network, and its echo comes back to the client and the web app', async () => {
    const live = await seedLive();
    const c = await attach(live, ['message-tags', 'echo-message', REDACTION_CAP]);
    await joinedChannel(live, c, '#rd2');
    c.send('PRIVMSG #rd2 :typo');
    await until(
      () =>
        messagesDb
          .listMessages(live.networkId, '#rd2', { limit: 50 })
          .some((m) => m.self && m.text === 'typo' && !!m.msgid),
      5000,
      'own line stored with its msgid',
    );
    const own = messagesDb
      .listMessages(live.networkId, '#rd2', { limit: 50 })
      .find((m) => m.self && m.text === 'typo')!;

    c.send(`REDACT #rd2 ${own.msgid} :meant elsewhere`);
    const echo = await c.waitFor((l) => commandOf(l) === 'REDACT');
    expect(echo).toContain(`REDACT #rd2 ${own.msgid} :meant elsewhere`);
    expect(sentBy(live)).toContain(`REDACT #rd2 ${own.msgid} :meant elsewhere`);
    await until(() => redactedEvents(live).length === 1, 5000, 'applied');
    const row = messagesDb
      .listMessages(live.networkId, '#rd2', { limit: 50 })
      .find((m) => m.id === own.id)!;
    expect(row.text).toBeNull();
    expect(row.redaction).toMatchObject({ by: live.nick, reason: 'meant elsewhere' });
  });

  it('for a line it may not delete is refused by the network, and the FAIL comes back', async () => {
    const live = await seedLive();
    const c = await attach(live, ['message-tags', REDACTION_CAP]);
    await joinedChannel(live, c, '#rd3');
    const msgid = await peerSays(live, 'bob', '#rd3', 'not yours');
    c.send(`REDACT #rd3 ${msgid}`);
    const fail = await c.waitFor((l) => commandOf(l) === 'FAIL');
    expect(fail).toContain(`FAIL REDACT REDACT_FORBIDDEN #rd3 ${msgid}`);
    expect(
      messagesDb.listMessages(live.networkId, '#rd3', { limit: 50 }).find((m) => m.msgid === msgid)
        ?.text,
    ).toBe('not yours');
  });

  it('on a network without the cap is answered with a notice, and nothing goes up', async () => {
    const live = await seedLive(plainIrcd);
    // The client asks anyway (a 302 client sees the pass-through caps before
    // binding; the bind takes this one back), and the REDACT itself is refused.
    const c = await attach(live, ['message-tags']);
    await joinedChannel(live, c, '#rd6');
    c.send('REDACT #rd6 whatever');
    await c.waitFor((l) => commandOf(l) === 'NOTICE' && l.includes("doesn't support deleting"));
    expect(sentBy(live).some((l) => l.startsWith('REDACT'))).toBe(false);
  });

  it('for a line Lurker does not hold is answered with a notice, and nothing goes up', async () => {
    const live = await seedLive();
    const c = await attach(live, ['message-tags', REDACTION_CAP]);
    await joinedChannel(live, c, '#rd4');
    c.send('REDACT #rd4 never-seen');
    await c.waitFor((l) => commandOf(l) === 'NOTICE' && l.includes('Message not deleted'));
    expect(sentBy(live).some((l) => l.startsWith('REDACT'))).toBe(false);
  });
});

describe('playback', () => {
  it('leaves a deleted line out, and keeps the others', async () => {
    const live = await seedLive();
    const first = await attach(live, ['message-tags', REDACTION_CAP], 'first');
    await joinedChannel(live, first, '#rd5');
    await peerSays(live, 'bob', '#rd5', 'stays');
    const gone = await peerSays(live, 'bob', '#rd5', 'goes');
    ircd.redact('bob', '#rd5', gone);
    await until(() => redactedEvents(live).length === 1, 5000, 'deleted');
    first.close();

    const later = await attach(live, [], 'later');
    later.send('JOIN #rd5');
    await later.waitFor((l) => l.includes(':stays'));
    await sentinel(live, [later]);
    expect(later.lines.some((l) => l.endsWith(':goes'))).toBe(false);
  });
});
