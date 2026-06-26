// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Phase 1c IRC wiring (#382): the seam between the E2eManager and live IRC
// traffic. These exercise the GLUE — does the outbound path put `+RPE2E01` on
// the wire while showing the sender plaintext; does an inbound chunk get
// decrypted (or a missing-key surfaced, not persisted as ciphertext); does a
// handshake CTCP ride NOTICE both ways; do the `/e2e …` commands dispatch. The
// crypto itself is pinned in server/services/e2e/*.test.ts, so we use real
// crypto for the new transport plumbing and spy the manager where only the
// routing decision is under test.

// MUST be first — redirect DATABASE_PATH before the static imports below open
// the real data/lurker.db.
import '../test-utils/isolateDb.js';
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { IrcConnection } from './ircConnection.js';
import ircManager from './ircManager.js';
import { e2eManager } from './e2e/manager.js';
import * as keyring from '../db/e2e.js';
import { createUser } from '../db/users.js';
import { createNetwork } from '../db/networks.js';

const CTCP = '';
const WIRE = '+RPE2E01';

// alice = the IrcConnection's account (user_id 1, network 1); bob = a remote
// peer with his own keyring identity (user_id 2). Both ride the process-wide
// e2eManager singleton, which keys all state by (userId, networkId).
beforeAll(() => {
  createUser('e2e-alice'); // id 1
  createUser('e2e-bob'); // id 2
  // The e2e keyring rows FK to users + networks, so seed both network ids too.
  createNetwork(1, { name: 'n', host: 'h', port: 6697, tls: true, nick: 'alice' }); // network id 1
  createNetwork(2, { name: 'n', host: 'h', port: 6697, tls: true, nick: 'bob' }); // network id 2
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

describe('outbound encrypt (ircManager.send)', () => {
  it('puts +RPE2E01 chunks on the wire but publishes the plaintext with an e2e flag', () => {
    const say = vi.fn<(target: string, text: string) => void>();
    const publish = vi.fn<(event: unknown) => void>();
    const fakeConn = {
      say,
      publish,
      client: { user: { nick: 'alice' } },
      supportsMultiline: () => false,
    } as unknown as IrcConnection;
    vi.spyOn(ircManager, 'getConnection').mockReturnValue(fakeConn);
    e2eManager.setChannelConfig(1, 1, '#enc', true, 'normal');

    const ok = ircManager.send(1, 1, '#enc', 'hello world');
    expect(ok).toBe(true);

    // Every wire line is ciphertext, never the cleartext.
    expect(say).toHaveBeenCalled();
    for (const [target, line] of say.mock.calls) {
      expect(target).toBe('#enc');
      expect(line.startsWith(WIRE)).toBe(true);
      expect(line).not.toContain('hello world');
    }
    // The sender sees exactly one readable bubble, flagged encrypted.
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'message',
        target: '#enc',
        text: 'hello world',
        e2e: true,
        self: true,
      }),
    );
    vi.restoreAllMocks();
  });

  it('falls through to a normal plaintext send when E2E is disabled for the channel', () => {
    const say = vi.fn<(target: string, text: string) => void>();
    const publish = vi.fn<(event: unknown) => void>();
    const fakeConn = {
      say,
      publish,
      client: { user: { nick: 'alice' } },
      supportsMultiline: () => false,
    } as unknown as IrcConnection;
    vi.spyOn(ircManager, 'getConnection').mockReturnValue(fakeConn);

    ircManager.send(1, 1, '#plain', 'hello world');

    expect(say).toHaveBeenCalledWith('#plain', 'hello world');
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'message', target: '#plain', text: 'hello world' }),
    );
    expect(publish.mock.calls[0][0]).not.toHaveProperty('e2e', true);
    vi.restoreAllMocks();
  });
});

