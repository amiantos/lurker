// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// chghost (#591) + extended-join/account-notify (#508) wiring: the glue between
// live IRC traffic and channel-member state on IrcConnection.
//
// The regression these pin down is subtle. Requesting the `chghost` cap makes
// the server STOP sending the fake QUIT/rejoin pair it uses to describe a host
// change to clients that lack it. Lurker requested the cap but only handled the
// event for ITSELF, so a third party's host change rendered as nothing at all —
// strictly less than a client with no IRCv3 support. These tests assert the
// fan-out (one line per shared channel), the nicklist mutation that goes with
// it (thelounge prints the line but has no host field, so its nicklist stays
// stale — the exact complaint in #591), and that ACCOUNT stays silent.

// MUST be first — redirect DATABASE_PATH before the static imports below open
// the real data/lurker.db.
import '../test-utils/isolateDb.js';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { IrcConnection } from './ircConnection.js';
import { createUser } from '../db/users.js';
import { createNetwork } from '../db/networks.js';

beforeAll(() => {
  createUser('chghost-alice'); // id 1
  createNetwork(1, { name: 'n', host: 'h', port: 6697, tls: true, nick: 'alice' }); // network id 1
});

function makeConn(): IrcConnection {
  return new IrcConnection({
    network: {
      id: 1,
      user_id: 1,
      name: 'n',
      host: 'irc.example.test',
      port: 6697,
      tls: 1,
      trusted_certificates: 1,
      nick: 'alice',
      username: null,
      realname: null,
      server_password: null,
      autoconnect: 1,
      sasl_account: null,
      sasl_password: null,
      connect_commands: null,
      position: 0,
      created_at: new Date().toISOString(),
    },
    onEvent: () => {},
  });
}

type Ev = Record<string, unknown>;

function harness() {
  const conn = makeConn();
  const publish = vi.fn<(event: Ev) => void>();
  // The real publish persists and fans out; we only care about what it's handed.
  conn.publish = publish as unknown as IrcConnection['publish'];
  conn.client.user.nick = 'alice';
  const of = (type: string) => publish.mock.calls.map((c) => c[0]).filter((e) => e.type === type);
  const memberIn = (channel: string, nick: string) =>
    conn.channels.get(channel.toLowerCase())?.members.get(nick.toLowerCase());
  // Drive a real JOIN so member state is built the way production builds it.
  const join = (channel: string, nick: string, extra: Ev = {}) =>
    conn.client.emit('join', {
      channel,
      nick,
      ident: 'ident',
      hostname: 'old.host',
      ...extra,
    });
  return { conn, publish, of, memberIn, join };
}

describe('chghost fan-out (#591)', () => {
  it('publishes one line per shared channel and updates the stored mask', () => {
    const { conn, of, memberIn, join } = harness();
    join('#one', 'bob');
    join('#two', 'bob');
    join('#three', 'carol'); // bob absent — must not receive a line

    conn.client.emit('user updated', {
      nick: 'bob',
      ident: 'ident',
      hostname: 'old.host',
      new_ident: 'newident',
      new_hostname: 'user/bob',
    });

    const lines = of('chghost');
    expect(lines.map((l) => l.target).sort()).toEqual(['#one', '#two']);
    expect(lines[0]).toMatchObject({
      nick: 'bob',
      newIdent: 'newident',
      newHost: 'user/bob',
      // The OLD mask — the new one is the body of the line, matching weechat's
      // "nick (old) has changed host to new" shape.
      userhost: 'bob!ident@old.host',
    });

    // The nicklist must actually move, not just the rendered line.
    expect(memberIn('#one', 'bob')).toMatchObject({ user: 'newident', host: 'user/bob' });
    expect(memberIn('#two', 'bob')).toMatchObject({ user: 'newident', host: 'user/bob' });
    expect(memberIn('#three', 'carol')).toMatchObject({ host: 'old.host' });
  });

  it('emits a member-update alongside each line so the nicklist patches live', () => {
    const { conn, of, join } = harness();
    join('#one', 'bob');
    conn.client.emit('user updated', {
      nick: 'bob',
      ident: 'ident',
      hostname: 'old.host',
      new_hostname: 'user/bob',
    });
    const patches = of('member-update');
    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({
      target: '#one',
      member: { nick: 'bob', host: 'user/bob' },
    });
  });

  it('carries the unchanged half forward when CHGHOST only moves one', () => {
    const { conn, of, memberIn, join } = harness();
    join('#one', 'bob');
    // Host-only change: no new_ident on the wire.
    conn.client.emit('user updated', {
      nick: 'bob',
      ident: 'ident',
      hostname: 'old.host',
      new_hostname: 'user/bob',
    });
    expect(of('chghost')[0]).toMatchObject({ newIdent: 'ident', newHost: 'user/bob' });
    expect(memberIn('#one', 'bob')).toMatchObject({ user: 'ident', host: 'user/bob' });
  });

  it('keeps the server-buffer line for your own host change, and still fans out', () => {
    const { conn, of, join } = harness();
    join('#one', 'alice');
    conn.client.emit('user updated', {
      nick: 'alice',
      ident: 'ident',
      hostname: 'old.host',
      new_ident: 'newident',
      new_hostname: 'user/alice',
    });
    // The SASL-cloak confirmation belongs where you'll see it even with no
    // channels open — but it must not REPLACE the in-channel line.
    expect(of('motd').map((e) => e.text)).toContain('Your hostmask: newident@user/alice');
    expect(of('chghost').map((e) => e.target)).toEqual(['#one']);
  });

  it('ignores SETNAME, which rides the same event', () => {
    const { conn, of, join } = harness();
    join('#one', 'bob');
    // A realname change carries neither new_ident nor new_hostname.
    conn.client.emit('user updated', { nick: 'bob', ident: 'ident', hostname: 'old.host' });
    expect(of('chghost')).toHaveLength(0);
    expect(of('member-update')).toHaveLength(0);
  });
});

