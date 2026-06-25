// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// MUST be first: redirects DATABASE_PATH to a throwaway file before the static
// import of ircConnection.js below pulls in db/index.js (which opens its file
// at module-load time). Without this, the IrcConnections built in these tests
// write straight into the real data/lurker.db.
import '../test-utils/isolateDb.js';
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import net from 'net';
import { ircLineParser } from 'irc-framework';
import type { ConnectOptions } from 'irc-framework';
import {
  IrcConnection,
  canonicalChannelTarget,
  computeFallbackNick,
  formatSocketCloseErrorMessage,
  formatUnknownNumeric,
  formatWhoReplyLine,
  isOverloadedSpeakRejection,
  isServerBufferDeniedNumeric,
  joinRejectionMessage,
  joinRejectionMessageByTag,
  sendRejectionTargetKind,
  sendRejectionText,
  outgoingAddr,
} from './ircConnection.js';
import { createIdentdServer, unregisterIdent } from './identd.js';
import { getRecent } from './systemLog.js';
import { createUser } from '../db/users.js';
import { createNetwork } from '../db/networks.js';
import { setUserSetting, deleteUserSetting } from '../db/settings.js';

// The bare IrcConnections built below carry user_id: 1, and their join/part
// handlers write system_messages (FK → users.id). Seed user id 1 in the
// isolated DB so those incidental writes satisfy the constraint. (These writes
// used to land in the real data/lurker.db, which already had user 1 — that
// silent leak is what isolateDb.ts now prevents.)
beforeAll(() => {
  createUser('ircconn-test');
});

describe('computeFallbackNick', () => {
  it('appends 1..9 in order', () => {
    expect(computeFallbackNick('bob', 0)).toBe('bob1');
    expect(computeFallbackNick('bob', 1)).toBe('bob2');
    expect(computeFallbackNick('bob', 8)).toBe('bob9');
  });

  it('returns null once the ladder is exhausted', () => {
    expect(computeFallbackNick('bob', 9)).toBeNull();
    expect(computeFallbackNick('bob', 100)).toBeNull();
  });

  it('rejects negative indices', () => {
    expect(computeFallbackNick('bob', -1)).toBeNull();
  });

  it('returns null for missing base', () => {
    expect(computeFallbackNick('', 0)).toBeNull();
    expect(computeFallbackNick(null, 0)).toBeNull();
    expect(computeFallbackNick(undefined, 0)).toBeNull();
  });

  it('preserves nicks that already end in digits', () => {
    expect(computeFallbackNick('bob1', 0)).toBe('bob11');
    expect(computeFallbackNick('bob1', 8)).toBe('bob19');
  });
});

describe('isServerBufferDeniedNumeric (#342)', () => {
  it('denies numerics another handler already renders or that would flood', () => {
    // MOTD block, /LIST (cached off-wire), auto-WHO replies, MONITOR presence,
    // and nick-collision errors are surfaced elsewhere — the raw handler skips
    // them so they aren't duplicated in the server buffer.
    for (const n of [
      '372',
      '375',
      '376',
      '422', // MOTD
      '321',
      '322',
      '323', // /LIST
      '352',
      '315',
      '354', // WHO
      '730',
      '731',
      '732',
      '733', // MONITOR
      '432',
      '433', // nick collision
    ]) {
      expect(isServerBufferDeniedNumeric(n)).toBe(true);
    }
  });

  it('shows everything else by default — there is no curated allowlist', () => {
    // The whole point of #342: greeting, whois, oper, time, names, topic and
    // even ISUPPORT all fall through to the raw renderer instead of vanishing.
    for (const n of [
      '001',
      '002',
      '004',
      '005',
      '251',
      '255',
      '265',
      '311',
      '319',
      '381',
      '391',
      '353',
      '332',
      '364',
    ]) {
      expect(isServerBufferDeniedNumeric(n)).toBe(false);
    }
  });
});

describe('formatWhoReplyLine (#342)', () => {
  it('reconstructs a readable /who line from a wholist user', () => {
    expect(
      formatWhoReplyLine({
        nick: 'alice',
        ident: '~alice',
        hostname: 'user/alice',
        server: 'tungsten.libera.chat',
        real_name: 'Alice Example',
        channel: '#lurker',
        away: false,
      }),
    ).toBe('#lurker alice (~alice@user/alice) tungsten.libera.chat — Alice Example');
  });

  it('marks away users', () => {
    expect(formatWhoReplyLine({ nick: 'bob', ident: 'bob', hostname: 'h', away: true })).toBe(
      'bob (bob@h) away',
    );
  });

  it('tolerates a sparse entry and rejects a malformed one', () => {
    expect(formatWhoReplyLine({ nick: 'carol' })).toBe('carol');
    expect(formatWhoReplyLine({})).toBeNull();
    expect(formatWhoReplyLine(null)).toBeNull();
  });

  it('never emits a dangling @ when only ident or only host is present', () => {
    expect(formatWhoReplyLine({ nick: 'dave', hostname: 'h' })).toBe('dave (h)');
    expect(formatWhoReplyLine({ nick: 'erin', ident: 'erin' })).toBe('erin (erin)');
  });
});

