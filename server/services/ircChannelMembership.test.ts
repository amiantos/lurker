// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Channel membership is the current socket's and nothing else's (#908). Two
// ways it used to outlive the truth, both against a real IrcConnection and the
// fake ircd:
//   - the joined set survived the socket dying, so a channel whose rejoin the
//     server refused (DALnet's 477 before NickServ identifies us, #873) read as
//     joined forever, and the 477 itself was taken for a speak rejection;
//   - a NAMES or TOPIC reply for a channel we are not in created the entry,
//     with a nicklist that did not have us in it.
// The engine's side of the first (a link blip keeps the set, a dead IRC socket
// does not) is in engineChannelMembership.test.ts.

// MUST be first: redirects DATABASE_PATH before anything opens the db.
import '../test-utils/isolateDb.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createUser } from '../db/users.js';
import { createNetwork } from '../db/networks.js';
import type { Network } from '../db/networks.js';
import { isAutojoin } from '../db/buffers.js';
import { FakeIrcd, rawClient } from '../test-utils/fakeIrcd.js';
import { until } from '../test-utils/until.js';

type Ev = Record<string, unknown>;

let IrcConnection: typeof import('./ircConnection.js').IrcConnection;
let ircManager: typeof import('./ircManager.js').default;
let ircd: FakeIrcd;
let userId: number;
let seq = 0;

beforeAll(async () => {
  // Read once at module load, so set before the import: a dropped socket
  // reconnects in tens of ms instead of the production 2–5 s.
  process.env.LURKER_RECONNECT_BASE_MS = '50';
  process.env.LURKER_RECONNECT_JITTER_MS = '1';
  ({ IrcConnection } = await import('./ircConnection.js'));
  ircManager = (await import('./ircManager.js')).default;
  ircd = await FakeIrcd.start({});
  userId = createUser('channel-membership').id;
});

afterAll(async () => {
  await ircd.close();
  delete process.env.LURKER_RECONNECT_BASE_MS;
  delete process.env.LURKER_RECONNECT_JITTER_MS;
});

function makeNetwork(nick: string): Network {
  return createNetwork(userId, {
    name: `membership-${seq++}`,
    host: '127.0.0.1',
    port: ircd.port,
    tls: false,
    nick,
    autoconnect: false,
  })!;
}

// No ircManager, so no rejoin pass: a re-registered socket joins nothing, which
// is exactly the state a refused rejoin leaves.
function connectDirect(nick: string) {
  const network = makeNetwork(nick);
  const events: Ev[] = [];
  const conn = new IrcConnection({ network, onEvent: (e) => events.push(e as Ev) });
  conn.connect();
  return { conn, events, network };
}

const isParted = (target: string) => (e: Ev) => e.type === 'channel-parted' && e.target === target;