describe('extended-join / account-notify (#508)', () => {
  it('records the account from an extended JOIN', () => {
    const { memberIn, join } = harness();
    join('#one', 'bob', { account: 'bobaccount' });
    expect(memberIn('#one', 'bob')?.account).toBe('bobaccount');
  });

  it('puts the account on the join event so the join line can show it', () => {
    const { of, join } = harness();
    join('#one', 'bob', { account: 'bobaccount' });
    expect(of('join')[0]).toMatchObject({ nick: 'bob', account: 'bobaccount' });
  });

  it('omits account from the join event when there is nothing to show', () => {
    const { of, join } = harness();
    join('#one', 'bob', { account: false }); // logged out
    join('#two', 'carol'); // cap not enabled
    // Renders as nothing either way, so keep it off the persisted `extra` JSON
    // rather than writing a null onto every join row.
    for (const e of of('join')) expect(e).not.toHaveProperty('account');
  });

  it('distinguishes logged-out from never-learned', () => {
    const { memberIn, join } = harness();
    // irc-framework hands us `false` for the `*` sentinel...
    join('#one', 'bob', { account: false });
    expect(memberIn('#one', 'bob')?.account).toBeNull();
    // ...and omits the key entirely when the cap isn't enabled. That's the
    // state a future WHOX backfill is allowed to fill in; `null` is not.
    join('#one', 'carol');
    expect(memberIn('#one', 'carol')?.account).toBeUndefined();
  });

  it('updates the account on ACCOUNT without rendering a line', () => {
    const { conn, of, memberIn, join } = harness();
    join('#one', 'bob');
    join('#two', 'bob');
    conn.client.emit('account', { nick: 'bob', account: 'bobaccount' });

    expect(memberIn('#one', 'bob')?.account).toBe('bobaccount');
    expect(memberIn('#two', 'bob')?.account).toBe('bobaccount');
    // Silent by design: on Libera an identify fires ACCOUNT *and* CHGHOST back
    // to back, so a visible line here would double every identify.
    expect(of('account')).toHaveLength(0);
    expect(of('chghost')).toHaveLength(0);
    expect(
      of('member-update')
        .map((e) => e.target)
        .sort(),
    ).toEqual(['#one', '#two']);
  });

  it('records a logout', () => {
    const { conn, memberIn, join } = harness();
    join('#one', 'bob', { account: 'bobaccount' });
    conn.client.emit('account', { nick: 'bob', account: false });
    expect(memberIn('#one', 'bob')?.account).toBeNull();
  });

  it('preserves a known account across a NAMES rebuild', () => {
    const { conn, memberIn, join } = harness();
    join('#one', 'bob', { account: 'bobaccount' });
    // NAMES never carries an account, so a rebuild must not wipe what we know.
    conn.client.emit('userlist', {
      channel: '#one',
      users: [{ nick: 'bob', modes: [] }],
    });
    expect(memberIn('#one', 'bob')?.account).toBe('bobaccount');
  });
});