// The universal server-buffer renderer (#342): drop the leading recipient-nick
// param, join the rest. The 'raw' handler runs this on every non-denied numeric.
const fmtUnknown = (line: string) => formatUnknownNumeric(ircLineParser(line));

describe('formatUnknownNumeric', () => {
  it('renders RPL_TIME (391) — the canonical dropped reply', () => {
    expect(
      fmtUnknown(':irc.dal.net 391 nick irc.dal.net :Sunday June 12 2026 -- 16:30:00 +0000'),
    ).toBe('irc.dal.net Sunday June 12 2026 -- 16:30:00 +0000');
  });

  it('joins the spread params of RPL_VERSION (351)', () => {
    expect(fmtUnknown(':srv 351 nick bahamut-2.1.4 irc.dal.net :booted Tue')).toBe(
      'bahamut-2.1.4 irc.dal.net booted Tue',
    );
  });

  it('renders the welcome banner (001) — formerly an allowlist-only numeric', () => {
    // No more curated allowlist: greeting numerics flow through this one path.
    expect(fmtUnknown(':srv 001 nick :Welcome to the network nick')).toBe(
      'Welcome to the network nick',
    );
  });

  it('renders WHOIS/WHOWAS family lines, stripping the routing nick (#281, #342)', () => {
    // irc-framework consumes these into the 'whois'/'whowas' events (which drive
    // the profile modal); the raw handler still logs the wire line here.
    expect(fmtUnknown(':srv 311 you alice ~alice user/alice * :Alice Example')).toBe(
      'alice ~alice user/alice * Alice Example',
    );
    expect(fmtUnknown(':srv 318 you alice :End of /WHOIS list.')).toBe('alice End of /WHOIS list.');
    expect(fmtUnknown(':srv 314 you Ghost ~ghost old.example.net * :A Spooky User')).toBe(
      'Ghost ~ghost old.example.net * A Spooky User',
    );
  });

  it('renders /oper success (381) — was silently dropped before #342', () => {
    expect(fmtUnknown(':srv 381 nick :You are now an IRC operator')).toBe(
      'You are now an IRC operator',
    );
  });

  it('stays quiet on non-numeric command words', () => {
    expect(fmtUnknown(':srv FOOBAR nick :something')).toBeNull();
  });

  it('returns null when only the recipient-nick param is present', () => {
    expect(fmtUnknown(':srv 391 nick')).toBeNull();
  });

  it('returns null for bad input', () => {
    expect(formatUnknownNumeric(null)).toBeNull();
    expect(formatUnknownNumeric({ command: '', params: [] })).toBeNull();
  });
});

describe('join-rejection messages (#260)', () => {
  it('maps the unmapped-numeric rejections (476/477) by numeric', () => {
    expect(joinRejectionMessage('477')).toBe('This channel requires a registered nickname.');
    expect(joinRejectionMessage('476')).toBe('Bad channel mask.');
    expect(joinRejectionMessage('473')).toBe('This channel is invite-only.');
  });

  it('maps the irc-framework-modeled rejections by error tag', () => {
    expect(joinRejectionMessageByTag('invite_only_channel')).toBe('This channel is invite-only.');
    expect(joinRejectionMessageByTag('banned_from_channel')).toBe(
      'You are banned from this channel.',
    );
    expect(joinRejectionMessageByTag('channel_is_full')).toBe('This channel is full.');
    expect(joinRejectionMessageByTag('bad_channel_key')).toBe(
      'This channel requires a key (password).',
    );
    expect(joinRejectionMessageByTag('too_many_channels')).toBe(
      'You have joined too many channels.',
    );
  });

  it('returns null for non-join errors so they fall through to normal handling', () => {
    expect(joinRejectionMessage('421')).toBeNull(); // ERR_UNKNOWNCOMMAND
    expect(joinRejectionMessage('001')).toBeNull();
    expect(joinRejectionMessageByTag('no_such_nick')).toBeNull();
    expect(joinRejectionMessageByTag('password_mismatch')).toBeNull();
  });
});

