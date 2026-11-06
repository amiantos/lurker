// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// A client splits a long message itself, to the 512-byte line, and draws each
// line it sent. The bouncer used to split those lines AGAIN at irc-framework's
// 350 bytes, so what reached the network — and the echoes that came back — had
// boundaries the client never sent, matched none of its lines, and showed up as
// a second copy of the message (#1041). A line that fits goes up as it is, the
// way soju and ZNC relay one. Against a real IrcConnection on the fake ircd,
// with and without upstream echo-message, the real bouncer in front. See
// bouncerHarness.ts.

import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { setupTestDb } from '../test-utils/testApp.js';

import { FakeIrcd, DEFAULT_CAPS } from '../test-utils/fakeIrcd.js';
import { until } from '../test-utils/until.js';
import { ircLineParser } from 'irc-framework';

const ctx = setupTestDb('services-bouncer-longlines');

let harnessMod: typeof import('../test-utils/bouncerHarness.js');
let bouncerMod: typeof import('./bouncer.js');
let ircManager: typeof import('./ircManager.js').default;
let users: typeof import('../db/users.js');
let networks: typeof import('../db/networks.js');
let hashPassword: typeof import('./password.js').hashPassword;
let harness: import('../test-utils/bouncerHarness.js').Harness;
// One network reflects our own lines (echo-message), one doesn't, so the self
// row comes from the echo on one and from our own send on the other.
let echoing: FakeIrcd;
let silent: FakeIrcd;
// One with draft/multiline (and no echo-message, whose echo of a batch the fake
// does not model), for a line too long for the wire.
let multiline: FakeIrcd;

type Client = Awaited<ReturnType<import('../test-utils/bouncerHarness.js').Harness['connect']>>;

interface Live {
  userId: number;
  username: string;
  networkId: number;
  nick: string;
  password: string;
}

beforeAll(async () => {
  process.env.LURKER_BOUNCER_ENABLED = 'true';
  harnessMod = await import('../test-utils/bouncerHarness.js');
  bouncerMod = await import('./bouncer.js');
  ircManager = (await import('./ircManager.js')).default;
  users = await import('../db/users.js');
  networks = await import('../db/networks.js');
  ({ hashPassword } = await import('./password.js'));
  echoing = await FakeIrcd.start();
  silent = await FakeIrcd.start({ caps: DEFAULT_CAPS.filter((c) => c !== 'echo-message') });
  multiline = await FakeIrcd.start({
    caps: [
      ...DEFAULT_CAPS.filter((c) => c !== 'echo-message'),
      'draft/multiline=max-bytes=4096,max-lines=24',
    ],
  });
  harness = await harnessMod.startHarness();
});

