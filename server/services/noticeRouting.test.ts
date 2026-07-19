// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// NOTICE routing (#439): a notice persists to its natural home — the sender's
// buffer for a nick notice, the channel for a channel notice, the server buffer
// for a server-sourced one — like a PRIVMSG, so the buffer surfaces on first
// notice and history lands in the right place. Open/closed is a client display
// concern; the one server-side exception is the closed-buffer mirror, which
// persists a second (search-excluded, `mirrored`-flagged) copy in the server
// buffer so a notice to a buffer you've closed isn't silently lost — including
// for a client that was offline when it arrived. These exercise that PLUMBING via
// inbound `message` event. The channel-context helper is unit-pinned in
// ircConnection.test.ts.

// MUST be first — redirect DATABASE_PATH before the static imports below open
// the real data/lurker.db.
import '../test-utils/isolateDb.js';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { IrcConnection } from './ircConnection.js';
import { createUser } from '../db/users.js';
import { createNetwork } from '../db/networks.js';
import {
  ensureOpen as ensureBufferOpen,
  close as closeBufferRow,
  reopen as reopenBufferRow,
} from '../db/buffers.js';

// A buffer you can close necessarily has a registry row — mirror that here.
function closeBuffer(userId: number, networkId: number, target: string): void {
  ensureBufferOpen(userId, networkId, target);
  closeBufferRow(userId, networkId, target);
}
const reopenBuffer = reopenBufferRow;
import { insertMessage } from '../db/messages.js';

beforeAll(() => {
  createUser('notice-alice'); // id 1
  createNetwork(1, { name: 'n', host: 'h', port: 6697, tls: true, nick: 'alice' }); // network id 1
});