describe('send-rejection routing (#283)', () => {
  it('maps the irc-framework send-rejection tags to the buffer that owns them', () => {
    // 404 ERR_CANNOTSENDTOCHAN → the channel; 531 ERR_CANNOTSENDTOUSER → the DM peer.
    expect(sendRejectionTargetKind('cannot_send_to_channel')).toBe('channel');
    expect(sendRejectionTargetKind('cannot_send_to_user')).toBe('nick');
  });

  it('returns null for tags that are not send rejections', () => {
    // Join rejections and unrelated errors must stay on their own paths.
    expect(sendRejectionTargetKind('invite_only_channel')).toBeNull();
    expect(sendRejectionTargetKind('no_such_nick')).toBeNull();
    expect(sendRejectionTargetKind('irc')).toBeNull();
  });

  it('treats 477 as a speak rejection only when we are already in the channel', () => {
    // ERR_NEEDREGGEDNICK is overloaded: a join refusal when we're not in the
    // channel, a speak refusal when we are. Only the latter is a send rejection.
    expect(isOverloadedSpeakRejection('477', true)).toBe(true);
    expect(isOverloadedSpeakRejection('477', false)).toBe(false);
  });

  it('never treats other numerics as overloaded speak rejections', () => {
    // 473 (invite-only) and 404 (cannot-send, handled via the tag path) must not
    // get swept into the 477 disambiguation even if we happen to be in-channel.
    expect(isOverloadedSpeakRejection('473', true)).toBe(false);
    expect(isOverloadedSpeakRejection('404', true)).toBe(false);
  });

  it('leads with the server reason, falling back to a generic hint', () => {
    expect(sendRejectionText('You need to be identified to speak')).toBe(
      'Message not delivered — You need to be identified to speak',
    );
    // Missing/blank reasons still tell the user the message did not land.
    expect(sendRejectionText(null)).toMatch(/^Message not delivered —/);
    expect(sendRejectionText('   ')).toMatch(/^Message not delivered —/);
  });
});

describe('canonicalChannelTarget (#268)', () => {
  // this.channels is keyed lowercase; .name holds the case we joined with.
  const channels = new Map([['#christian', { name: '#christian' }]]);

  it('maps a server-relayed differently-cased channel onto the joined case', () => {
    expect(canonicalChannelTarget('#Christian', channels)).toBe('#christian');
    expect(canonicalChannelTarget('#CHRISTIAN', channels)).toBe('#christian');
  });

  it('leaves the already-canonical case untouched', () => {
    expect(canonicalChannelTarget('#christian', channels)).toBe('#christian');
  });

  it('passes through channels we are not in', () => {
    expect(canonicalChannelTarget('#elsewhere', channels)).toBe('#elsewhere');
  });

  it('passes through non-channel targets (DMs, server buffer, undefined)', () => {
    expect(canonicalChannelTarget('SomeNick', channels)).toBe('SomeNick');
    expect(canonicalChannelTarget(':server:7', channels)).toBe(':server:7');
    expect(canonicalChannelTarget(undefined, channels)).toBeUndefined();
  });
});