describe('inbound decrypt (c.on message)', () => {
  // The decrypt path only fires on a channel with E2E enabled (#1) — enable #in
  // for the tests that exercise the decrypt branch.
  beforeAll(() => {
    e2eManager.setChannelConfig(1, 1, '#in', true, 'normal');
  });

  it('renders a decrypted chunk as plaintext with the e2e flag', () => {
    const conn = makeConn();
    const publish = vi.fn<(event: unknown) => void>();
    conn.publish = publish;
    vi.spyOn(e2eManager, 'decryptIncoming').mockReturnValue({ kind: 'plaintext', text: 'secret' });

    conn.client.emit('message', {
      nick: 'bob',
      ident: 'b',
      hostname: 'h',
      target: '#in',
      type: 'privmsg',
      message: `${WIRE} 00112233aabbccdd 0 1/1 nonce:ct`,
    });

    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ target: '#in', nick: 'bob', text: 'secret', e2e: true }),
    );
    vi.restoreAllMocks();
  });

  it('auto-initiates a handshake on a missing key and never persists ciphertext (repartee parity)', () => {
    const conn = makeConn();
    const publish = vi.fn<(event: unknown) => void>();
    const publishEphemeral = vi.fn<(event: unknown) => void>();
    const notice = vi.fn<(target: string, text: string) => void>();
    conn.publish = publish;
    conn.publishEphemeral = publishEphemeral;
    conn.client.notice = notice;
    vi.spyOn(e2eManager, 'decryptIncoming').mockReturnValue({ kind: 'missing-key' });

    // Fresh handle so the outgoing rate limiter (shared singleton) lets the
    // auto-KEYREQ through deterministically.
    conn.client.emit('message', {
      nick: 'autopeer',
      ident: 'ap',
      hostname: 'h',
      target: '#in',
      type: 'privmsg',
      message: `${WIRE} 00112233aabbccdd 0 1/1 nonce:ct`,
    });

    expect(publish).not.toHaveBeenCalled(); // ciphertext never persisted as a message
    // A KEYREQ NOTICE was auto-fired back to the sender's nick.
    expect(notice).toHaveBeenCalled();
    expect(notice.mock.calls[0][0]).toBe('autopeer');
    expect(notice.mock.calls[0][1]).toContain('RPEE2E KEYREQ');
    // …and the hint reflects that we're establishing, not telling the user to do it.
    expect(publishEphemeral.mock.calls[0][0]).toMatchObject({
      type: 'e2e',
      level: 'info',
      text: expect.stringContaining('establishing an encrypted session'),
    });
    vi.restoreAllMocks();
  });

  it('leaves a plain (non-RPE2E) channel message untouched', () => {
    const conn = makeConn();
    const publish = vi.fn<(event: unknown) => void>();
    conn.publish = publish;
    const spy = vi.spyOn(e2eManager, 'decryptIncoming');

    conn.client.emit('message', {
      nick: 'bob',
      ident: 'b',
      hostname: 'h',
      target: '#in',
      type: 'privmsg',
      message: 'just a normal line',
    });

    expect(spy).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ target: '#in', text: 'just a normal line' }),
    );
    expect(publish.mock.calls[0][0]).not.toHaveProperty('e2e', true);
    vi.restoreAllMocks();
  });

  it('does NOT attempt decryption on a channel without E2E enabled — passes it through (#1)', () => {
    const conn = makeConn();
    const publish = vi.fn<(event: unknown) => void>();
    conn.publish = publish;
    const spy = vi.spyOn(e2eManager, 'decryptIncoming');
    const line = `${WIRE} 00112233aabbccdd 0 1/1 nonce:ct`;

    conn.client.emit('message', {
      nick: 'bob',
      ident: 'b',
      hostname: 'h',
      target: '#notenabled', // never configured for E2E
      type: 'privmsg',
      message: line,
    });

    // The griefer line is rendered as ordinary cleartext, NOT dropped or decrypted.
    expect(spy).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ target: '#notenabled', text: line }),
    );
    expect(publish.mock.calls[0][0]).not.toHaveProperty('e2e', true);
    vi.restoreAllMocks();
  });

  it('collapses a multi-chunk undecryptable burst into a single hint (#3)', () => {
    e2eManager.setChannelConfig(1, 1, '#burst', true, 'normal');
    const conn = makeConn();
    conn.publish = vi.fn<(event: unknown) => void>();
    const publishEphemeral = vi.fn<(event: unknown) => void>();
    conn.publishEphemeral = publishEphemeral;
    conn.client.notice = vi.fn<(target: string, text: string) => void>(); // auto-handshake fires
    vi.spyOn(e2eManager, 'decryptIncoming').mockReturnValue({ kind: 'missing-key' });
    const emit = (part: number) =>
      conn.client.emit('message', {
        nick: 'bob',
        ident: 'b',
        hostname: 'h',
        target: '#burst',
        type: 'privmsg',
        message: `${WIRE} 00112233aabbccdd 0 ${part}/3 nonce:ct`,
      });

    emit(1);
    emit(2);
    emit(3);

    expect(publishEphemeral).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });
});