afterEach(() => {
  // closed_buffers persists across tests in this file — reset what we close.
  reopenBuffer(1, 1, 'NickServ');
  vi.restoreAllMocks();
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

// Spy the persist + ephemeral seams on a fresh connection. publish returns the
// enriched event (with the ignore verdict); the spy defaults to undefined, which
// the mirror treats as "not ignored".
function harness() {
  const conn = makeConn();
  const publish = vi.fn<(event: Record<string, unknown>) => unknown>();
  const publishEphemeral = vi.fn<(event: Record<string, unknown>) => unknown>();
  conn.publish = publish as unknown as typeof conn.publish;
  conn.publishEphemeral = publishEphemeral as unknown as typeof conn.publishEphemeral;
  return { conn, publish, publishEphemeral };
}

// Seed a real persisted message so DB-backed routing (casing fold, presence
// gate) sees history. Returns nothing — callers query via the connection.
function seed(target: string, nick: string, text: string, type = 'message'): void {
  // In production a persisted event mints the registry row (wsHub's live
  // filter); tests bypass that path, so mirror it here.
  ensureBufferOpen(1, 1, target);
  insertMessage({
    networkId: 1,
    target,
    time: new Date().toISOString(),
    type,
    nick,
    text,
    self: false,
  });
}

// Mark a channel as currently joined (this.channels is keyed lowercase; .name
// holds the case we joined with).
function join(conn: IrcConnection, name: string): void {
  conn.channels.set(name.toLowerCase(), {
    name,
    topic: null,
    members: new Map(),
    modes: new Set(),
  });
}

function emitNotice(conn: IrcConnection, fields: Record<string, unknown>): void {
  conn.client.emit('message', {
    ident: 'svc',
    hostname: 'services.',
    type: 'notice',
    ...fields,
  });
}

describe('NOTICE routing (#439)', () => {
  it('persists a nick notice to the sender buffer (no mirror when not closed)', () => {
    const { conn, publish, publishEphemeral } = harness();
    emitNotice(conn, { nick: 'ChanServ', target: 'alice', message: 'hi there' });
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ target: 'ChanServ', type: 'notice', nick: 'ChanServ' }),
    );
    expect(publishEphemeral).not.toHaveBeenCalled();
  });

  it('persists a channel notice to the channel buffer', () => {
    const { conn, publish } = harness();
    emitNotice(conn, { nick: 'bob', target: '#general', message: 'heads up' });
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ target: '#general', type: 'notice' }),
    );
  });

  it('persists a server-sourced notice (no nick) to the server buffer', () => {
    const { conn, publish } = harness();
    emitNotice(conn, {
      nick: undefined,
      target: 'alice',
      hostname: 'irc.example.test',
      message: '*** Looking up your hostname',
    });
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ target: ':server:1', type: 'notice' }),
    );
  });

  it('redirects a nick notice to a joined channel via +draft/channel-context', () => {
    const { conn, publish } = harness();
    join(conn, '#Christian');
    emitNotice(conn, {
      nick: 'ChanServ',
      target: 'alice',
      message: 'welcome',
      tags: { '+draft/channel-context': '#christian' },
    });
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ target: '#Christian', type: 'notice' }),
    );
  });

  it('redirects a nick notice to a joined channel via a [#chan] body prefix', () => {
    const { conn, publish } = harness();
    join(conn, '#Christian');
    emitNotice(conn, { nick: 'ChanServ', target: 'alice', message: '[#christian] welcome!' });
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ target: '#Christian', type: 'notice' }),
    );
  });

  it('does not redirect when the referenced channel is not joined', () => {
    const { conn, publish } = harness();
    emitNotice(conn, { nick: 'ChanServ', target: 'alice', message: '[#elsewhere] welcome!' });
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ target: 'ChanServ', type: 'notice' }),
    );
  });

  it('mirrors a closed-buffer notice as a durable, flagged copy in the server buffer', () => {
    const { conn, publish } = harness();
    closeBuffer(1, 1, 'NickServ');
    emitNotice(conn, { nick: 'NickServ', target: 'alice', message: 'your cloak is set' });
    // Real copy persisted under the (closed) home buffer.
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ target: 'NickServ' }));
    // A second, durable copy persisted in the server buffer, flagged `mirrored`
    // so it's excluded from search (no duplicate hit). Persisted (publish), not
    // ephemeral, so a reconnecting/mobile client sees it too.
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        target: ':server:1',
        type: 'notice',
        nick: 'NickServ',
        text: 'your cloak is set',
        mirrored: true,
      }),
    );
  });

  it('does not mirror an ignored sender into the server buffer', () => {
    const { conn, publish } = harness();
    closeBuffer(1, 1, 'IgnTroll');
    // publish reports the message was ignore-filtered (from_ignored), so the
    // mirror must not re-surface the raw text past the ignore list.
    publish.mockReturnValue({ fromIgnored: true });
    emitNotice(conn, { nick: 'IgnTroll', target: 'alice', message: 'rude thing' });
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ target: 'IgnTroll' }));
    expect(publish).not.toHaveBeenCalledWith(expect.objectContaining({ target: ':server:1' }));
    reopenBuffer(1, 1, 'IgnTroll');
  });

  it('folds the sender nick to an existing buffer casing (no ChanServ/chanserv split)', () => {
    const { conn, publish } = harness();
    seed('caseserv', 'caseserv', 'earlier reply'); // history exists as lowercase
    emitNotice(conn, { nick: 'CaseServ', target: 'alice', message: 'later reply' });
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ target: 'caseserv' }));
  });

  it('routes a notice not addressed to our nick to the server buffer (no bogus DM)', () => {
    const { conn, publish } = harness();
    // A NOTICE to an `&` local channel Lurker does not route as a channel, and
    // not addressed to us → server buffer, not a fabricated DM with the sender.
    emitNotice(conn, { nick: 'LogBot', target: '&admin', message: 'audit log line' });
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ target: ':server:1', type: 'notice' }),
    );
  });

  it('probePresence tracks a real conversation but not a notice-only service buffer', () => {
    const { conn } = harness();
    seed('SvcOnly', 'SvcOnly', 'a notice', 'notice'); // notice-only → not a peer
    seed('RealPal', 'RealPal', 'hello'); // real conversation → a peer
    const track = vi.spyOn(conn, 'trackDmPeer').mockReturnValue(true);
    conn.probePresence('SvcOnly');
    expect(track).not.toHaveBeenCalled();
    conn.probePresence('RealPal');
    expect(track).toHaveBeenCalledWith('RealPal');
  });
});