describe('tls certificate trust setting', () => {
  function makeConn(trusted_certificates: number): IrcConnection {
    return new IrcConnection({
      network: {
        id: 1,
        user_id: 1,
        name: 'n',
        host: 'irc.example.test',
        port: 6697,
        tls: 1,
        trusted_certificates,
        nick: 'nick',
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

  it('passes rejectUnauthorized based on trusted_certificates', () => {
    const trusted = makeConn(1);
    const untrusted = makeConn(0);
    trusted.publish = vi.fn<(event: unknown) => void>();
    untrusted.publish = vi.fn<(event: unknown) => void>();
    const trustedConnect = vi.fn<(options: ConnectOptions) => void>();
    const untrustedConnect = vi.fn<(options: ConnectOptions) => void>();
    trusted.client.connect = trustedConnect;
    untrusted.client.connect = untrustedConnect;

    trusted.connect();
    untrusted.connect();

    expect(trustedConnect).toHaveBeenCalledWith(
      expect.objectContaining({ tls: true, rejectUnauthorized: true }),
    );
    expect(untrustedConnect).toHaveBeenCalledWith(
      expect.objectContaining({ tls: true, rejectUnauthorized: false }),
    );
  });

  it('logNet writes a system line scoped to the network and stamped with its id (#355)', async () => {
    const conn = makeConn(1); // network { id: 1, user_id: 1, name: 'n' }
    conn.logNet('a unique test line', 'warn');
    const sys = (await import('../db/systemMessages.js')).default;
    const row = sys.recent(1).find((r) => r.text === 'a unique test line');
    expect(row).toBeTruthy();
    expect(row!.scope).toBe('net:n'); // logScope() = net:<current name>
    expect(row!.level).toBe('warn');
    expect(row!.fields).toMatchObject({ networkId: 1 }); // stable id for live name resolution
  });
});

describe('addPeerWatch live presence seed (#302)', () => {
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
        nick: 'nick',
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

  // A friend added while connected must get a MONITOR S follow-up: the server
  // only SHOULD (not MUST) volunteer current state in reply to MONITOR +, so
  // without the explicit status query a freshly-added offline friend lands with
  // no state and renders as if online until a reconnect re-seeds.
  it('follows MONITOR + with MONITOR S when a friend is tracked on a live connection', () => {
    const conn = makeConn();
    conn.useMonitor = true;
    conn.monitorLimit = 100;
    conn.state = 'connected';
    const raw = vi.fn<(...args: string[]) => void>();
    conn.client.raw = raw;

    conn.trackFriend('offlinepal', 42);

    // Order matters: the nick must be added before MONITOR S, or the status
    // dump won't include it.
    expect(raw.mock.calls.map((c) => c[0])).toEqual(['MONITOR + offlinepal', 'MONITOR S']);
  });

  it('issues no MONITOR traffic when the server does not support it', () => {
    const conn = makeConn();
    conn.useMonitor = false;
    conn.state = 'connected';
    const raw = vi.fn<(...args: string[]) => void>();
    conn.client.raw = raw;

    conn.trackFriend('offlinepal', 42);

    expect(raw).not.toHaveBeenCalled();
  });
});

describe('nick-regain MONITOR teardown gating (#384)', () => {
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
        nick: 'nick',
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

  // Repro for #384: we connected under a fallback nick (the configured nick was
  // taken, so a regain watch is armed) on a server with no MONITOR, then the
  // user changes nick. The self-nick handler tears the regain watch down — but
  // the matching `MONITOR +` was never sent (it's gated on useMonitor), so a
  // blind `MONITOR -` here only earns a 421 "MONITOR Unknown command" banner.
  it('sends no MONITOR - on a self-nick change when the server lacks MONITOR', () => {
    const conn = makeConn();
    conn.useMonitor = false;
    conn.state = 'connected';
    conn.regainNick = 'nick'; // the primary we still want back
    conn.pendingRegainSetup = true;
    conn.client.user.nick = 'nick1'; // currently on the fallback
    conn.publish = vi.fn<(event: unknown) => void>(); // we assert on the wire, not the buffer
    const raw = vi.fn<(...args: unknown[]) => void>();
    conn.client.raw = raw;

    // Reclaim the primary: old nick 'nick1' (our current), new nick 'nick'.
    conn.client.emit('nick', { nick: 'nick1', new_nick: 'nick' });

    expect(raw.mock.calls.flat(Infinity).join(' ')).not.toContain('MONITOR');
    expect(conn.regainNick).toBeNull(); // watch state is still cleared
  });

  // On a MONITOR-capable server the teardown must still fire, releasing the
  // server-side watch for the (now reclaimed) regain nick.
  it('still sends MONITOR - on a self-nick change when the server supports MONITOR', () => {
    const conn = makeConn();
    conn.useMonitor = true;
    conn.monitorLimit = 100;
    conn.state = 'connected';
    conn.regainNick = 'nick';
    conn.pendingRegainSetup = false;
    conn.client.user.nick = 'nick1';
    conn.publish = vi.fn<(event: unknown) => void>();
    const raw = vi.fn<(...args: unknown[]) => void>();
    conn.client.raw = raw;

    conn.client.emit('nick', { nick: 'nick1', new_nick: 'nick' });

    // removeMonitor() emits the line as args: ['MONITOR', '-', 'nick'].
    expect(raw.mock.calls.flat(Infinity).join(' ')).toContain('MONITOR - nick');
    expect(conn.regainNick).toBeNull();
  });
});

describe('formatSocketCloseErrorMessage', () => {
  const where = 'irc.example.test:6697';

  it('rewrites self-signed certificate failures with a user-friendly setting hint', () => {
    expect(
      formatSocketCloseErrorMessage(
        {
          code: 'DEPTH_ZERO_SELF_SIGNED_CERT',
          message:
            'self-signed certificate; if the root CA is installed locally, try running Node.js with --use-system-ca',
        },
        where,
        true,
      ),
    ).toBe(
      `Connection failed (${where}): The server certificate could not be verified. To connect anyway, uncheck "Only allow trusted certificates" in this network's settings and reconnect.`,
    );
  });

  it('rewrites expired certificate failures with the same user-friendly hint', () => {
    expect(
      formatSocketCloseErrorMessage(
        {
          code: 'CERT_HAS_EXPIRED',
          message: 'certificate has expired',
        },
        where,
        true,
      ),
    ).toBe(
      `Connection failed (${where}): The server certificate could not be verified. To connect anyway, uncheck "Only allow trusted certificates" in this network's settings and reconnect.`,
    );
  });

  it('rewrites untrusted chain certificate failures with the same user-friendly hint', () => {
    expect(
      formatSocketCloseErrorMessage(
        {
          code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
          message: 'unable to verify the first certificate',
        },
        where,
        true,
      ),
    ).toBe(
      `Connection failed (${where}): The server certificate could not be verified. To connect anyway, uncheck "Only allow trusted certificates" in this network's settings and reconnect.`,
    );
  });

  it('rewrites hostname mismatch certificate failures with the same user-friendly hint', () => {
    expect(
      formatSocketCloseErrorMessage(
        {
          code: 'ERR_TLS_CERT_ALTNAME_INVALID',
          message: "Hostname/IP does not match certificate's altnames",
        },
        where,
        true,
      ),
    ).toBe(
      `Connection failed (${where}): The server certificate could not be verified. To connect anyway, uncheck "Only allow trusted certificates" in this network's settings and reconnect.`,
    );
  });

  it('keeps non-certificate errors unchanged', () => {
    expect(
      formatSocketCloseErrorMessage(
        { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:6697' },
        where,
        true,
      ),
    ).toBe(`Connection failed (${where}): ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:6697`);
  });
});

// End-to-end check that the real irc-framework event handlers route refused
// outgoing messages to the right buffer (#283). publish/publishEphemeral are
// stubbed so we can assert the routing decision without a DB or a live socket.
describe('refused-message handler routing (#283)', () => {
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
        nick: 'nick',
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

  it('routes ERR_CANNOTSENDTOCHAN (404) inline to the channel the user just sent to', () => {
    const conn = makeConn();
    const publish = vi.fn<(event: unknown) => void>();
    conn.publish = publish;
    conn.client.say = vi.fn<(target: string, message: string) => void>(); // don't touch a real socket
    conn.say('#anime', 'hi'); // a real message — its bounce should surface

    conn.client.emit('irc error', {
      error: 'cannot_send_to_channel',
      channel: '#anime',
      reason: 'You need to be identified to talk',
    });

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        target: '#anime',
        text: 'Message not delivered — You need to be identified to talk',
      }),
    );
  });

  it('routes ERR_CANNOTSENDTOUSER (531) inline to the DM peer the user just messaged', () => {
    const conn = makeConn();
    const publish = vi.fn<(event: unknown) => void>();
    conn.publish = publish;
    conn.noteUserSend('sleepynick'); // user just sent them a message

    conn.client.emit('irc error', {
      error: 'cannot_send_to_user',
      nick: 'sleepynick',
      reason: 'Cannot send to user',
    });

    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', target: 'sleepynick' }),
    );
  });

  it('surfaces 477 inline as a speak rejection when we are already in the channel', () => {
    const conn = makeConn();
    conn.upsertChannel('#anime'); // we joined it — so 477 can only be a speak refusal
    const publish = vi.fn<(event: unknown) => void>();
    const publishEphemeral = vi.fn<(event: unknown) => void>();
    conn.publish = publish;
    conn.publishEphemeral = publishEphemeral;
    conn.noteUserSend('#anime'); // a real message — its bounce should surface

    conn.client.emit('unknown command', {
      command: '477',
      params: ['nick', '#anime', 'You need to be identified to speak'],
    });

    expect(publishEphemeral).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        target: '#anime',
        text: 'Message not delivered — You need to be identified to speak',
      }),
    );
  });

  it('stays silent about a refused typing notification, suppresses further typing, and heals on login', () => {
    const conn = makeConn();
    conn.upsertChannel('#anime');
    const publish = vi.fn<(event: unknown) => void>();
    conn.publish = publish;
    // Enable the message-tags cap and capture outgoing TAGMSGs.
    (conn.client as unknown as { network: { cap: { enabled: string[] } } }).network = {
      cap: { enabled: ['message-tags'] },
    };
    const tagmsg = vi.fn<(target: string, tags?: Record<string, string>) => void>();
    conn.client.tagmsg = tagmsg;

    // First typing notification goes out — we haven't learned the channel is blocked.
    conn.sendTyping('#anime', 'active');
    expect(tagmsg).toHaveBeenCalledTimes(1);

    // The server bounces it. No real message was sent, so nothing surfaces inline.
    conn.client.emit('unknown command', {
      command: '477',
      params: ['nick', '#anime', 'You need to be identified to speak'],
    });
    expect(publish).not.toHaveBeenCalled();

    // Further typing to that channel is now suppressed (no more bounces).
    conn.sendTyping('#anime', 'active');
    expect(tagmsg).toHaveBeenCalledTimes(1);

    // Identifying to services (RPL_LOGGEDIN → 'loggedin') lifts the suppression.
    conn.client.emit('loggedin', {});
    conn.sendTyping('#anime', 'active');
    expect(tagmsg).toHaveBeenCalledTimes(2);
  });

  it('resumes typing after a /part + /join of a blocked channel', () => {
    const conn = makeConn();
    conn.upsertChannel('#anime');
    conn.publish = vi.fn<(event: unknown) => void>();
    conn.client.raw = vi.fn<(...args: string[]) => void>(); // swallow the on-join MODE request
    conn.client.user.nick = 'me';
    (conn.client as unknown as { network: { cap: { enabled: string[] } } }).network = {
      cap: { enabled: ['message-tags'] },
    };
    const tagmsg = vi.fn<(target: string, tags?: Record<string, string>) => void>();
    conn.client.tagmsg = tagmsg;

    // Channel gets marked unsendable; typing is suppressed.
    conn.client.emit('unknown command', {
      command: '477',
      params: ['nick', '#anime', 'You need to be identified to speak'],
    });
    conn.sendTyping('#anime', 'active');
    expect(tagmsg).not.toHaveBeenCalled();

    // Re-joining is a clean "try again" — the mark clears and typing flows.
    conn.client.emit('join', { channel: '#anime', nick: 'me' });
    conn.sendTyping('#anime', 'active');
    expect(tagmsg).toHaveBeenCalledTimes(1);
  });

  it('resetSendState (run on reconnect) drops speak-permission marks and stale attribution', () => {
    // The 'registered' handler calls resetSendState so a new socket starts clean.
    // Test it directly — emitting 'registered' would drag in irc-framework's own
    // ping-timer internals. Without this, a recent pre-reconnect send could make
    // the first refused bounce on the new socket look like a real failed message.
    const conn = makeConn();
    conn.publish = vi.fn<(event: unknown) => void>();
    conn.upsertChannel('#anime');
    conn.noteUserSend('#anime');
    conn.handleSendRejection('#anime', 'You need to be identified to speak', {});
    expect(conn.recentUserSend('#anime')).toBe(true);
    expect(conn.unsendableTargets.has('#anime')).toBe(true);

    conn.resetSendState();

    expect(conn.recentUserSend('#anime')).toBe(false);
    expect(conn.unsendableTargets.has('#anime')).toBe(false);
  });

  it('prunes stale send-attribution entries so the map stays bounded', () => {
    vi.useFakeTimers();
    try {
      const conn = makeConn();
      conn.noteUserSend('#a');
      conn.noteUserSend('bob');
      expect(conn.lastUserSendAt.size).toBe(2);

      // Past the attribution window, the next send prunes the now-stale entries.
      vi.advanceTimersByTime(16_000);
      conn.noteUserSend('#c');
      expect(conn.lastUserSendAt.size).toBe(1);
      expect(conn.recentUserSend('#a')).toBe(false);
      expect(conn.recentUserSend('#c')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps 477 as a "Couldn’t join" toast when we are not in the channel', () => {
    const conn = makeConn();
    const publish = vi.fn<(event: unknown) => void>();
    const publishEphemeral = vi.fn<(event: unknown) => void>();
    conn.publish = publish;
    conn.publishEphemeral = publishEphemeral;

    conn.client.emit('unknown command', {
      command: '477',
      params: ['nick', '#secret', 'Cannot join channel (+r)'],
    });

    expect(publish).not.toHaveBeenCalled();
    expect(publishEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'join-error',
        target: '#secret',
        text: 'This channel requires a registered nickname.',
      }),
    );
  });
});

