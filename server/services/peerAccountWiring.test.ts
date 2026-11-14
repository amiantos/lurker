// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// A DM peer's services account (#646): the connection tells clients which
// account each tracked peer is logged in to, from every source that says —
// extended-join, account-notify, a WHOX reply, the account tag on their own
// line, a WHOIS — as `peerAccounts` in the snapshot and a `peer-account` frame
// on a change. The client's member lists can't answer this: they load per
// channel, on demand (#1292), and a peer we share no channel with is in none.

// MUST be first — redirect DATABASE_PATH before the static imports below open
// the real data/lurker.db.
import '../test-utils/isolateDb.js';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { IrcConnection } from './ircConnection.js';
import { createUser } from '../db/users.js';
import { createNetwork, getNetwork } from '../db/networks.js';

type Network = NonNullable<ReturnType<typeof getNetwork>>;
let network: Network;

beforeAll(() => {
  const user = createUser('peer-account-alice');
  const made = createNetwork(user.id, {
    name: 'n',
    host: 'h',
    port: 6697,
    tls: true,
    nick: 'alice',
  });
  network = getNetwork(user.id, made!.id)!;
});

type Ev = Record<string, unknown>;

function harness() {
  const conn = new IrcConnection({ network, onEvent: () => {} });
  const ephemeral = vi.fn<(event: Ev) => void>();
  conn.publish = vi.fn<(event: Ev) => void>() as unknown as IrcConnection['publish'];
  conn.publishEphemeral = ephemeral as unknown as IrcConnection['publishEphemeral'];
  conn.client.user.nick = 'alice';
  conn.state = 'connected';
  /** Every `peer-account` frame so far, as [nick, account]. */
  const told = () =>
    ephemeral.mock.calls
      .map((c) => c[0])
      .filter((e) => e.type === 'peer-account')
      .map((e) => [e.nick, e.account]);
  const join = (channel: string, nick: string, extra: Ev = {}) => {
    if (nick !== 'alice' && !conn.isChannelJoined(channel)) {
      conn.client.emit('join', { channel, nick: 'alice', ident: 'alice', hostname: 'self.host' });
    }
    conn.client.emit('join', { channel, nick, ident: 'ident', hostname: 'a.host', ...extra });
  };
  const accounts = () => (conn.snapshot() as unknown as { peerAccounts: Ev }).peerAccounts;
  return { conn, told, join, accounts };
}

