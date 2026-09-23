// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// A message the network sends twice is stored once (IrcConnection.publish →
// alreadyPersisted). A self-hosted ircd did this in production: one PRIVMSG
// reached one connection twice, with the same msgid and server-time. Driven
// through the inbound `message` event with the real publish, against the
// isolated database.

// MUST be first: redirects DATABASE_PATH before the imports below open the db.
import '../test-utils/isolateDb.js';
import { beforeAll, describe, expect, it } from 'vitest';
import db from '../db/index.js';
import { IrcConnection } from './ircConnection.js';
import { createUser } from '../db/users.js';
import { createNetwork } from '../db/networks.js';
import type { Network } from '../db/networks.js';
import { ensureOpen as ensureBufferOpen, close as closeBufferRow } from '../db/buffers.js';
import { refoldNetworkBuffers } from '../db/refoldBuffers.js';

let userId: number;
let network: Network;

beforeAll(() => {
  const user = createUser('repeat-alice');
  userId = user.id;
  network = createNetwork(user.id, {
    name: 'n',
    host: 'irc.example.test',
    port: 6697,
    tls: true,
    nick: 'alice',
  })!;
});

function makeConn(): IrcConnection {
  return new IrcConnection({ network, onEvent: () => {} });
}

// Mark a channel as joined (this.channels is keyed lowercase; .name is the case
// we joined with).
function join(conn: IrcConnection, name: string): void {
  conn.upsertChannel(name);
}

const TIME = Date.parse('2026-09-15T07:05:19.957Z');

function receive(conn: IrcConnection, fields: Record<string, unknown>): void {
  conn.client.emit('message', {
    nick: 'voidsnm',
    ident: 'voidsnm',
    hostname: 'YSEUQT2XPYWKI.irc',
    type: 'privmsg',
    time: TIME,
    ...fields,
  });
}

interface Row {
  target: string;
  buffer: string;
  type: string;
  nick: string | null;
  mirrored: number;
}
const rows = (text: string, networkId = network.id): Row[] =>
  db
    .prepare(
      `SELECT m.target, b.target AS buffer, m.type, m.nick, m.mirrored
       FROM messages m JOIN buffers b ON b.id = m.buffer_id
       WHERE m.network_id = ? AND m.text = ? ORDER BY m.id`,
    )
    .all(networkId, text) as Row[];