describe('egress refuses cleartext actions/notices on an E2E channel (#2)', () => {
  function fakeConn() {
    const action = vi.fn<(target: string, text: string) => void>();
    const notice = vi.fn<(target: string, text: string) => void>();
    const publish = vi.fn<(event: unknown) => void>();
    const publishEphemeral = vi.fn<(event: unknown) => void>();
    const conn = {
      action,
      notice,
      publish,
      publishEphemeral,
      client: { user: { nick: 'alice' } },
    } as unknown as IrcConnection;
    return { conn, action, notice, publishEphemeral };
  }

  it('blocks /me on an E2E-enabled channel without putting cleartext on the wire', () => {
    e2eManager.setChannelConfig(1, 1, '#secret', true, 'normal');
    const { conn, action, publishEphemeral } = fakeConn();
    vi.spyOn(ircManager, 'getConnection').mockReturnValue(conn);

    const ok = ircManager.action(1, 1, '#secret', 'waves');

    expect(ok).toBe(true);
    expect(action).not.toHaveBeenCalled(); // never reached the wire
    expect(publishEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'e2e', level: 'warn', target: '#secret' }),
    );
    vi.restoreAllMocks();
  });

  it('blocks /notice on an E2E-enabled channel', () => {
    e2eManager.setChannelConfig(1, 1, '#secret', true, 'normal');
    const { conn, notice, publishEphemeral } = fakeConn();
    vi.spyOn(ircManager, 'getConnection').mockReturnValue(conn);

    ircManager.notice(1, 1, '#secret', 'psst');

    expect(notice).not.toHaveBeenCalled();
    expect(publishEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'e2e', level: 'warn', target: '#secret' }),
    );
    vi.restoreAllMocks();
  });

  it('still sends /me normally on a non-E2E channel', () => {
    const { conn, action } = fakeConn();
    vi.spyOn(ircManager, 'getConnection').mockReturnValue(conn);

    ircManager.action(1, 1, '#plainchan', 'waves');

    expect(action).toHaveBeenCalledWith('#plainchan', 'waves');
    vi.restoreAllMocks();
  });
});