describe('a DM peer’s account (#646)', () => {
  it('is told from an extended-join, for a tracked peer only', () => {
    const { conn, told, join, accounts } = harness();
    conn.trackDmPeer('Bob');
    join('#one', 'Bob', { account: 'bobacct' });
    join('#one', 'carol', { account: 'carolacct' });
    expect(told()).toEqual([['Bob', 'bobacct']]);
    expect(accounts()).toEqual({ bob: 'bobacct' });
  });

  it('is told when a DM opens with someone already known', () => {
    const { conn, told, join } = harness();
    join('#one', 'bob', { account: 'bobacct' });
    expect(told()).toEqual([]);
    conn.trackDmPeer('bob');
    expect(told()).toEqual([['bob', 'bobacct']]);
  });

  it('is filled in by a WHOX reply for a member who was here first', () => {
    const { conn, told, join, accounts } = harness();
    conn.trackDmPeer('bob');
    join('#one', 'bob'); // no extended-join: nothing known
    expect(told()).toEqual([]);

    // A plain WHO has no account field and says nothing.
    conn.client.emit('wholist', { target: '#one', users: [{ nick: 'bob', away: false }] });
    expect(told()).toEqual([]);

    conn.client.emit('wholist', {
      target: '#one',
      users: [{ nick: 'bob', away: false, account: 'bobacct' }],
    });
    expect(told()).toEqual([['bob', 'bobacct']]);
    expect(conn.channels.get('#one')?.members.get('bob')?.account).toBe('bobacct');

    // WHOX's logged-out answer (irc-framework hands '0' on as '').
    conn.client.emit('wholist', { target: '#one', users: [{ nick: 'bob', account: '' }] });
    expect(told()).toEqual([
      ['bob', 'bobacct'],
      ['bob', null],
    ]);
    expect(accounts()).toEqual({});
  });

  it('follows account-notify in and out', () => {
    const { conn, told, join } = harness();
    conn.trackDmPeer('bob');
    join('#one', 'bob', { account: false });
    conn.client.emit('account', { nick: 'bob', account: 'bobacct' });
    conn.client.emit('account', { nick: 'bob', account: false });
    expect(told()).toEqual([
      ['bob', 'bobacct'],
      ['bob', null],
    ]);
  });

  it('takes a WHOIS for a peer we share no channel with, and keeps it past one without', () => {
    const { conn, told } = harness();
    conn.trackDmPeer('bob');
    conn.client.emit('whois', { nick: 'bob', account: 'bobacct' });
    expect(told()).toEqual([['bob', 'bobacct']]);
    // Many networks answer no WHOIS with a 330: its absence is not a logout.
    conn.client.emit('whois', { nick: 'bob' });
    conn.client.emit('whois', { nick: 'stranger', account: 'x' });
    expect(told()).toEqual([['bob', 'bobacct']]);
  });

  it('takes the account tag on their line to us; without the tag, under the cap, they are out', () => {
    const { conn, told } = harness();
    const pm = (extra: Ev) =>
      conn.client.emit('message', {
        type: 'privmsg',
        nick: 'bob',
        ident: 'ident',
        hostname: 'a.host',
        target: 'alice',
        message: 'hi',
        tags: {},
        ...extra,
      });
    pm({ account: 'bobacct' });
    expect(told()).toEqual([['bob', 'bobacct']]);
    // Cap off: an untagged line says nothing.
    pm({});
    expect(told()).toEqual([['bob', 'bobacct']]);
    conn.client.network.cap.enabled.push('account-tag');
    pm({});
    expect(told()).toEqual([
      ['bob', 'bobacct'],
      ['bob', null],
    ]);
  });

  it('is forgotten when they quit, or leave the one channel we shared', () => {
    const a = harness();
    a.conn.trackDmPeer('bob');
    a.join('#one', 'bob', { account: 'bobacct' });
    a.conn.client.emit('quit', { nick: 'bob', ident: 'ident', hostname: 'a.host', message: '' });
    expect(a.told()).toEqual([
      ['bob', 'bobacct'],
      ['bob', null],
    ]);

    const b = harness();
    b.conn.trackDmPeer('bob');
    b.join('#one', 'bob', { account: 'bobacct' });
    b.join('#two', 'bob', { account: 'bobacct' });
    b.conn.client.emit('part', {
      channel: '#one',
      nick: 'bob',
      ident: 'ident',
      hostname: 'a.host',
    });
    expect(b.told()).toEqual([['bob', 'bobacct']]);
    b.conn.client.emit('part', {
      channel: '#two',
      nick: 'bob',
      ident: 'ident',
      hostname: 'a.host',
    });
    expect(b.told()).toEqual([
      ['bob', 'bobacct'],
      ['bob', null],
    ]);
  });

  it('is forgotten when we leave the channel that told us', () => {
    const { conn, told, join } = harness();
    conn.trackDmPeer('bob');
    join('#one', 'bob', { account: 'bobacct' });
    conn.client.emit('part', {
      channel: '#one',
      nick: 'alice',
      ident: 'alice',
      hostname: 'self.host',
    });
    expect(told()).toEqual([
      ['bob', 'bobacct'],
      ['bob', null],
    ]);
  });

  it('moves with a nick change', () => {
    const { conn, told, join, accounts } = harness();
    conn.trackDmPeer('bob');
    join('#one', 'bob', { account: 'bobacct' });
    conn.client.emit('nick', {
      nick: 'bob',
      new_nick: 'bobby',
      ident: 'ident',
      hostname: 'a.host',
    });
    // The DM's rename is what tracks the new nick; there is no DM row here.
    conn.trackDmPeer('bobby');
    expect(told()).toEqual([
      ['bob', 'bobacct'],
      ['bob', null],
      ['bobby', 'bobacct'],
    ]);
    expect(accounts()).toEqual({ bobby: 'bobacct' });
  });

  it('does not outlive the socket', () => {
    const { conn, told, join, accounts } = harness();
    conn.trackDmPeer('bob');
    join('#one', 'bob', { account: 'bobacct' });
    conn.markAllPeersOffline();
    expect(told()).toEqual([
      ['bob', 'bobacct'],
      ['bob', null],
    ]);
    conn.state = 'disconnected';
    expect(accounts()).toEqual({});
  });

  it('goes with the DM', () => {
    const { conn, told, join, accounts } = harness();
    conn.trackDmPeer('bob');
    join('#one', 'bob', { account: 'bobacct' });
    conn.untrackDmPeer('bob');
    expect(told()).toEqual([
      ['bob', 'bobacct'],
      ['bob', null],
    ]);
    expect(accounts()).toEqual({});
  });

  it('follows account-notify for a peer we share no channel with', () => {
    // extended-monitor sends ACCOUNT for a MONITORed nick in no channel of ours.
    const { conn, told } = harness();
    conn.trackDmPeer('bob');
    conn.client.emit('account', { nick: 'bob', account: 'bobacct' });
    conn.client.emit('account', { nick: 'bob', account: false });
    expect(told()).toEqual([
      ['bob', 'bobacct'],
      ['bob', null],
    ]);
  });

  it('does not fall back to an older line once a shared channel saw them log out', () => {
    const { conn, told, join, accounts } = harness();
    conn.trackDmPeer('bob');
    conn.client.emit('whois', { nick: 'bob', account: 'bobacct' });
    join('#one', 'bob', { account: 'bobacct' });
    conn.client.emit('account', { nick: 'bob', account: false });
    conn.client.emit('part', { channel: '#one', nick: 'bob' });
    expect(told()).toEqual([
      ['bob', 'bobacct'],
      ['bob', null],
    ]);
    expect(accounts()).toEqual({});
  });

  it('is forgotten when a NAMES shows they left while we were not told', () => {
    const { conn, told, join, accounts } = harness();
    conn.trackDmPeer('bob');
    join('#one', 'bob', { account: 'bobacct' });
    conn.client.emit('userlist', { channel: '#one', users: [{ nick: 'alice', modes: [] }] });
    expect(told()).toEqual([
      ['bob', 'bobacct'],
      ['bob', null],
    ]);
    expect(accounts()).toEqual({});
  });

  it('is forgotten when the engine dials a new socket, and told afresh after', () => {
    // The socket died while our link to the engine was down: no 'socket close'.
    const { conn, told, join } = harness();
    conn.trackDmPeer('bob');
    conn.client.emit('whois', { nick: 'bob', account: 'bobacct' });
    (conn as unknown as { onEnginePhase(p: string, i: object): void }).onEnginePhase('dialing', {});
    conn.state = 'connected';
    join('#one', 'bob', { account: 'bobacct' });
    expect(told()).toEqual([
      ['bob', 'bobacct'],
      ['bob', null],
      ['bob', 'bobacct'],
    ]);
  });
});