// identd must be wired to the *pre-TLS* connect event. The IRC server fires its
// :113 ident callback the instant it accepts our TCP connection — concurrently
// with the TLS handshake — so registering on the post-handshake 'socket
// connected' event races (and frequently loses to) that callback on TLS
// networks, leaving users unidentified behind the shared cell IP. irc-framework
// emits 'raw socket connected' (with the underlying socket) at bare TCP connect
// for exactly this purpose; these tests pin us to it.
describe('built-in identd registration', () => {
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
        nick: 'nick',
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

  // Stand up the real identd server and ask it the same RFC 1413 question the IRC
  // server would, so we assert the registration is observable end-to-end — not
  // just that an internal field got set.
  async function withIdentd(fn: (query: (line: string) => Promise<string>) => Promise<void>) {
    const server = createIdentdServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;
    const query = (line: string) =>
      new Promise<string>((resolve, reject) => {
        const c = net.connect(port, '127.0.0.1', () => c.write(line));
        let out = '';
        c.on('data', (d) => (out += d.toString()));
        c.on('end', () => resolve(out));
        c.on('error', reject);
      });
    try {
      await fn(query);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it('registers the full 4-tuple on pre-TLS "raw socket connected" so the :113 callback resolves', async () => {
    const prev = process.env.LURKER_IDENTD_ENABLED;
    process.env.LURKER_IDENTD_ENABLED = '1';
    let identId: number | null = null;
    try {
      await withIdentd(async (query) => {
        const conn = makeConn();
        // irc-framework hands us the raw socket at bare TCP connect (before the
        // TLS handshake completes) with all four tuple fields populated.
        // Simulate that with the loopback tuple the temp identd server will see
        // from the query below.
        conn.client.emit('raw socket connected', {
          localAddress: '127.0.0.1',
          localPort: 40010,
          remoteAddress: '127.0.0.1',
          remotePort: 6697,
        });
        identId = conn.identdId;
        expect(identId).toBeGreaterThan(0);

        const reply = await query('40010, 6697\r\n');
        // A successful USERID reply with a non-empty ident — registration landed
        // before any query could arrive. (The exact ident string is covered by
        // ident.test.ts; here we only care that the tuple resolved.)
        expect(reply.trim()).toMatch(/^40010, 6697 : USERID : UNIX : \S+$/);
      });
    } finally {
      unregisterIdent(identId);
      if (prev === undefined) delete process.env.LURKER_IDENTD_ENABLED;
      else process.env.LURKER_IDENTD_ENABLED = prev;
    }
  });

  it('stays opt-in: no registration when LURKER_IDENTD_ENABLED is unset', () => {
    const prev = process.env.LURKER_IDENTD_ENABLED;
    delete process.env.LURKER_IDENTD_ENABLED;
    try {
      const conn = makeConn();
      conn.client.emit('raw socket connected', {
        localAddress: '127.0.0.1',
        localPort: 40011,
        remoteAddress: '127.0.0.1',
        remotePort: 6697,
      });
      expect(conn.identdId).toBeNull();
    } finally {
      if (prev !== undefined) process.env.LURKER_IDENTD_ENABLED = prev;
    }
  });
});

describe('disconnect quit message (#324)', () => {
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
        nick: 'nick',
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

  afterEach(() => deleteUserSetting(1, 'chat.quit_message'));

  it('falls back to the built-in Lurker default when chat.quit_message is unset', () => {
    const conn = makeConn();
    const quit = vi.fn<(reason?: string) => void>();
    conn.client.quit = quit;
    conn.disconnect();
    const reason = quit.mock.calls[0][0] ?? '';
    expect(reason).toContain('Lurker');
    expect(reason).toContain('https://lurker.chat');
  });

  it('uses the configured chat.quit_message when set', () => {
    setUserSetting(1, 'chat.quit_message', 'bbl');
    const conn = makeConn();
    const quit = vi.fn<(reason?: string) => void>();
    conn.client.quit = quit;
    conn.disconnect();
    expect(quit).toHaveBeenCalledWith('bbl');
  });

  it('lets an explicit reason override the configured message', () => {
    setUserSetting(1, 'chat.quit_message', 'bbl');
    const conn = makeConn();
    const quit = vi.fn<(reason?: string) => void>();
    conn.client.quit = quit;
    conn.disconnect('see ya');
    expect(quit).toHaveBeenCalledWith('see ya');
  });
});

describe('self nick updates the input bar (#362)', () => {
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
        nick: 'amiantos',
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

  it('publishes own-nick for a self NICK change (covers /nick, forced, reclaim)', () => {
    const conn = makeConn();
    conn.client.user.nick = 'amiantos';
    const publish = vi.fn<(event: unknown) => void>();
    conn.publish = publish;
    conn.client.emit('nick', { nick: 'amiantos', new_nick: 'amiantos_' });
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'own-nick', nick: 'amiantos_' }),
    );
  });

  it('reports the registered fallback nick on connect, not the requested primary', () => {
    const conn = makeConn();
    conn.startLagPinger = () => {}; // don't leave an interval running
    // irc-framework starts a periodic ping on 'registered'; with an unconnected
    // test client its interval is NaN (a noisy TimeoutNaNWarning) — stub it out.
    (conn.client as unknown as { startPeriodicPing: () => void }).startPeriodicPing = () => {};
    const publish = vi.fn<(event: unknown) => void>();
    conn.publish = publish;
    conn.client.changeNick = vi.fn<(nick: string) => void>(); // don't touch a real socket
    // Configured nick is taken → Lurker's fallback ladder renames us.
    conn.client.user.nick = 'amiantos';
    conn.client.emit('nick in use', { nick: 'amiantos' });
    expect(conn.client.changeNick).toHaveBeenCalledWith('amiantos1');

    // Crucial timing (#362): irc-framework updates c.user.nick from its OWN
    // 'registered' listener, which runs AFTER the 'all' proxy that drives ours
    // — so c.user.nick is still the STALE primary here. RPL_WELCOME carries the
    // real nick as event.nick.
    conn.client.emit('registered', { nick: 'amiantos1' });
    conn.stopLagPinger();

    const connectedStates = publish.mock.calls
      .map((c) => c[0] as { type?: string; state?: string; nick?: string })
      .filter((e) => e?.type === 'state' && e?.state === 'connected');
    expect(connectedStates.at(-1)).toMatchObject({ nick: 'amiantos1' });
    // The snapshot wsHub re-sends on 'connected' must agree — reading the stale
    // c.user.nick here is what clobbered the input bar back to the primary.
    expect(conn.snapshot()).toMatchObject({ nick: 'amiantos1' });
  });

  it('snapshot tracks a self nick change', () => {
    const conn = makeConn();
    conn.client.user.nick = 'amiantos1';
    conn.currentNick = 'amiantos1';
    conn.client.emit('nick', { nick: 'amiantos1', new_nick: 'amiantos' });
    expect(conn.snapshot()).toMatchObject({ nick: 'amiantos' });
  });
});