describe('handshake transport (c.on ctcp response)', () => {
  it('answers a real KEYREQ with a CTCP-framed KEYRSP NOTICE to the sender', () => {
    const conn = makeConn();
    const notice = vi.fn<(target: string, text: string) => void>();
    conn.client.notice = notice;
    conn.publishEphemeral = vi.fn<(event: unknown) => void>();
    e2eManager.setChannelConfig(1, 1, '#hs', true, 'auto-accept');

    // bob builds a genuine, signed KEYREQ from his own identity.
    const body = e2eManager.buildKeyReq(2, 2, '#hs');
    expect(body).toBeTruthy();

    conn.client.emit('ctcp response', {
      nick: 'bob',
      ident: 'b',
      hostname: 'h',
      target: '#hs',
      type: 'RPEE2E',
      message: body,
    });

    expect(notice).toHaveBeenCalled();
    const [target, line] = notice.mock.calls[0];
    expect(target).toBe('bob');
    expect(line.startsWith(`${CTCP}RPEE2E KEYRSP `)).toBe(true);
    expect(line.endsWith(CTCP)).toBe(true);
  });

  it('routes a handshake notice to the channel buffer when joined, else the server buffer', () => {
    const conn = makeConn();
    const publishEphemeral = vi.fn<(event: unknown) => void>();
    conn.publishEphemeral = publishEphemeral;
    conn.upsertChannel('#rt'); // we're in #rt

    conn.surfaceE2eNotice({ level: 'info', text: 'hi' }, '#rt');
    expect(publishEphemeral).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'e2e', level: 'info', target: '#rt', text: 'hi' }),
    );

    conn.surfaceE2eNotice({ level: 'warn', text: 'bye' }, '#notjoined');
    expect(publishEphemeral).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'e2e', level: 'warn', target: ':server:1' }),
    );
  });

  it('ignores a non-RPEE2E CTCP response without replying', () => {
    const conn = makeConn();
    const notice = vi.fn<(target: string, text: string) => void>();
    conn.client.notice = notice;

    conn.client.emit('ctcp response', {
      nick: 'someone',
      ident: 'i',
      hostname: 'h',
      type: 'VERSION',
      message: 'VERSION SomeClient 1.0',
    });

    expect(notice).not.toHaveBeenCalled();
  });
});

describe('/e2e command dispatch (runE2eCommand)', () => {
  it('on <#chan> <mode> writes the channel config', () => {
    const conn = makeConn();
    conn.publishEphemeral = vi.fn<(event: unknown) => void>();
    conn.runE2eCommand('#cmd', 'on #cmd auto');
    const cfg = keyring.getChannelConfig(1, 1, '#cmd');
    expect(cfg?.enabled).toBe(true);
    expect(cfg?.mode).toBe('auto-accept');
  });

  it('fingerprint reports the account identity', () => {
    const conn = makeConn();
    const publishEphemeral = vi.fn<(event: unknown) => void>();
    conn.publishEphemeral = publishEphemeral;
    conn.runE2eCommand(':server:1', 'fingerprint');
    const texts = publishEphemeral.mock.calls.map((c) => (c[0] as { text: string }).text);
    expect(texts.some((t) => t.includes('your fingerprint'))).toBe(true);
  });

  it('handshake <nick> sends a CTCP-framed KEYREQ NOTICE from the issuing channel', () => {
    const conn = makeConn();
    conn.publishEphemeral = vi.fn<(event: unknown) => void>();
    const notice = vi.fn<(target: string, text: string) => void>();
    conn.client.notice = notice;
    conn.runE2eCommand('#cmd', 'handshake carol');
    expect(notice).toHaveBeenCalled();
    const [target, line] = notice.mock.calls[0];
    expect(target).toBe('carol');
    expect(line.startsWith(`${CTCP}RPEE2E KEYREQ `)).toBe(true);
  });

  it('rejects a channel op issued without a channel', () => {
    const conn = makeConn();
    const publishEphemeral = vi.fn<(event: unknown) => void>();
    conn.publishEphemeral = publishEphemeral;
    conn.runE2eCommand(':server:1', 'on');
    expect(publishEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'e2e', level: 'warn' }),
    );
  });
});

// ─── Phase 1d: the expanded /e2e command surface (repartee parity) ───────────