describe('a dead socket takes its channels with it', () => {
  it('announces the part, stays parted when no rejoin lands, and keeps autojoin', async () => {
    const { conn, events, network } = connectDirect('memberone');
    try {
      await until(() => conn.state === 'connected', 5000, 'connected');
      conn.join('#locked');
      await until(() => conn.isChannelJoined('#locked'), 5000, 'joined #locked');

      const mark = events.length;
      const registrations = ircd.registrations.length;
      ircd.drop('memberone', false);
      await until(() => events.slice(mark).some(isParted('#locked')), 5000, 'channel-parted');
      expect(conn.isChannelJoined('#locked')).toBe(false);
      expect(conn.channelState('#locked')).toBeUndefined();
      // The row is what the reconnect's rejoin reads; losing the socket is not
      // the user leaving.
      expect(isAutojoin(userId, network.id, '#locked')).toBe(true);

      await until(
        () => ircd.registrations.length > registrations && conn.state === 'connected',
        20000,
        're-registered on a new socket',
      );
      expect(conn.isChannelJoined('#locked')).toBe(false);

      // The DALnet shape: the rejoin refused because services haven't
      // identified us yet. With the channel no longer (wrongly) joined, this
      // reads as the failed join it is, not as a message that didn't send.
      const nick = ircd.registrations.at(-1)!.nick;
      ircd.sendRaw(nick, `:fake.server 477 ${nick} #locked :You need a registered nick`);
      await until(
        () => events.some((e) => e.type === 'join-error' && e.target === '#locked'),
        5000,
        'join-error for the refused rejoin',
      );
      expect(conn.isChannelJoined('#locked')).toBe(false);
    } finally {
      conn.dispose();
    }
  }, 30000);

  it('the reconnect rejoin lights the channel again, with us in its nicklist', async () => {
    const network = makeNetwork('membertwo');
    const events: Ev[] = [];
    const onEvent = (e: Ev) => {
      if (e.networkId === network.id) events.push(e);
    };
    ircManager.on('event', onEvent);
    try {
      const conn = ircManager.startNetwork(userId, network.id)!;
      await until(() => conn.state === 'connected', 5000, 'connected');
      ircManager.joinChannel(userId, network.id, '#back');
      await until(() => conn.isChannelJoined('#back'), 5000, 'joined #back');

      const mark = events.length;
      const registrations = ircd.registrations.length;
      ircd.drop('membertwo', false);
      await until(
        () => ircd.registrations.length > registrations && conn.isChannelJoined('#back'),
        20000,
        'rejoined #back after the reconnect',
      );
      const nick = ircd.registrations.at(-1)!.nick.toLowerCase();
      await until(
        () => conn.channelState('#back')?.members.has(nick) === true,
        5000,
        'our nick in the fresh nicklist',
      );
      expect(
        events
          .slice(mark)
          .filter((e) => e.target === '#back')
          .map((e) => e.type)
          .filter((t) => t === 'channel-parted' || t === 'channel-joined'),
      ).toEqual(['channel-parted', 'channel-joined']);
    } finally {
      ircManager.off('event', onEvent);
      ircManager.disposeNetwork(userId, network.id);
    }
  }, 30000);
});

describe('a reply that names a channel is not membership', () => {
  it('NAMES and TOPIC for a channel we are not in show in the server buffer and join nothing', async () => {
    const { conn, events } = connectDirect('memberthree');
    const bystander = await rawClient(ircd.port, 'bystander');
    try {
      await until(() => conn.state === 'connected', 5000, 'connected');
      await bystander.waitFor(/ 001 /);
      bystander.send('JOIN #other');
      await bystander.waitFor(/ 366 /);
      ircd.topics.set('#third', 'a topic for the curious');

      const mark = events.length;
      conn.raw('NAMES #other');
      conn.raw('TOPIC #third');
      // Replies arrive in order on one socket, so the TOPIC reply's row means
      // the NAMES reply has been handled too.
      const serverRows = () =>
        events
          .slice(mark)
          .filter((e) => e.type === 'motd')
          .map((e) => String(e.text));
      await until(
        () => serverRows().some((t) => t.includes('a topic for the curious')),
        5000,
        'the TOPIC reply in the server buffer',
      );
      expect(serverRows().some((t) => t.includes('#other') && t.includes('bystander'))).toBe(true);
      expect(conn.isChannelJoined('#other')).toBe(false);
      expect(conn.isChannelJoined('#third')).toBe(false);
      // Each of these makes a client materialize a buffer for the channel.
      expect(
        events
          .slice(mark)
          .filter((e) => ['names', 'channel-topic', 'channel-joined'].includes(e.type as string)),
      ).toEqual([]);

      // Control: our own join's NAMES still becomes the nicklist, and stays out
      // of the server buffer.
      const joinMark = events.length;
      conn.join('#mine');
      await until(
        () => events.slice(joinMark).some((e) => e.type === 'names' && e.target === '#mine'),
        5000,
        'names for #mine',
      );
      expect(conn.channelState('#mine')?.members.has('memberthree')).toBe(true);
      expect(
        events
          .slice(joinMark)
          .filter((e) => e.type === 'motd' && /memberthree|NAMES/i.test(String(e.text))),
      ).toEqual([]);
    } finally {
      bystander.socket.destroy();
      conn.dispose();
    }
  }, 30000);
});
