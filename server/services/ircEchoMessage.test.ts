// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// echo-message adoption + server-time/msgid capture (#450). With the upstream
// cap ACKed, ircManager skips its optimistic self publish and the message
// handler adopts the server's reflection as the persisted self row (real msgid
// + server @time). Without the cap, reflections stay deduped and the
// optimistic publish remains the source of truth.

// MUST be first: isolate the DB before ircConnection pulls in db/index.js.
import '../test-utils/isolateDb.js';
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { IrcConnection } from './ircConnection.js';
import ircManager from './ircManager.js';
import { e2eManager } from './e2e/manager.js';
import { createUser } from '../db/users.js';
import { createNetwork } from '../db/networks.js';
import { listMessages } from '../db/messages.js';
import { ensureOpen } from '../db/buffers.js';

let userId: number;
let networkId: number;

beforeAll(() => {
  userId = createUser('echo-test').id;
  const net = createNetwork(userId, {
    name: 'echonet',
    host: 'irc.example.test',
    port: 6697,
    tls: true,
    nick: 'me',
  });
  networkId = net!.id;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeConn(onEvent: (event: unknown) => void = () => {}): IrcConnection {
  const conn = new IrcConnection({
    network: {
      id: networkId,
      user_id: userId,
      name: 'echonet',
      host: 'irc.example.test',
      port: 6697,
      tls: 1,
      trusted_certificates: 1,
      nick: 'me',
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
    onEvent,
  });
  conn.client.user.nick = 'me';
  // Presence writes would trip FKs for nicks with no seeded state — not under test.
  conn.markPeerEvent = vi.fn<typeof conn.markPeerEvent>();
  conn.trackDmPeer = vi.fn<typeof conn.trackDmPeer>();
  return conn;
}

// Flip the negotiated cap set the way a registered server would, and mark the
// socket live — echoActive() requires BOTH (a stale ACKed cap on a dead socket
// must fall back to the optimistic publish).
function enableEcho(conn: IrcConnection): void {
  (
    conn.client as unknown as {
      network: { cap: { enabled: string[]; available: Map<string, string> } };
      connection: { connected: boolean };
    }
  ).network = { cap: { enabled: ['echo-message'], available: new Map() } };
  (conn.client as unknown as { connection: { connected: boolean } }).connection = {
    connected: true,
  };
}

function setSocketConnected(conn: IrcConnection, connected: boolean): void {
  (conn.client as unknown as { connection: { connected: boolean } }).connection = { connected };
}

function makeReceiver(): { conn: IrcConnection; publish: ReturnType<typeof vi.fn> } {
  const conn = makeConn();
  const publish = vi.fn<(event: unknown) => void>();
  conn.publish = publish;
  return { conn, publish };
}

describe('echoActive()', () => {
  it('is false on a bare connection and true once the cap is ACKed', () => {
    const conn = makeConn();
    expect(conn.echoActive()).toBe(false);
    enableEcho(conn);
    expect(conn.echoActive()).toBe(true);
  });

  it('goes false when the socket drops, even though the ACKed cap survives', () => {
    // irc-framework clears cap.enabled only on the NEXT 'connecting', and its
    // write() silently discards lines on a dead socket — without this gate, a
    // send in the disconnect/backoff window would skip the optimistic publish
    // AND never get an echo: silently lost while send() returns true.
    const conn = makeConn();
    enableEcho(conn);
    setSocketConnected(conn, false);
    expect(conn.echoActive()).toBe(false);
  });
});

describe('self-echo adoption in the message handler', () => {
  it('still drops a reflected self message when the cap is NOT ACKed', () => {
    const { conn, publish } = makeReceiver();
    conn.client.emit('message', { nick: 'me', target: '#chan', type: 'privmsg', message: 'hi' });
    expect(publish).not.toHaveBeenCalled();
  });

  it('adopts a channel echo as the self row, carrying msgid + server time', () => {
    const { conn, publish } = makeReceiver();
    enableEcho(conn);
    conn.client.emit('message', {
      // Case-variant nick: the self check must fold.
      nick: 'ME',
      ident: 'u',
      hostname: 'h',
      target: '#chan',
      type: 'privmsg',
      message: 'hello there',
      time: 1750000000000,
      tags: { msgid: 'm1' },
    });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0][0]).toMatchObject({
      type: 'message',
      target: '#chan',
      nick: 'ME',
      text: 'hello there',
      kind: 'privmsg',
      self: true,
      time: 1750000000000,
      msgid: 'm1',
    });
  });

  it('routes a DM echo by RECIPIENT, never by our own nick', () => {
    const { conn, publish } = makeReceiver();
    enableEcho(conn);
    conn.client.emit('message', { nick: 'me', target: 'Bob', type: 'privmsg', message: 'yo' });
    expect(publish.mock.calls[0][0]).toMatchObject({ target: 'Bob', self: true });
  });

  it('folds a DM echo to the existing buffer row casing (#289)', () => {
    ensureOpen(userId, networkId, 'bob');
    const { conn, publish } = makeReceiver();
    enableEcho(conn);
    conn.client.emit('message', { nick: 'me', target: 'BOB', type: 'privmsg', message: 'yo' });
    expect(publish.mock.calls[0][0]).toMatchObject({ target: 'bob' });
  });

  it('adopts NOTICE and ACTION echoes with their own type — and never mirrors', () => {
    const { conn, publish } = makeReceiver();
    enableEcho(conn);
    conn.client.emit('message', { nick: 'me', target: '#chan', type: 'notice', message: 'n' });
    conn.client.emit('message', { nick: 'me', target: '#chan', type: 'action', message: 'waves' });
    // Exactly one publish per echo: the closed-buffer :server: mirror path is
    // skipped for adopted self notices, same as the optimistic path it replaces.
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls[0][0]).toMatchObject({ type: 'notice', kind: 'notice', self: true });
    expect(publish.mock.calls[1][0]).toMatchObject({ type: 'action', kind: 'action', self: true });
  });

  it('drops the echo of ciphertext we sent (the plaintext row was published at send time)', () => {
    const { conn, publish } = makeReceiver();
    enableEcho(conn);
    conn.noteSentCiphertext('+RPE2E01 deadbeef');
    conn.client.emit('message', {
      nick: 'me',
      target: '#enc',
      type: 'privmsg',
      message: '+RPE2E01 deadbeef',
    });
    expect(publish).not.toHaveBeenCalled();
  });

  it('drops sent ciphertext even after E2E was disabled in the send→echo window', () => {
    // The gate matches by CONTENT, not channel state — /e2e off between the
    // wire write and the echo must not turn our own ciphertext into an
    // adopted cleartext row.
    e2eManager.setChannelConfig(userId, networkId, '#racechan', true, 'normal');
    const { conn, publish } = makeReceiver();
    enableEcho(conn);
    conn.noteSentCiphertext('+RPE2E01 racebytes');
    e2eManager.setChannelConfig(userId, networkId, '#racechan', false, 'normal');
    conn.client.emit('message', {
      nick: 'me',
      target: '#racechan',
      type: 'privmsg',
      message: '+RPE2E01 racebytes',
    });
    expect(publish).not.toHaveBeenCalled();
  });

  it('adopts a literal +RPE2E01 body we never sent as ciphertext (any channel)', () => {
    const { conn, publish } = makeReceiver();
    enableEcho(conn);
    conn.client.emit('message', {
      nick: 'me',
      target: '#plain',
      type: 'privmsg',
      message: '+RPE2E01 not actually ciphertext',
    });
    expect(publish.mock.calls[0][0]).toMatchObject({
      text: '+RPE2E01 not actually ciphertext',
      self: true,
    });
  });

  it('adopts a self-DM exactly once — the delivery copy and echo copy share a msgid', () => {
    // /msg <own nick>: ergo and solanum both send the delivery line AND the
    // echo line, same msgid, both prefixed with our nick.
    const { conn, publish } = makeReceiver();
    enableEcho(conn);
    const selfDm = { nick: 'me', target: 'me', type: 'privmsg', message: 'note to self' };
    conn.client.emit('message', { ...selfDm, tags: { msgid: 'twin-1' } });
    conn.client.emit('message', { ...selfDm, tags: { msgid: 'twin-1' } });
    expect(publish).toHaveBeenCalledTimes(1);
    // A genuinely new message (fresh msgid) still adopts.
    conn.client.emit('message', { ...selfDm, message: 'second note', tags: { msgid: 'twin-2' } });
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it('adopts a multiline echo as ONE row with the first fragment tags/time', () => {
    const { conn, publish } = makeReceiver();
    enableEcho(conn);
    const fragment = (message: string, extra: Record<string, unknown> = {}) => ({
      nick: 'me',
      target: '#chan',
      type: 'privmsg',
      message,
      batch: { id: 'b1', type: 'draft/multiline' },
      ...extra,
    });
    conn.client.emit(
      'message',
      fragment('line one', { time: 1750000000000, tags: { msgid: 'mm' } }),
    );
    conn.client.emit('message', fragment('line two'));
    expect(publish).not.toHaveBeenCalled();
    conn.client.emit('batch end draft/multiline', { id: 'b1' });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0][0]).toMatchObject({
      text: 'line one\nline two',
      self: true,
      time: 1750000000000,
      msgid: 'mm',
    });
  });

  it('grafts msgid/@time from the BATCH start line onto a multiline message', () => {
    // Per the draft/multiline spec the logical message's tags ride the
    // `BATCH +ref` line — which irc-framework reduces to {id,type,params},
    // discarding the tags. The raw-line stash must recover them; inner
    // fragments carry only the batch ref.
    const { conn, publish } = makeReceiver();
    conn.client.emit('raw', {
      from_server: true,
      line: '@msgid=batch-mm;time=2025-01-01T00:00:00.000Z :alice!u@h BATCH +bt1 draft/multiline #chan',
    });
    const fragment = (message: string) => ({
      nick: 'alice',
      target: '#chan',
      type: 'privmsg',
      message,
      batch: { id: 'bt1', type: 'draft/multiline' },
    });
    conn.client.emit('message', fragment('part one'));
    conn.client.emit('message', fragment('part two'));
    conn.client.emit('batch end draft/multiline', { id: 'bt1' });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0][0]).toMatchObject({
      text: 'part one\npart two',
      msgid: 'batch-mm',
      // The raw tag value is an ISO string; normalizeEventTime canonicalizes
      // strings, so the graft passes it through untouched.
      time: '2025-01-01T00:00:00.000Z',
    });
  });

  it('a case-variant self TAGMSG echo never surfaces a typing indicator', () => {
    const conn = makeConn();
    enableEcho(conn);
    const publishEphemeral = vi.fn<(event: unknown) => void>();
    conn.publishEphemeral = publishEphemeral;
    conn.client.emit('tagmsg', { nick: 'ME', target: '#chan', tags: { '+typing': 'active' } });
    expect(publishEphemeral).not.toHaveBeenCalled();
  });

  it('a self CTCP response echo never re-enters the E2E handshake', () => {
    const conn = makeConn();
    enableEcho(conn);
    const handshake = vi.spyOn(e2eManager, 'handleHandshakeBody');
    conn.client.emit('ctcp response', {
      nick: 'ME',
      ident: 'u',
      hostname: 'h',
      target: '#hs',
      type: 'RPEE2E',
      message: 'RPEE2E whatever',
    });
    expect(handshake).not.toHaveBeenCalled();
  });
});

