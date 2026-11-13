// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// A client that didn't ask for echo-message must not get its own message back:
// it drew that line itself when the user pressed enter. The bouncer recognises
// the echo by what was sent, so a channel that STRIPS FORMATTING (UnrealIRCd
// +S, InspIRCd stripcolor) used to defeat it — the echo came back without the
// codes, the match missed, and the client drew the line a second time (#612).
// Against a real IrcConnection on the fake ircd, with the real bouncer in
// front. See bouncerHarness.ts.

import { describe, it, expect, vi, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { setupTestDb } from '../test-utils/testApp.js';
import { FakeIrcd } from '../test-utils/fakeIrcd.js';
import { until } from '../test-utils/until.js';

const ctx = setupTestDb('services-bouncer-echo');

let harnessMod: typeof import('../test-utils/bouncerHarness.js');
let bouncerMod: typeof import('./bouncer.js');
let ircManager: typeof import('./ircManager.js').default;
let users: typeof import('../db/users.js');
let networks: typeof import('../db/networks.js');
let hashPassword: typeof import('./password.js').hashPassword;
let harness: import('../test-utils/bouncerHarness.js').Harness;
// The network strips formatting from everything it relays, the sender's own
// echo included.
let ircd: FakeIrcd;

type Client = Awaited<ReturnType<import('../test-utils/bouncerHarness.js').Harness['connect']>>;

type Event = Record<string, unknown>;

interface Live {
  userId: number;
  username: string;
  networkId: number;
  password: string;
  events: Event[];
}

beforeAll(async () => {
  process.env.LURKER_BOUNCER_ENABLED = 'true';
  harnessMod = await import('../test-utils/bouncerHarness.js');
  bouncerMod = await import('./bouncer.js');
  ircManager = (await import('./ircManager.js')).default;
  users = await import('../db/users.js');
  networks = await import('../db/networks.js');
  ({ hashPassword } = await import('./password.js'));
  ircd = await FakeIrcd.start({ stripFormatting: true });
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

let seq = 0;

async function seedLive(): Promise<Live> {
  seq += 1;
  const password = 'hunter2hunter2';
  const user = users.createUser(`echo_${seq}`);
  users.setPasswordHash(user.id, hashPassword(password));
  const network = networks.createNetwork(user.id, {
    name: 'fake',
    host: '127.0.0.1',
    port: ircd.port,
    tls: false,
    nick: `lurk${seq}`,
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
  return { userId: user.id, username: user.username, networkId: network.id, password, events };
}

const NUL = String.fromCharCode(0);
const BASE_CAPS = 'sasl batch server-time message-tags';

// Attach with `caps` and join `channel`.
async function attachIn(live: Live, channel: string, caps = BASE_CAPS): Promise<Client> {
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
  c.send(`JOIN ${channel}`);
  await c.waitFor((l) => l.includes(' 366 ') && l.includes(` ${channel} `));
  return c;
}

let sentinels = 0;

// Wait until the network's copy of `text` has come back and been published,
// which is what the bouncer decides to relay or suppress. ⚠ Waiting on a
// sentinel from elsewhere instead would race: it takes a shorter path than the
// client's own message, so it can arrive first and the absence proves nothing.
async function published(live: Live, text: string): Promise<void> {
  await until(
    () => live.events.some((e) => e.type === 'message' && e.text === text && e.id != null),
    5000,
    `published: ${text}`,
  );
}

// Everything the client received after `mark`, once a line sent from elsewhere
// afterwards has arrived too.
async function linesAfter(c: Client, mark: number, channel: string): Promise<string[]> {
  const sentinel = `sentinel-${++sentinels}`;
  ircd.say('bob', channel, sentinel);
  await c.waitFor((l) => l.includes(`:${sentinel}`));
  return c.lines.slice(mark).filter((l) => !l.includes(sentinel));
}

function msgidOf(line: string): string | undefined {
  if (!line.startsWith('@')) return undefined;
  return line
    .slice(1, line.indexOf(' '))
    .split(';')
    .find((t) => t.startsWith('msgid='))
    ?.slice('msgid='.length);
}

const BOLD = String.fromCharCode(2);
const COLOR = String.fromCharCode(3);

describe('a client that did not ask for echo-message', () => {
  // #1149: the line waits its turn in the outbound queue, so its echo can come
  // back long after it was relayed. The 30 s the bouncer remembers it for run
  // from when it went out, or a late echo would read as someone else's.
  it('never gets its own message back, however long it waited to go out', async () => {
    const live = await seedLive();
    const c = await attachIn(live, '#room');
    // Hold the line as a backlog would: the manager's send is captured, not run.
    const send = vi.spyOn(ircManager, 'send').mockReturnValue(true);
    const mark = c.lines.length;
    c.send('PRIVMSG #room :late words');
    await until(() => send.mock.calls.length === 1, 5000, 'relayed to the manager');
    const hooks = send.mock.calls[0][4]?.lineHooks;
    send.mockRestore();
    expect(hooks?.sent).toBeDefined();
    // 31 s pass with it still waiting; then it goes, and its echo comes back.
    const realNow = Date.now;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 31_000);
    try {
      hooks!.sent!('late words');
      const conn = ircManager.getConnection(live.userId, live.networkId)!;
      conn.publish({
        type: 'message',
        target: '#room',
        nick: conn.currentNick,
        text: 'late words',
        kind: 'privmsg',
        self: true,
      });
      await published(live, 'late words');
      expect((await linesAfter(c, mark, '#room')).filter((l) => l.includes('late words'))).toEqual(
        [],
      );
    } finally {
      clock.mockRestore();
    }
  });

  // #1330: a line Lurker took back from the queue (a kick, a /flushq) is
  // answered as the server would have answered it; one that went with its
  // socket is not, as with ZNC and soju. Only the client that sent it is told.
  it('is told when its waiting message is taken back, and not when the socket goes', async () => {
    const live = await seedLive();
    const c = await attachIn(live, '#room');
    const other = await attachIn(live, '#room');
    const send = vi.spyOn(ircManager, 'send').mockReturnValue(true);
    const mark = c.lines.length;
    const otherMark = other.lines.length;
    c.send('PRIVMSG #room :taken back');
    c.send('PRIVMSG #room :lost with the socket');
    await until(() => send.mock.calls.length === 2, 5000, 'relayed to the manager');
    const taken = send.mock.calls[0][4]?.lineHooks;
    const lost = send.mock.calls[1][4]?.lineHooks;
    send.mockRestore();
    taken!.dropped!('taken back', 'no longer in the channel');
    lost!.dropped!('lost with the socket');
    expect((await linesAfter(c, mark, '#room')).filter((l) => l.includes(' 404 '))).toEqual([
      expect.stringMatching(/ 404 \S+ #room :Cannot send to channel \(no longer in the channel\)$/),
    ]);
    expect(
      (await linesAfter(other, otherMark, '#room')).filter((l) => l.includes(' 404 ')),
    ).toEqual([]);
  });

  it('never gets its own plain message back', async () => {
    const live = await seedLive();
    const c = await attachIn(live, '#room');

    const mark = c.lines.length;
    c.send('PRIVMSG #room :my own words');
    await published(live, 'my own words');
    expect((await linesAfter(c, mark, '#room')).filter((l) => l.includes('my own words'))).toEqual(
      [],
    );
  });

  // #612: the channel strips the codes, so the echo is not what was sent.
  it('never gets its own FORMATTED message back from a stripping channel', async () => {
    const live = await seedLive();
    const c = await attachIn(live, '#room');

    const mark = c.lines.length;
    c.send(`PRIVMSG #room :${BOLD}bold${BOLD} and ${COLOR}04red${COLOR} words`);
    // What the network relayed, and what it published: the codes are gone.
    await published(live, 'bold and red words');
    const after = await linesAfter(c, mark, '#room');
    expect(after.filter((l) => l.includes('bold') || l.includes('red'))).toEqual([]);
  });

  it('never gets its own formatted ACTION or NOTICE back either', async () => {
    const live = await seedLive();
    const c = await attachIn(live, '#room');
    const ctcp = String.fromCharCode(1);

    const mark = c.lines.length;
    c.send(`PRIVMSG #room :${ctcp}ACTION ${BOLD}waves${BOLD}${ctcp}`);
    c.send(`NOTICE #room :${COLOR}03noted${COLOR}`);
    await until(
      () => live.events.some((e) => e.type === 'notice' && e.text === 'noted' && e.id != null),
      5000,
      'the notice',
    );
    const after = await linesAfter(c, mark, '#room');
    expect(after.filter((l) => l.includes('waves') || l.includes('noted'))).toEqual([]);
  });

  // The suppression is for this session's own line, not for the text: someone
  // else saying the same thing still has to arrive.
  it('still gets a peer saying exactly what it just said', async () => {
    const live = await seedLive();
    const c = await attachIn(live, '#room');

    const mark = c.lines.length;
    c.send(`PRIVMSG #room :${BOLD}snap${BOLD}`);
    await published(live, 'snap');
    ircd.say('bob', '#room', 'snap');
    const after = await linesAfter(c, mark, '#room');
    expect(after.filter((l) => l.includes('snap'))).toHaveLength(1);
    expect(after.find((l) => l.includes('snap'))).toContain(':bob!');
  });

  // The consequence of a key that goes unconsumed: the next message with the
  // same words — from anywhere — is what consumes it, and this client doesn't
  // see that one. With the key byte-exact, the formatted send left its key
  // behind and the web app's plain copy is what it swallowed, so the client
  // showed its own line and missed the one it should have had.
  it('still gets the same words from the web app after saying them with formatting', async () => {
    const live = await seedLive();
    const c = await attachIn(live, '#room');

    const mark = c.lines.length;
    c.send(`PRIVMSG #room :${BOLD}deploy now${BOLD}`);
    await published(live, 'deploy now');
    ircManager.send(live.userId, live.networkId, '#room', 'deploy now');
    await until(
      () => live.events.filter((e) => e.type === 'message' && e.text === 'deploy now').length === 2,
      5000,
      'both copies',
    );
    const fromTheWeb = live.events.filter(
      (e) => e.type === 'message' && e.text === 'deploy now',
    )[1];

    const after = (await linesAfter(c, mark, '#room')).filter((l) => l.includes('deploy now'));
    expect(after).toHaveLength(1);
    // The web app's copy, not this client's own line come back.
    expect(msgidOf(after[0])).toBe(fromTheWeb.msgid);
  });
});

describe('a client that asked for echo-message', () => {
  // Not a #612 guard — a missed key delivers this client's line too, since it
  // asked for it. This is the double-delivery guard: the synthesised echo and
  // the network's reflected copy must not both arrive.
  it('gets its own formatted message back exactly once', async () => {
    const live = await seedLive();
    const c = await attachIn(live, '#room', `${BASE_CAPS} echo-message`);

    const mark = c.lines.length;
    c.send(`PRIVMSG #room :${BOLD}mine${BOLD}`);
    await published(live, 'mine');
    const after = await linesAfter(c, mark, '#room');
    const mine = after.filter((l) => l.includes('mine'));
    expect(mine).toHaveLength(1);
    expect(mine[0]).toContain(`PRIVMSG #room :`);
  });
});

// ⚠⚠ A `=nick` DCC chat buffer is not an IRC target, and the self-echo path was
// the last door through which one could still reach an attached client. If it
// does, the client opens a query window literally named `=bob`, and a reply
// typed there comes back through handleClientMessage and goes on the wire as
// `PRIVMSG =bob`. Playback, CHATHISTORY TARGETS and read markers already
// exclude these buffers; this is the same invariant.
describe('a DCC chat buffer is never echoed to an attached client', () => {
  it('relays a self-message for a DM but not for a =nick buffer', async () => {
    const live = await seedLive();
    const c = await attachIn(live, '#room', `${BASE_CAPS} echo-message`);
    const conn = ircManager.getConnection(live.userId, live.networkId)!;

    const mark = c.lines.length;
    // The DCC line goes first: if it were relayed at all, it would arrive
    // before the DM that follows it, so the DM's arrival proves the window was
    // open rather than merely that we didn't wait long enough.
    conn.publish({
      type: 'message',
      target: '=bob',
      nick: conn.currentNick,
      text: 'dcc-secret',
      self: true,
    });
    conn.publish({
      type: 'message',
      target: 'carol',
      nick: conn.currentNick,
      text: 'dm-visible',
      self: true,
    });

    await c.waitFor((l) => l.includes('dm-visible'));
    const after = c.lines.slice(mark);
    expect(after.filter((l) => l.includes('dm-visible'))).toHaveLength(1);
    expect(after.filter((l) => l.includes('dcc-secret'))).toEqual([]);
    expect(after.filter((l) => l.includes('=bob'))).toEqual([]);
  });
});