describe('a message the network sends twice', () => {
  it('is stored once when both copies have the same msgid', () => {
    const conn = makeConn();
    const line = {
      target: '#lobby',
      message: 'seems you are messing with services',
      tags: { msgid: 'twice-1' },
    };
    receive(conn, line);
    receive(conn, line);
    expect(rows('seems you are messing with services')).toHaveLength(1);
  });

  it('is kept in each buffer when the msgid is the same', () => {
    const conn = makeConn();
    // Both channels already have history, as channels do: a buffer that doesn't
    // exist yet can't hold a repeat, so the lookup is skipped for it.
    receive(conn, { target: '#one', message: 'earlier in one', tags: { msgid: 'one-0' } });
    receive(conn, { target: '#two', message: 'earlier in two', tags: { msgid: 'two-0' } });
    receive(conn, { target: '#one', message: 'to both', tags: { msgid: 'shared-1' } });
    receive(conn, { target: '#two', message: 'to both', tags: { msgid: 'shared-1' } });
    expect(rows('to both').map((r) => r.target)).toEqual(['#one', '#two']);
  });

  it('is kept when a msgid is reused for different text, another sender or another kind', () => {
    const conn = makeConn();
    receive(conn, { target: '#lobby', message: 'first words', tags: { msgid: 'reused-1' } });
    receive(conn, { target: '#lobby', message: 'other words', tags: { msgid: 'reused-1' } });
    expect(rows('first words')).toHaveLength(1);
    expect(rows('other words')).toHaveLength(1);

    receive(conn, { target: '#lobby', message: 'same words', tags: { msgid: 'reused-2' } });
    receive(conn, {
      nick: 'someoneelse',
      target: '#lobby',
      message: 'same words',
      tags: { msgid: 'reused-2' },
    });
    expect(rows('same words').map((r) => r.nick)).toEqual(['voidsnm', 'someoneelse']);

    receive(conn, { target: '#lobby', message: 'said and noticed', tags: { msgid: 'reused-3' } });
    receive(conn, {
      type: 'notice',
      target: '#lobby',
      message: 'said and noticed',
      tags: { msgid: 'reused-3' },
    });
    expect(rows('said and noticed').map((r) => r.type)).toEqual(['message', 'notice']);
  });

  it('is kept twice without a msgid, outside catch-up', () => {
    // Nothing tells a repeat from a pasted block of repeated lines stamped in the
    // same millisecond, so both are stored.
    const conn = makeConn();
    receive(conn, { target: '#lobby', message: '----------' });
    receive(conn, { target: '#lobby', message: '----------' });
    expect(rows('----------')).toHaveLength(2);
  });

  it('in catch-up, matches a line without a msgid whose channel name differs in case', () => {
    const conn = makeConn();
    join(conn, '#Lobby');
    conn.catchingUp = true;
    receive(conn, { target: '#Lobby', message: 'said once' });
    receive(conn, { target: '#LOBBY', message: 'said once' });
    expect(rows('said once')).toHaveLength(1);
  });

  it('in catch-up, matches a line without a msgid whose channel name folds the same', () => {
    // Under rfc1459, #foo[bar] and #foo{bar} are one channel and one buffer.
    // Each row keeps the spelling its line came with.
    const rfc = createNetwork(userId, {
      name: 'rfc',
      host: 'irc.example.test',
      port: 6697,
      tls: true,
      nick: 'alice',
    })!;
    refoldNetworkBuffers(userId, rfc.id, 'rfc1459');
    const conn = new IrcConnection({ network: rfc, onEvent: () => {} });
    conn.catchingUp = true;
    receive(conn, { target: '#foo[bar]', message: 'folded once' });
    receive(conn, { target: '#foo{bar}', message: 'folded once' });
    expect(rows('folded once', rfc.id)).toHaveLength(1);
  });

  it('in catch-up, matches a msgid whose DM buffer a later NICK renamed', () => {
    // The backlog handed over after an engine restart can hold a line the last
    // process stored and, after it, a NICK that renamed that DM buffer. The copy
    // resolves to the old name, where the row no longer is.
    const conn = makeConn();
    const line = { nick: 'bob', target: 'alice', message: 'brb', tags: { msgid: 'moved-1' } };
    receive(conn, line);
    conn.client.emit('nick', {
      nick: 'bob',
      new_nick: 'bob_away',
      ident: 'bob',
      hostname: 'h',
      time: TIME,
    });
    // The rename moves the buffer. The row's own `target` keeps the name it
    // arrived under.
    expect(rows('brb').map((r) => r.buffer)).toEqual(['bob_away']);
    conn.catchingUp = true;
    receive(conn, line);
    expect(rows('brb')).toHaveLength(1);
  });

  it('gets no second mirror when it is a notice to a closed buffer', () => {
    const conn = makeConn();
    ensureBufferOpen(userId, network.id, 'NickServ');
    closeBufferRow(userId, network.id, 'NickServ');
    const notice = {
      nick: 'NickServ',
      ident: 'svc',
      hostname: 'services.',
      type: 'notice',
      target: 'alice',
      message: 'your cloak is set',
      tags: { msgid: 'notice-1' },
    };
    receive(conn, notice);
    receive(conn, notice);
    expect(rows('your cloak is set').map((r) => [r.target, r.mirrored])).toEqual([
      ['NickServ', 0],
      [`:server:${network.id}`, 1],
    ]);
  });
});