describe('outgoingAddr', () => {
  const prev = process.env.LURKER_OUTGOING_ADDR;
  afterEach(() => {
    if (prev === undefined) delete process.env.LURKER_OUTGOING_ADDR;
    else process.env.LURKER_OUTGOING_ADDR = prev;
  });

  it('is undefined when unset', () => {
    delete process.env.LURKER_OUTGOING_ADDR;
    expect(outgoingAddr()).toBeUndefined();
  });

  it('returns the trimmed address when set', () => {
    process.env.LURKER_OUTGOING_ADDR = '  2001:db8::dead  ';
    expect(outgoingAddr()).toBe('2001:db8::dead');
  });

  it('treats a whitespace-only value as unset', () => {
    process.env.LURKER_OUTGOING_ADDR = '   ';
    expect(outgoingAddr()).toBeUndefined();
  });
});

describe('capability negotiation (#310)', () => {
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
        nick: 'nick',
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

  // We request extended-monitor so the server relays away-notify for MONITOR'd
  // peers even with no shared channel. irc-framework only actually sends a cap
  // it's asked for via requestCap() if the server advertises it, so the request
  // is the whole of our change — assert it lands on request_extra_caps.
  it('requests extended-monitor (and message-tags)', () => {
    const conn = makeConn();
    const caps = (conn as unknown as { client: { request_extra_caps: string[] } }).client
      .request_extra_caps;
    expect(caps).toContain('extended-monitor');
    expect(caps).toContain('message-tags');
  });
});