describe('/e2e command surface — 1d', () => {
  const texts = (m: ReturnType<typeof vi.fn>) =>
    m.mock.calls.map((c) => (c[0] as { text: string }).text);

  it('mode changes a channel mode while preserving enabled', () => {
    const conn = makeConn();
    conn.publishEphemeral = vi.fn<(event: unknown) => void>();
    conn.runE2eCommand('#mode1', 'on #mode1 normal');
    conn.runE2eCommand('#mode1', 'mode auto');
    expect(keyring.getChannelConfig(1, 1, '#mode1')?.mode).toBe('auto-accept');
    expect(keyring.getChannelConfig(1, 1, '#mode1')?.enabled).toBe(true);
  });

  it('mode rejects an unknown mode', () => {
    const conn = makeConn();
    const pe = vi.fn<(event: unknown) => void>();
    conn.publishEphemeral = pe;
    conn.runE2eCommand('#mode2', 'mode bogus');
    expect(pe).toHaveBeenCalledWith(expect.objectContaining({ type: 'e2e', level: 'warn' }));
  });

  it('on rejects an unknown mode token instead of silently falling back to normal', () => {
    const conn = makeConn();
    const pe = vi.fn<(event: unknown) => void>();
    conn.publishEphemeral = pe;
    conn.runE2eCommand('#onbad', 'on #onbad quite'); // typo for "quiet"
    expect(pe).toHaveBeenCalledWith(expect.objectContaining({ type: 'e2e', level: 'warn' }));
    expect(keyring.getChannelConfig(1, 1, '#onbad')).toBeNull(); // not enabled
  });

  it('list reports no trusted peers on a fresh channel', () => {
    const conn = makeConn();
    const pe = vi.fn<(event: unknown) => void>();
    conn.publishEphemeral = pe;
    conn.runE2eCommand('#list1', 'list');
    expect(texts(pe).some((t) => t.includes('no trusted peers'))).toBe(true);
  });

  it('autotrust add / list / remove round-trips through the keyring', () => {
    const conn = makeConn();
    conn.publishEphemeral = vi.fn<(event: unknown) => void>();
    conn.runE2eCommand(':server:1', 'autotrust add global *@trusted.example');
    expect(
      e2eManager.listAutotrust(1, 1).some((r) => r.handlePattern === '*@trusted.example'),
    ).toBe(true);
    conn.runE2eCommand(':server:1', 'autotrust remove *@trusted.example');
    expect(
      e2eManager.listAutotrust(1, 1).some((r) => r.handlePattern === '*@trusted.example'),
    ).toBe(false);
  });

  it('autotrust remove matches case-insensitively (rules apply case-insensitively)', () => {
    const conn = makeConn();
    conn.publishEphemeral = vi.fn<(event: unknown) => void>();
    conn.runE2eCommand(':server:1', 'autotrust add global *@CaseHost.Example');
    // Remove with different casing — must still find + delete the rule.
    conn.runE2eCommand(':server:1', 'autotrust remove *@casehost.example');
    expect(
      e2eManager.listAutotrust(1, 1).some((r) => r.handlePattern === '*@CaseHost.Example'),
    ).toBe(false);
  });

  it('autotrust add rejects a scope that is neither global nor a #channel', () => {
    const conn = makeConn();
    const pe = vi.fn<(event: unknown) => void>();
    conn.publishEphemeral = pe;
    conn.runE2eCommand(':server:1', 'autotrust add globl *@x'); // typo for "global"
    expect(pe).toHaveBeenCalledWith(expect.objectContaining({ type: 'e2e', level: 'warn' }));
    expect(e2eManager.listAutotrust(1, 1).some((r) => r.scope === 'globl')).toBe(false);
  });

  it('help lists the command surface', () => {
    const conn = makeConn();
    const pe = vi.fn<(event: unknown) => void>();
    conn.publishEphemeral = pe;
    conn.runE2eCommand(':server:1', 'help');
    const joined = texts(pe).join('\n');
    expect(joined).toContain('/e2e commands');
    expect(joined).toContain('autotrust');
  });

  it('an empty /e2e shows help, an unknown sub warns', () => {
    const conn = makeConn();
    const pe = vi.fn<(event: unknown) => void>();
    conn.publishEphemeral = pe;
    conn.runE2eCommand(':server:1', '');
    expect(texts(pe).join('\n')).toContain('/e2e commands');
    pe.mockClear();
    conn.runE2eCommand(':server:1', 'frobnicate');
    expect(pe).toHaveBeenCalledWith(expect.objectContaining({ type: 'e2e', level: 'warn' }));
  });
});