describe('server-time + msgid persistence (real publish)', () => {
  it('persists an adopted echo with the ISO of the @time tag and its msgid', () => {
    const conn = makeConn();
    enableEcho(conn);
    conn.client.emit('message', {
      nick: 'me',
      target: '#persist1',
      type: 'privmsg',
      message: 'stamped',
      time: 1750000000000,
      tags: { msgid: 'echo-1' },
    });
    const rows = listMessages(networkId, '#persist1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      self: true,
      text: 'stamped',
      msgid: 'echo-1',
      time: new Date(1750000000000).toISOString(),
    });
  });

  it('persists a peer message with tag time as ISO and honors the draft/msgid alias', () => {
    const conn = makeConn();
    conn.client.emit('message', {
      nick: 'alice',
      ident: 'a',
      hostname: 'h',
      target: '#persist2',
      type: 'privmsg',
      message: 'tagged',
      time: 1750000000000,
      tags: { 'draft/msgid': 'draft-1' },
    });
    const rows = listMessages(networkId, '#persist2');
    expect(rows[0]).toMatchObject({
      self: false,
      msgid: 'draft-1',
      time: new Date(1750000000000).toISOString(),
    });
  });

  it('falls back to receive time when the tag is absent, and omits msgid entirely', () => {
    const conn = makeConn();
    const before = Date.now();
    conn.client.emit('message', {
      nick: 'alice',
      target: '#persist3',
      type: 'privmsg',
      message: 'untagged',
    });
    const row = listMessages(networkId, '#persist3')[0];
    const stored = Date.parse(row.time);
    expect(stored).toBeGreaterThanOrEqual(before - 1000);
    expect(stored).toBeLessThanOrEqual(Date.now() + 1000);
    expect(row).not.toHaveProperty('msgid');
  });

  it('clamps a far-future tag time to receive time (buffer MAX(time) pinning guard)', () => {
    const conn = makeConn();
    const before = Date.now();
    conn.client.emit('message', {
      nick: 'alice',
      target: '#persist4',
      type: 'privmsg',
      message: 'from the future',
      time: Date.now() + 10 * 60_000,
    });
    const stored = Date.parse(listMessages(networkId, '#persist4')[0].time);
    expect(stored).toBeGreaterThanOrEqual(before - 1000);
    expect(stored).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('keeps a PAST tag time verbatim — bouncer replay must not be rewritten', () => {
    const conn = makeConn();
    const past = Date.now() - 3 * 24 * 60 * 60_000;
    conn.client.emit('message', {
      nick: 'alice',
      target: '#persist5',
      type: 'privmsg',
      message: 'replayed',
      time: past,
    });
    expect(listMessages(networkId, '#persist5')[0].time).toBe(new Date(past).toISOString());
  });

  it('threads @time through a metadata handler too (join)', () => {
    const conn = makeConn();
    conn.client.emit('join', {
      nick: 'alice',
      ident: 'a',
      hostname: 'h',
      channel: '#persist6',
      time: 1750000000000,
    });
    const rows = listMessages(networkId, '#persist6');
    expect(rows[0]).toMatchObject({ type: 'join', time: new Date(1750000000000).toISOString() });
  });
});

describe('ircManager optimistic-publish gating', () => {
  function fakeConn(overrides: Record<string, unknown> = {}) {
    const say = vi.fn<(target: string, text: string) => void>();
    const action = vi.fn<(target: string, text: string) => void>();
    const notice = vi.fn<(target: string, text: string) => void>();
    const publish = vi.fn<(event: unknown) => void>();
    const conn = {
      say,
      action,
      notice,
      publish,
      client: { user: { nick: 'me' } },
      supportsMultiline: () => false,
      echoActive: () => true,
      noteSentCiphertext: () => {},
      flushE2eRekeys: () => {},
      ...overrides,
    } as unknown as IrcConnection;
    return { conn, say, action, notice, publish };
  }

  it('send/action/notice write the wire but skip the optimistic publish when echo is active', () => {
    const { conn, say, action, notice, publish } = fakeConn();
    vi.spyOn(ircManager, 'getConnection').mockReturnValue(conn);
    ircManager.send(userId, networkId, '#gate', 'hi');
    ircManager.action(userId, networkId, '#gate', 'waves');
    ircManager.notice(userId, networkId, '#gate', 'psst');
    expect(say).toHaveBeenCalledWith('#gate', 'hi');
    expect(action).toHaveBeenCalledWith('#gate', 'waves');
    expect(notice).toHaveBeenCalledWith('#gate', 'psst');
    expect(publish).not.toHaveBeenCalled();
  });

  it('keeps the optimistic publish when the cap is absent', () => {
    const { conn, publish } = fakeConn({ echoActive: () => false });
    vi.spyOn(ircManager, 'getConnection').mockReturnValue(conn);
    ircManager.send(userId, networkId, '#gate', 'hi');
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0][0]).toMatchObject({ type: 'message', text: 'hi', self: true });
  });

  it('multiline sends still hit the wire, publish only without the cap', () => {
    const sendMultiline = vi.fn<(target: string, text: string) => string[]>(() => ['a\nb']);
    const withEcho = fakeConn({ supportsMultiline: () => true, sendMultiline });
    vi.spyOn(ircManager, 'getConnection').mockReturnValue(withEcho.conn);
    ircManager.send(userId, networkId, '#gate', 'a\nb');
    expect(sendMultiline).toHaveBeenCalledWith('#gate', 'a\nb');
    expect(withEcho.publish).not.toHaveBeenCalled();
    vi.restoreAllMocks();

    const noEcho = fakeConn({
      supportsMultiline: () => true,
      sendMultiline,
      echoActive: () => false,
    });
    vi.spyOn(ircManager, 'getConnection').mockReturnValue(noEcho.conn);
    ircManager.send(userId, networkId, '#gate', 'a\nb');
    expect(noEcho.publish).toHaveBeenCalledTimes(1);
    expect(noEcho.publish.mock.calls[0][0]).toMatchObject({ text: 'a\nb', self: true });
  });

  it('the E2E branch keeps its optimistic plaintext publish even with echo active', () => {
    e2eManager.setChannelConfig(userId, networkId, '#e2egate', true, 'normal');
    const { conn, say, publish } = fakeConn();
    vi.spyOn(ircManager, 'getConnection').mockReturnValue(conn);
    ircManager.send(userId, networkId, '#e2egate', 'secret hello');
    // Ciphertext on the wire, exactly one readable self bubble locally.
    expect(say).toHaveBeenCalled();
    for (const [, line] of say.mock.calls) {
      expect(line.startsWith('+RPE2E01')).toBe(true);
    }
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0][0]).toMatchObject({
      text: 'secret hello',
      self: true,
      e2e: true,
    });
  });
});