describe('away/back presence logging (#310)', () => {
  // markPeerEvent writes peer_presence_state, which FKs to networks — so unlike
  // the other suites (which only build bare in-memory connections) this needs a
  // real network row. Build the connection from the inserted row so the ids line up.
  function makeConn(name: string): IrcConnection {
    const network = createNetwork(1, {
      name,
      host: 'irc.example.test',
      port: 6697,
      tls: 1,
      trusted_certificates: 1,
      nick: 'nick',
      username: null,
      realname: null,
      server_password: null,
      autoconnect: 0,
      sasl_account: null,
      sasl_password: null,
      connect_commands: null,
    })!;
    return new IrcConnection({ network, onEvent: () => {} });
  }

  // extended-monitor delivers away/back for tracked peers via away-notify, which
  // markPeerEvent mirrors to the system log alongside the existing MONITOR
  // online/offline 'Presence:' lines.
  it('logs Presence: away (with reason) and back for a tracked peer', () => {
    const conn = makeConn('awaylog');
    conn.trackFriend('awaypal', 7);
    conn.markPeerEvent('awaypal', 'online'); // online itself isn't logged here
    conn.markPeerEvent('awaypal', 'away', 'brb');
    conn.markPeerEvent('awaypal', 'back');
    const texts = getRecent(1).map((l) => l.text);
    expect(texts).toContain('Presence: awaypal away (brb)');
    expect(texts).toContain('Presence: awaypal back');
  });

  // The eligiblePeer gate keeps a busy channel's /away traffic out of the log
  // (and short-circuits before any peer_presence_state write).
  it('does not log away for an untracked nick', () => {
    const conn = makeConn('awaylog2');
    conn.markPeerEvent('stranger', 'away', 'nope');
    const texts = getRecent(1).map((l) => l.text);
    expect(texts).not.toContain('Presence: stranger away (nope)');
  });
});