describe('E2eManager 1d management methods', () => {
  it('decline drops a PENDING inbound prompt channel-scoped, without globally revoking the peer', () => {
    // A fresh identity (zed = user 3) so its fingerprint isn't already pinned by
    // another test under a different handle (which would TOFU-block the KEYREQ).
    const zed = createUser('e2e-zed').id;
    e2eManager.setChannelConfig(1, 1, '#dz', true, 'normal'); // normal mode → caches a prompt
    const req = e2eManager.buildKeyReq(zed, zed, '#dz')!;
    const out = e2eManager.handleHandshakeBody(1, 1, '~zed@h', 'zed', req)!;
    expect(out.notice?.text).toMatch(/accept/); // the normal-mode prompt was cached

    // Decline drops the cached prompt — but must NOT globally revoke the peer
    // (that would cut them off on every other channel, and a later /e2e unrevoke
    // could then launder this never-verified peer into 'trusted').
    expect(e2eManager.declinePeer(1, 1, '~zed@h', '#dz')).toBe(true);
    expect(keyring.getPeerByHandle(1, 1, '~zed@h')?.globalStatus).not.toBe('revoked');
    // Declining again with nothing pending is a no-op.
    expect(e2eManager.declinePeer(1, 1, '~zed@h', '#dz')).toBe(false);
    // unrevoke can't promote a peer that was never revoked.
    expect(e2eManager.unrevokePeer(1, 1, '~zed@h')).toBe(false);
  });

  it('unrevoke restores a peer that was revoked via /e2e revoke', () => {
    const fp = new Uint8Array(16).fill(31);
    keyring.upsertPeer(1, 1, {
      fingerprint: fp,
      pubkey: new Uint8Array(32).fill(32),
      lastHandle: '~rv@h',
      lastNick: 'rv',
      firstSeen: 1,
      lastSeen: 1,
      globalStatus: 'trusted',
    });
    expect(e2eManager.revokePeer(1, 1, '~rv@h')).toBe(true);
    expect(keyring.getPeerByHandle(1, 1, '~rv@h')?.globalStatus).toBe('revoked');
    expect(e2eManager.unrevokePeer(1, 1, '~rv@h')).toBe(true);
    expect(keyring.getPeerByHandle(1, 1, '~rv@h')?.globalStatus).toBe('trusted');
    expect(e2eManager.unrevokePeer(1, 1, '~rv@h')).toBe(false); // already trusted
  });

  it('decline with nothing pending does NOT revoke an established peer (review #408)', () => {
    const fp = new Uint8Array(16).fill(21);
    keyring.upsertPeer(1, 1, {
      fingerprint: fp,
      pubkey: new Uint8Array(32).fill(22),
      lastHandle: '~steady@h',
      lastNick: 'steady',
      firstSeen: 1,
      lastSeen: 1,
      globalStatus: 'trusted',
    });
    expect(e2eManager.declinePeer(1, 1, '~steady@h', '#nope')).toBe(false);
    expect(keyring.getPeerByHandle(1, 1, '~steady@h')?.globalStatus).toBe('trusted');
  });

  it('channelStatus reports enabled, mode, and peer count', () => {
    e2eManager.setChannelConfig(1, 1, '#cs', true, 'quiet');
    expect(e2eManager.channelStatus(1, 1, '#cs')).toMatchObject({
      enabled: true,
      mode: 'quiet',
      peers: 0,
    });
  });

  it('listKeyring returns remembered peers without unsealing keys', () => {
    const fp = new Uint8Array(16).fill(3);
    const pub = new Uint8Array(32).fill(4);
    keyring.upsertPeer(1, 1, {
      fingerprint: fp,
      pubkey: pub,
      lastHandle: '~kit@h',
      lastNick: 'kit',
      firstSeen: 1,
      lastSeen: 1,
      globalStatus: 'trusted',
    });
    const { peers } = e2eManager.listKeyring(1, 1);
    expect(peers.some((p) => p.handle === '~kit@h' && p.status === 'trusted')).toBe(true);
  });

  it('forgetPeer wipes the identity pin + sessions for a handle', () => {
    const fp = new Uint8Array(16).fill(5);
    const pub = new Uint8Array(32).fill(6);
    keyring.upsertPeer(1, 1, {
      fingerprint: fp,
      pubkey: pub,
      lastHandle: '~gone@oldhost',
      lastNick: 'gone',
      firstSeen: 1,
      lastSeen: 1,
      globalStatus: 'trusted',
    });
    expect(e2eManager.forgetPeer(1, 1, '~gone@oldhost')).toBeGreaterThan(0);
    expect(keyring.getPeerByHandle(1, 1, '~gone@oldhost')).toBeNull();
  });

  it('forgetPeerOnChannel reports cleared when it only drops a pending prompt (no session yet)', () => {
    // A fresh identity so its fp isn't pinned elsewhere (would TOFU-block the KEYREQ).
    const pim = createUser('e2e-pim').id;
    e2eManager.setChannelConfig(1, 1, '#fp', true, 'normal'); // normal mode → caches a prompt
    const req = e2eManager.buildKeyReq(pim, pim, '#fp')!;
    const out = e2eManager.handleHandshakeBody(1, 1, '~pim@h', 'pim', req)!;
    expect(out.notice?.text).toMatch(/accept/); // a prompt was cached, no session installed
    // Forgetting the channel must report it cleared the prompt, not "nothing remembered".
    expect(e2eManager.forgetPeerOnChannel(1, 1, '~pim@h', '#fp')).toBe(true);
    // …and a second forget now has nothing to clear.
    expect(e2eManager.forgetPeerOnChannel(1, 1, '~pim@h', '#fp')).toBe(false);
  });
});