afterAll(async () => {
  harness.stop();
  await echoing.close();
  await silent.close();
  await multiline.close();
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

async function seedLive(ircd: FakeIrcd): Promise<Live> {
  seq += 1;
  const password = 'hunter2hunter2';
  const nick = `lurk${seq}`;
  const user = users.createUser(`long_${seq}`);
  users.setPasswordHash(user.id, hashPassword(password));
  const network = networks.createNetwork(user.id, {
    name: 'fake',
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
  return { userId: user.id, username: user.username, networkId: network.id, nick, password };
}

const NUL = String.fromCharCode(0);
const CTCP = String.fromCharCode(1);
const BASE_CAPS = 'sasl batch server-time message-tags';

// Attach with `caps` and join `channel` — or none, so no line of ours has yet
// shown the network's user@host for us.
async function attachIn(live: Live, channel: string | null, caps: string): Promise<Client> {
  const c = await harness.connect();
  cleanups.push(() => c.close());
  c.send('CAP LS 302');
  await c.waitFor((l) => l.includes('CAP') && l.includes('LS'));
  c.send('NICK client');
  c.send('USER client 0 * :client');
  c.send(`CAP REQ :${caps}`);
  await c.waitFor((l) => l.includes('ACK'));
  c.send('AUTHENTICATE PLAIN');
  await c.waitFor((l) => l === 'AUTHENTICATE +');
  const plain = Buffer.from(['', live.username, live.password].join(NUL)).toString('base64');
  c.send(`AUTHENTICATE ${plain}`);
  await c.waitForCommand('903');
  c.send('CAP END');
  await c.waitForCommand('422');
  if (channel) {
    c.send(`JOIN ${channel}`);
    await c.waitFor((l) => l.includes(' 366 ') && l.includes(` ${channel} `));
  }
  return c;
}

// `w001 w002 … wNNN`, the issue's own message.
function words(from: number, to: number): string {
  const out: string[] = [];
  for (let i = from; i <= to; i++) out.push(`w${String(i).padStart(3, '0')}`);
  return out.join(' ');
}

// The text of every PRIVMSG/NOTICE to `target` our connection put on the wire.
// Parsed, not matched: irc-framework drops the `:` on a one-word last param.
function upstreamTexts(ircd: FakeIrcd, live: Live, command: string, target: string): string[] {
  return ircd
    .client(live.nick)!
    .sent.map((l) => ircLineParser(l))
    .filter((m) => m?.command === command && m.params[0] === target)
    .map((m) => m!.params[1] ?? '');
}

// The text of every PRIVMSG/NOTICE to `target` the client got after `mark`,
// once a line sent from elsewhere afterwards has arrived too.
let sentinels = 0;
async function clientTexts(
  ircd: FakeIrcd,
  c: Client,
  mark: number,
  command: string,
  target: string,
): Promise<string[]> {
  const sentinel = `sentinel-${++sentinels}`;
  ircd.say('bob', target, sentinel);
  await c.waitFor((l) => l.includes(`:${sentinel}`));
  const marker = ` ${command} ${target} :`;
  return c.lines
    .slice(mark)
    .filter((l) => l.includes(marker) && !l.includes(sentinel))
    .map((l) => l.slice(l.indexOf(marker) + marker.length));
}

// What a client splitting at 512 bytes sends: the first line is well past 350.
const FIRST = words(1, 90);
const SECOND = words(91, 120);

// A client that doesn't split at all, on a network with draft/multiline: the
// line goes up as one batch of concat continuations, and ircManager publishes
// the ONE message the room sees — so that is what the echo is keyed by, and the
// client gets no second copy of its own line (#1041's regression class).
describe('a line too long for the wire, on a network with draft/multiline', () => {
  const LONG = words(1, 120);

  it('goes up as one batch and is not echoed back as a second copy', async () => {
    const live = await seedLive(multiline);
    const c = await attachIn(live, '#room', BASE_CAPS);

    const mark = c.lines.length;
    c.send(`PRIVMSG #room :${LONG}`);
    await until(
      () => upstreamTexts(multiline, live, 'PRIVMSG', '#room').length >= 2,
      5000,
      'the batch upstream',
    );
    // The pieces glue back to the line as sent, the space at the cut included.
    expect(upstreamTexts(multiline, live, 'PRIVMSG', '#room').join('')).toBe(LONG);
    expect(await clientTexts(multiline, c, mark, 'PRIVMSG', '#room')).toEqual([]);
  });

  it('comes back once, whole, to a client that asked for echo-message', async () => {
    const live = await seedLive(multiline);
    const c = await attachIn(live, '#room', `${BASE_CAPS} echo-message`);

    const mark = c.lines.length;
    c.send(`PRIVMSG #room :${LONG}`);
    await until(
      () => upstreamTexts(multiline, live, 'PRIVMSG', '#room').length >= 2,
      5000,
      'the batch upstream',
    );
    expect(await clientTexts(multiline, c, mark, 'PRIVMSG', '#room')).toEqual([LONG]);
  });
});

describe.each([
  ['an echoing network', () => echoing],
  ['a network without echo-message', () => silent],
])('a long message a client already split, on %s', (_name, ircdOf) => {
  it('goes upstream and comes back on the lines the client sent', async () => {
    const ircd = ircdOf();
    const live = await seedLive(ircd);
    const c = await attachIn(live, '#room', `${BASE_CAPS} echo-message`);
    expect(Buffer.byteLength(FIRST)).toBeGreaterThan(350);

    const mark = c.lines.length;
    c.send(`PRIVMSG #room :${FIRST}`);
    c.send(`PRIVMSG #room :${SECOND}`);
    await until(
      () => upstreamTexts(ircd, live, 'PRIVMSG', '#room').length >= 2,
      5000,
      'both lines upstream',
    );
    expect(await clientTexts(ircd, c, mark, 'PRIVMSG', '#room')).toEqual([FIRST, SECOND]);
    expect(upstreamTexts(ircd, live, 'PRIVMSG', '#room')).toEqual([FIRST, SECOND]);
  });

  it('is not echoed to a client that did not ask for echo-message', async () => {
    const ircd = ircdOf();
    const live = await seedLive(ircd);
    const c = await attachIn(live, '#room', BASE_CAPS);

    const mark = c.lines.length;
    c.send(`PRIVMSG #room :${FIRST}`);
    c.send(`PRIVMSG #room :${SECOND}`);
    await until(
      () => upstreamTexts(ircd, live, 'PRIVMSG', '#room').length >= 2,
      5000,
      'both lines upstream',
    );
    expect(await clientTexts(ircd, c, mark, 'PRIVMSG', '#room')).toEqual([]);
  });

  it('keeps a long /me and NOTICE whole too', async () => {
    const ircd = ircdOf();
    const live = await seedLive(ircd);
    const c = await attachIn(live, '#room', `${BASE_CAPS} echo-message`);

    const mark = c.lines.length;
    c.send(`PRIVMSG #room :${CTCP}ACTION ${FIRST}${CTCP}`);
    c.send(`NOTICE #room :${FIRST}`);
    await until(
      () =>
        upstreamTexts(ircd, live, 'PRIVMSG', '#room').length >= 1 &&
        upstreamTexts(ircd, live, 'NOTICE', '#room').length >= 1,
      5000,
      'both upstream',
    );
    expect(upstreamTexts(ircd, live, 'PRIVMSG', '#room')).toEqual([
      `${CTCP}ACTION ${FIRST}${CTCP}`,
    ]);
    expect(upstreamTexts(ircd, live, 'NOTICE', '#room')).toEqual([FIRST]);
    expect(await clientTexts(ircd, c, mark, 'PRIVMSG', '#room')).toEqual([
      `${CTCP}ACTION ${FIRST}${CTCP}`,
    ]);
    expect(await clientTexts(ircd, c, mark, 'NOTICE', '#room')).toEqual([FIRST]);
  });

  // A client that doesn't split at all: the line wouldn't fit once the network
  // puts our prefix in front, so it's split here rather than truncated there —
  // and the client gets back what was actually said.
  it('still splits a line too long for the wire', async () => {
    const ircd = ircdOf();
    const live = await seedLive(ircd);
    const c = await attachIn(live, '#room', `${BASE_CAPS} echo-message`);
    const all = words(1, 120);

    const mark = c.lines.length;
    c.send(`PRIVMSG #room :${all}`);
    await until(
      () => upstreamTexts(ircd, live, 'PRIVMSG', '#room').length >= 2,
      5000,
      'the split lines upstream',
    );
    const sent = upstreamTexts(ircd, live, 'PRIVMSG', '#room');
    expect(sent.length).toBeGreaterThan(1);
    expect(sent.join(' ')).toBe(all);
    expect(await clientTexts(ircd, c, mark, 'PRIVMSG', '#room')).toEqual(sent);
  });
});

// The budget is the line as the network relays it, our REAL prefix in front —
// learned from our own JOIN, not guessed — so a client that filled its line to
// the byte against that prefix still goes up whole.
describe('the line budget', () => {
  it('is our real prefix, learned from our own JOIN', async () => {
    const live = await seedLive(echoing);
    const c = await attachIn(live, '#room', `${BASE_CAPS} echo-message`);
    const ident = echoing.client(live.nick)!.user;
    const head = `:${live.nick}!~${ident}@fake.host PRIVMSG #room :`;
    const room = 512 - 2 - Buffer.byteLength(head);
    const exact = 'x'.repeat(room);
    const over = 'y'.repeat(room + 1);

    const mark = c.lines.length;
    c.send(`PRIVMSG #room :${exact}`);
    c.send(`PRIVMSG #room :${over}`);
    await until(
      () => upstreamTexts(echoing, live, 'PRIVMSG', '#room').length >= 3,
      5000,
      'the lines upstream',
    );
    const sent = upstreamTexts(echoing, live, 'PRIVMSG', '#room');
    expect(sent[0]).toBe(exact);
    expect(sent.slice(1).join('')).toBe(over);
    expect(sent.length).toBe(3);
    expect(await clientTexts(echoing, c, mark, 'PRIVMSG', '#room')).toEqual(sent);
  });

  // Nothing of ours has crossed the network yet, so we can't know what it puts
  // in front: assume the longest, rather than send a line it would truncate.
  it('assumes the longest prefix before it has seen ours', async () => {
    const live = await seedLive(echoing);
    const c = await attachIn(live, null, `${BASE_CAPS} echo-message`);
    // Fits behind `nick!~ident@fake.host`, not behind a 63-byte host.
    const text = 'z'.repeat(440);

    c.send(`PRIVMSG bob :${text}`);
    await until(
      () => upstreamTexts(echoing, live, 'PRIVMSG', 'bob').length >= 2,
      5000,
      'the split lines upstream',
    );
    expect(upstreamTexts(echoing, live, 'PRIVMSG', 'bob').join('')).toBe(text);
  });

  // "The longest" is the network's HOSTLEN where it says one: the same line
  // goes whole behind a 63-byte host and splits behind a 200-byte one.
  it("takes the longest host from the network's HOSTLEN", async () => {
    const roomy = await FakeIrcd.start({ isupport: ['HOSTLEN=200'] });
    cleanups.push(() => void roomy.close());
    const text = 'h'.repeat(400);
    for (const [ircd, lines] of [
      [echoing, 1],
      [roomy, 2],
    ] as const) {
      const live = await seedLive(ircd);
      const c = await attachIn(live, null, `${BASE_CAPS} echo-message`);
      c.send(`PRIVMSG bob :${text}`);
      await until(
        () => upstreamTexts(ircd, live, 'PRIVMSG', 'bob').length >= lines,
        5000,
        'the line upstream',
      );
      const sent = upstreamTexts(ircd, live, 'PRIVMSG', 'bob');
      expect(sent.join('')).toBe(text);
      expect(sent).toHaveLength(lines);
    }
  });

  // A bare `HOSTLEN` token says no length: it's the 63 default, not a 1-byte host
  // (irc-framework stores a valueless token as `true`). 460 bytes fits behind a
  // 1-byte host and not behind a 63-byte one.
  it('reads a bare HOSTLEN token as the default', async () => {
    const bare = await FakeIrcd.start({ isupport: ['HOSTLEN'] });
    cleanups.push(() => void bare.close());
    const live = await seedLive(bare);
    const c = await attachIn(live, null, `${BASE_CAPS} echo-message`);
    const text = 'b'.repeat(460);

    c.send(`PRIVMSG bob :${text}`);
    await until(
      () => upstreamTexts(bare, live, 'PRIVMSG', 'bob').length >= 2,
      5000,
      'the split lines upstream',
    );
    expect(upstreamTexts(bare, live, 'PRIVMSG', 'bob').join('')).toBe(text);
  });

  // HOSTLEN is the network's to say. One that no string could be built to must
  // still leave the message sent — and split as behind the longest real host,
  // not shredded into a flood of tiny lines — and the bouncer up.
  it('survives an absurd HOSTLEN', async () => {
    const absurd = await FakeIrcd.start({ isupport: ['HOSTLEN=1000000000'] });
    cleanups.push(() => void absurd.close());
    const live = await seedLive(absurd);
    const c = await attachIn(live, null, `${BASE_CAPS} echo-message`);
    const text = 'a'.repeat(400);

    c.send(`PRIVMSG bob :${text}`);
    await until(
      () => upstreamTexts(absurd, live, 'PRIVMSG', 'bob').join('') === text,
      5000,
      'the whole message upstream',
    );
    // Believed only up to MAX_HOSTLEN (255): two lines, not a 64-byte flood.
    expect(upstreamTexts(absurd, live, 'PRIVMSG', 'bob')).toHaveLength(2);
  });
});

// A line that would put nothing on the wire must not just vanish: the client is
// waiting on its echo, or an error.
describe('a line with no text to split', () => {
  it('sends a line of only spaces as written', async () => {
    const live = await seedLive(echoing);
    const c = await attachIn(live, '#room', `${BASE_CAPS} echo-message`);
    const mark = c.lines.length;
    c.send('PRIVMSG #room :   ');
    await until(
      () => upstreamTexts(echoing, live, 'PRIVMSG', '#room').includes('   '),
      5000,
      'the spaces upstream',
    );
    expect(await clientTexts(echoing, c, mark, 'PRIVMSG', '#room')).toEqual(['   ']);
  });

  it('answers an empty /me with 412', async () => {
    const live = await seedLive(echoing);
    const c = await attachIn(live, '#room', `${BASE_CAPS} echo-message`);
    c.send(`PRIVMSG #room :${CTCP}ACTION${CTCP}`);
    expect(await c.waitForCommand('412')).toContain('No text to send');
  });
});