describe('/e2e forget + literal-handle resolution (departed peers)', () => {
  it('forget -all <ident@host> clears a peer who is NOT in the channel', () => {
    const fp = new Uint8Array(16).fill(8);
    const pub = new Uint8Array(32).fill(8);
    keyring.upsertPeer(1, 1, {
      fingerprint: fp,
      pubkey: pub,
      lastHandle: '~left@somehost',
      lastNick: 'left',
      firstSeen: 1,
      lastSeen: 1,
      globalStatus: 'trusted',
    });
    const conn = makeConn(); // no channel membership for the peer
    const pe = vi.fn<(event: unknown) => void>();
    conn.publishEphemeral = pe;

    // Passed as a literal handle (contains '@') — no nick resolution needed.
    conn.runE2eCommand('#fgt', 'forget -all ~left@somehost');

    expect(keyring.getPeerByHandle(1, 1, '~left@somehost')).toBeNull();
    const joined = pe.mock.calls.map((c) => (c[0] as { text: string }).text).join('\n');
    expect(joined).toContain('forgot ~left@somehost everywhere');
  });

  it('a bare nick that is not in the channel warns to pass the handle', () => {
    const conn = makeConn();
    const pe = vi.fn<(event: unknown) => void>();
    conn.publishEphemeral = pe;
    conn.runE2eCommand('#fgt', 'forget -all nobodyhere');
    expect(pe).toHaveBeenCalledWith(expect.objectContaining({ type: 'e2e', level: 'warn' }));
    expect(pe.mock.calls.map((c) => (c[0] as { text: string }).text).join('\n')).toContain(
      'ident@host',
    );
  });
});
