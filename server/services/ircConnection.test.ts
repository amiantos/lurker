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
  resolveChannelContext,
  sendRejectionTargetKind,
  sendRejectionText,
  outgoingAddr,
  resolveKeyModeChange,
} from './ircConnection.js';
import { createIdentdServer, unregisterIdent } from './identd.js';
import { getRecent } from './systemLog.js';
import { createUser } from '../db/users.js';
import { createNetwork } from '../db/networks.js';
import {
  getBuffer,
  ensureOpen as ensureBufferOpen,
  seedAutojoinChannel,
  listForNetwork as listBufferRowsForNetwork,
} from '../db/buffers.js';
import { getPeerPresence } from '../db/peerPresence.js';
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
    // MOTD block, /LIST (cached off-wire), auto-WHO replies, NAMES (nicklist),
    // MONITOR presence, and nick-collision errors are surfaced elsewhere — the
    // raw handler skips them so they aren't duplicated in the server buffer.
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
      '353',
      '366', // NAMES
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
    // The whole point of #342: greeting, whois, oper, time, topic and even
    // ISUPPORT all fall through to the raw renderer instead of vanishing.
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

describe('resolveChannelContext (#439)', () => {
  // Joined set: keyed lowercase, .name holds the case we joined with.
  const channels = new Map([['#christian', { name: '#Christian' }]]);

  it('redirects via the +draft/channel-context tag to the joined channel (canonical case)', () => {
    expect(
      resolveChannelContext({ '+draft/channel-context': '#CHRISTIAN' }, 'hello', channels),
    ).toBe('#Christian');
  });

  it('redirects via a leading [#chan] body prefix, tolerating (), <>, {}', () => {
    expect(resolveChannelContext(undefined, '[#christian] welcome', channels)).toBe('#Christian');
    expect(resolveChannelContext(undefined, '(#christian) hi', channels)).toBe('#Christian');
    expect(resolveChannelContext(undefined, '<#christian> hi', channels)).toBe('#Christian');
    expect(resolveChannelContext(undefined, '{#christian} hi', channels)).toBe('#Christian');
  });

  it('prefers the tag over a conflicting body prefix', () => {
    // Body names a channel we are NOT in; the tag names one we are — tag wins.
    expect(
      resolveChannelContext({ '+draft/channel-context': '#christian' }, '[#elsewhere] x', channels),
    ).toBe('#Christian');
  });

  it('returns null when the referenced channel is not joined (no buffer fabrication)', () => {
    expect(resolveChannelContext({ '+draft/channel-context': '#elsewhere' }, 'x', channels)).toBe(
      null,
    );
    expect(resolveChannelContext(undefined, '[#elsewhere] x', channels)).toBe(null);
  });

  it('returns null when there is no usable context', () => {
    expect(resolveChannelContext(undefined, 'just a normal notice', channels)).toBe(null);
    expect(resolveChannelContext(undefined, 'a [#christian] mid-line mention', channels)).toBe(
      null,
    );
    expect(resolveChannelContext({}, undefined, channels)).toBe(null);
    // A bracketed token without a channel sigil is not a context prefix.
    expect(resolveChannelContext(undefined, '[info] something', channels)).toBe(null);
  });

  it('only resolves `#` channels, not `&`/`!`/`+` (matches Lurker routing)', () => {
    // Even when "joined" to a non-# channel, channel-context must not redirect to
    // it — Lurker routes `&`/`!`/`+` targets as non-channels.
    const withLocal = new Map([
      ['#christian', { name: '#Christian' }],
      ['&local', { name: '&local' }],
    ]);
    expect(resolveChannelContext({ '+draft/channel-context': '&local' }, 'x', withLocal)).toBe(
      null,
    );
    expect(resolveChannelContext(undefined, '[&local] hi', withLocal)).toBe(null);
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

// The "stuck online" fix for networks without MONITOR: our own disconnect
// forces every tracked peer offline, and WHO-on-join re-lights the peers we can
// still observe on reconnect (existing channel occupants arrive via NAMES, not
// JOIN, so the 'join' handler never fires for them).
describe('disconnect-offline sweep + WHO re-light (no-MONITOR presence)', () => {
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

  it('markAllPeersOffline forces every tracked peer (DM + friend) offline', () => {
    const conn = makeConn('disco');
    conn.trackFriend('pal', 1);
    conn.trackDmPeer('dmpal');
    conn.markPeerEvent('pal', 'online');
    conn.markPeerEvent('dmpal', 'away', 'brb');
    conn.markAllPeersOffline();
    expect(getPeerPresence(conn.network.id, 'pal')?.state).toBe('offline');
    expect(getPeerPresence(conn.network.id, 'dmpal')?.state).toBe('offline');
  });

  it('never writes a row for an untracked nick during the sweep', () => {
    const conn = makeConn('disco2');
    conn.markPeerEvent('stranger', 'online'); // untracked → gated out, no row
    conn.markAllPeersOffline();
    expect(getPeerPresence(conn.network.id, 'stranger')).toBeNull();
  });

  // dispose() sets disposed=true before the socket tears down; on a deletion
  // dispose the network row (+ its peer_presence_state rows) may already be gone
  // when the async socket-close fires, so a write here would hit a FK violation.
  // The guard makes the sweep a no-op in that window.
  it('is a no-op when the connection is disposed (avoids a post-delete FK write)', () => {
    const conn = makeConn('disco-disposed');
    conn.trackFriend('pal', 1);
    conn.markPeerEvent('pal', 'online');
    conn.disposed = true;
    conn.markAllPeersOffline();
    expect(getPeerPresence(conn.network.id, 'pal')?.state).toBe('online'); // untouched
  });

  // The sweep is wired to 'socket close' (not 'close') because irc-framework
  // auto-reconnects a blip internally and only emits 'socket close' — 'close' is
  // reserved for a terminal give-up/dispose, so it would miss the common case.
  it("fires the sweep from the 'socket close' event (the auto-reconnect path)", () => {
    const conn = makeConn('sockclose');
    conn.publish = vi.fn<typeof conn.publish>(); // skip the disconnected-state + error publishes
    conn.trackFriend('pal', 1);
    conn.markPeerEvent('pal', 'online');
    conn.client.emit('socket close', {});
    expect(getPeerPresence(conn.network.id, 'pal')?.state).toBe('offline');
  });

  it('WHO-on-join promotes a still-present peer back to online after the sweep', () => {
    const conn = makeConn('relight');
    conn.publish = vi.fn<typeof conn.publish>(); // assert on presence, not history
    conn.client.user.nick = 'me';
    conn.trackFriend('chanpal', 9);
    // Peer shares a channel with us…
    conn.client.emit('join', { channel: '#room', nick: 'chanpal', ident: 'u', hostname: 'h' });
    // …then our socket drops (peer quit unseen or not — doesn't matter):
    conn.markAllPeersOffline();
    expect(getPeerPresence(conn.network.id, 'chanpal')?.state).toBe('offline');
    // Reconnect: existing occupant arrives via WHO, not JOIN, and isn't away.
    conn.client.emit('wholist', {
      target: '#room',
      users: [{ nick: 'chanpal', away: false }],
    });
    expect(getPeerPresence(conn.network.id, 'chanpal')?.state).toBe('online');
  });

  it('WHO-on-join records an away peer as away and clears a stale away to back', () => {
    const conn = makeConn('relight-away');
    conn.publish = vi.fn<typeof conn.publish>();
    conn.client.user.nick = 'me';
    conn.trackFriend('awaychan', 10);
    conn.client.emit('join', { channel: '#room', nick: 'awaychan' });
    conn.client.emit('wholist', { target: '#room', users: [{ nick: 'awaychan', away: true }] });
    expect(getPeerPresence(conn.network.id, 'awaychan')?.state).toBe('away');
    // A later WHO with the away flag cleared must move away → back (renders online).
    conn.client.emit('wholist', { target: '#room', users: [{ nick: 'awaychan', away: false }] });
    expect(getPeerPresence(conn.network.id, 'awaychan')?.state).toBe('back');
  });
});

describe('IRCv3 draft/multiline (#381)', () => {
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
      onEvent: () => {},
    });
  }

  // Enable the cap pair (and optionally advertise limits) the way the registered
  // server would, so multilineLimits()/supportsMultiline()/the send path light up.
  function enableMultiline(conn: IrcConnection, advertised = 'max-bytes=4096,max-lines=24'): void {
    (
      conn.client as unknown as {
        network: { cap: { enabled: string[]; available: Map<string, string> } };
      }
    ).network = {
      cap: {
        enabled: ['message-tags', 'batch', 'draft/multiline'],
        available: new Map([['draft/multiline', advertised]]),
      },
    };
  }

  it('requests batch and draft/multiline (alongside message-tags)', () => {
    const conn = makeConn();
    const caps = (conn as unknown as { client: { request_extra_caps: string[] } }).client
      .request_extra_caps;
    expect(caps).toContain('batch');
    expect(caps).toContain('draft/multiline');
    expect(caps).toContain('message-tags');
  });

  describe('receive (reassembly)', () => {
    function makeReceiver(): { conn: IrcConnection; publish: ReturnType<typeof vi.fn> } {
      const conn = makeConn();
      const publish = vi.fn<(event: unknown) => void>();
      conn.publish = publish;
      // Channel chatter calls markPeerEvent; stub it so the bare (un-inserted)
      // network row doesn't trip the peer_presence_state FK.
      conn.markPeerEvent = vi.fn<typeof conn.markPeerEvent>();
      conn.trackDmPeer = vi.fn<typeof conn.trackDmPeer>();
      conn.client.user.nick = 'me';
      return { conn, publish };
    }

    function fragment(id: string, message: string, extra: Record<string, unknown> = {}) {
      return {
        nick: 'alice',
        target: '#chan',
        type: 'privmsg',
        message,
        batch: { id, type: 'draft/multiline' },
        ...extra,
      };
    }

    it('buffers fragments and flushes ONE message joined with newlines on batch end', () => {
      const { conn, publish } = makeReceiver();
      conn.client.emit('message', fragment('b1', 'line one'));
      conn.client.emit('message', fragment('b1', 'line two'));
      // Nothing surfaces until the batch closes.
      expect(publish).not.toHaveBeenCalled();
      conn.client.emit('batch end draft/multiline', { id: 'b1' });
      expect(publish).toHaveBeenCalledTimes(1);
      expect(publish.mock.calls[0][0]).toMatchObject({
        type: 'message',
        target: '#chan',
        nick: 'alice',
        text: 'line one\nline two',
        self: false,
      });
    });

    it('honors draft/multiline-concat — continuations rejoin with NO newline', () => {
      const { conn, publish } = makeReceiver();
      conn.client.emit('message', fragment('b2', 'hello '));
      conn.client.emit(
        'message',
        fragment('b2', 'world', { tags: { 'draft/multiline-concat': '' } }),
      );
      conn.client.emit('batch end draft/multiline', { id: 'b2' });
      expect(publish.mock.calls[0][0]).toMatchObject({ text: 'hello world' });
    });

    it('still skips a self-authored multiline batch (no duplicate of our own echo)', () => {
      const { conn, publish } = makeReceiver();
      conn.client.emit('message', fragment('b3', 'a', { nick: 'me' }));
      conn.client.emit('message', fragment('b3', 'b', { nick: 'me' }));
      conn.client.emit('batch end draft/multiline', { id: 'b3' });
      expect(publish).not.toHaveBeenCalled();
    });

    it('a batch end with no buffered fragments is a no-op', () => {
      const { conn, publish } = makeReceiver();
      conn.client.emit('batch end draft/multiline', { id: 'nope' });
      expect(publish).not.toHaveBeenCalled();
    });

    it('does not interleave two concurrent batches', () => {
      const { conn, publish } = makeReceiver();
      conn.client.emit('message', fragment('A', 'a1'));
      conn.client.emit('message', fragment('B', 'b1'));
      conn.client.emit('message', fragment('A', 'a2'));
      conn.client.emit('batch end draft/multiline', { id: 'B' });
      conn.client.emit('batch end draft/multiline', { id: 'A' });
      expect(publish.mock.calls.map((c) => (c[0] as { text: string }).text)).toEqual([
        'b1',
        'a1\na2',
      ]);
    });
  });

  describe('send (framing)', () => {
    it('frames a multi-line body as BATCH + … tagged PRIVMSGs … BATCH - and echoes it', () => {
      const conn = makeConn();
      enableMultiline(conn);
      const raw = vi.fn<(line: string) => void>();
      conn.client.raw = raw;
      const echoes = conn.sendMultiline('#chan', 'line one\nline two');
      const lines = raw.mock.calls.map((c) => c[0]);
      expect(lines[0]).toMatch(/^BATCH \+[0-9a-f]{16} draft\/multiline #chan$/);
      const ref = lines[0].match(/^BATCH \+(\S+)/)![1];
      expect(lines[1]).toBe(`@batch=${ref} PRIVMSG #chan :line one`);
      expect(lines[2]).toBe(`@batch=${ref} PRIVMSG #chan :line two`);
      expect(lines[3]).toBe(`BATCH -${ref}`);
      expect(lines).toHaveLength(4);
      // One batch → one self-echo carrying the reassembled text.
      expect(echoes).toEqual(['line one\nline two']);
    });

    it('preserves a blank line as an empty PRIVMSG with a trailing colon', () => {
      const conn = makeConn();
      enableMultiline(conn);
      const raw = vi.fn<(line: string) => void>();
      conn.client.raw = raw;
      conn.sendMultiline('#chan', 'a\n\nb');
      const lines = raw.mock.calls.map((c) => c[0]);
      const ref = lines[0].match(/^BATCH \+(\S+)/)![1];
      expect(lines[1]).toBe(`@batch=${ref} PRIVMSG #chan :a`);
      expect(lines[2]).toBe(`@batch=${ref} PRIVMSG #chan :`);
      expect(lines[3]).toBe(`@batch=${ref} PRIVMSG #chan :b`);
    });

    it('marks the continuation of an over-long line with draft/multiline-concat', () => {
      const conn = makeConn();
      enableMultiline(conn);
      const raw = vi.fn<(line: string) => void>();
      conn.client.raw = raw;
      conn.sendMultiline('#chan', `short\n${'a'.repeat(400)}`);
      const lines = raw.mock.calls.map((c) => c[0]);
      const ref = lines[0].match(/^BATCH \+(\S+)/)![1];
      expect(lines[2]).toBe(`@batch=${ref} PRIVMSG #chan :${'a'.repeat(350)}`);
      expect(lines[3]).toBe(
        `@batch=${ref};draft/multiline-concat PRIVMSG #chan :${'a'.repeat(50)}`,
      );
    });

    it('splits an over-limit body into multiple batches, each with its own ref', () => {
      const conn = makeConn();
      enableMultiline(conn, 'max-bytes=4096,max-lines=2');
      const raw = vi.fn<(line: string) => void>();
      conn.client.raw = raw;
      // 3 lines, max-lines 2 → batch [a,b], then batch [c].
      const echoes = conn.sendMultiline('#chan', 'a\nb\nc');
      const lines = raw.mock.calls.map((c) => c[0]);
      const ref1 = lines[0].match(/^BATCH \+(\S+)/)![1];
      expect(lines.slice(0, 4)).toEqual([
        `BATCH +${ref1} draft/multiline #chan`,
        `@batch=${ref1} PRIVMSG #chan :a`,
        `@batch=${ref1} PRIVMSG #chan :b`,
        `BATCH -${ref1}`,
      ]);
      const ref2 = lines[4].match(/^BATCH \+(\S+)/)![1];
      expect(ref2).not.toBe(ref1);
      expect(lines.slice(4)).toEqual([
        `BATCH +${ref2} draft/multiline #chan`,
        `@batch=${ref2} PRIVMSG #chan :c`,
        `BATCH -${ref2}`,
      ]);
      // One self-echo per batch — the channel sees two messages, not three lines.
      expect(echoes).toEqual(['a\nb', 'c']);
    });

    it('sends nothing when the cap is not negotiated', () => {
      const conn = makeConn();
      const raw = vi.fn<(line: string) => void>();
      conn.client.raw = raw;
      expect(conn.sendMultiline('#chan', 'a\nb')).toEqual([]);
      expect(raw).not.toHaveBeenCalled();
    });
  });

  describe('limits + support gate', () => {
    it('multilineLimits is null / supportsMultiline false until both caps are negotiated', () => {
      const conn = makeConn();
      expect(conn.multilineLimits()).toBeNull();
      expect(conn.supportsMultiline()).toBe(false);
    });

    it('parses advertised max-bytes / max-lines and reports support', () => {
      const conn = makeConn();
      enableMultiline(conn, 'max-bytes=512,max-lines=3');
      expect(conn.multilineLimits()).toEqual({ maxBytes: 512, maxLines: 3 });
      expect(conn.supportsMultiline()).toBe(true);
    });

    it('falls back to conservative defaults when a dimension is omitted', () => {
      const conn = makeConn();
      enableMultiline(conn, '');
      expect(conn.multilineLimits()).toEqual({ maxBytes: 4096, maxLines: 24 });
    });

    it('reports no support when advertised max-bytes is below one wire line', () => {
      // A server that can't hold a single 350B PRIVMSG in a batch isn't usefully
      // multiline — null limits send the body via the legacy splitter instead of
      // framing batches the server would FAIL+drop.
      const conn = makeConn();
      enableMultiline(conn, 'max-bytes=100,max-lines=24');
      expect(conn.multilineLimits()).toBeNull();
      expect(conn.supportsMultiline()).toBe(false);
    });

    it('reports no support without message-tags (the batch reference rides a tag)', () => {
      const conn = makeConn();
      (
        conn.client as unknown as {
          network: { cap: { enabled: string[]; available: Map<string, string> } };
        }
      ).network = {
        cap: {
          enabled: ['batch', 'draft/multiline'], // no message-tags
          available: new Map([['draft/multiline', 'max-bytes=4096,max-lines=24']]),
        },
      };
      expect(conn.multilineLimits()).toBeNull();
      expect(conn.supportsMultiline()).toBe(false);
    });
  });
});

// Inbound channel INVITE (#261): surface "you've been invited" as an actionable
// ephemeral + a durable system-buffer line; ignore invite-notify echoes for
// other people. publishEphemeral/logNet are stubbed to assert routing without a
// DB or live socket.
describe('inbound INVITE handler (#261)', () => {
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
      onEvent: () => {},
    });
  }

  it('publishes an actionable invite event + system line when WE are invited', () => {
    const conn = makeConn();
    conn.client.user.nick = 'me';
    const publishEphemeral = vi.fn<(event: unknown) => void>();
    const logNet = vi.fn<(text: string, level?: string) => void>();
    conn.publishEphemeral = publishEphemeral;
    conn.logNet = logNet;

    conn.client.emit('invite', { nick: 'alice', invited: 'me', channel: '#secret' });

    expect(publishEphemeral).toHaveBeenCalledTimes(1);
    expect(publishEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'invite',
        // Routed via the server pseudo-buffer so the wsHub closed-buffer guard
        // can't drop an invite to a channel we'd previously closed.
        target: ':server:1',
        channel: '#secret',
        from: 'alice',
      }),
    );
    expect(logNet).toHaveBeenCalledWith('alice invited you to #secret');
  });

  it('does not toast for an invite-notify echo about someone else (channel line only)', () => {
    const conn = makeConn();
    conn.client.user.nick = 'me';
    const publish = vi.fn<(event: unknown) => void>();
    const publishEphemeral = vi.fn<(event: unknown) => void>();
    const logNet = vi.fn<(text: string, level?: string) => void>();
    conn.publish = publish;
    conn.publishEphemeral = publishEphemeral;
    conn.logNet = logNet;

    conn.client.emit('invite', { nick: 'alice', invited: 'bob', channel: '#secret' });

    // Surfaced as a channel line (covered in detail elsewhere), never as a toast
    // or a "you've been invited" system line — that's only for invites to us.
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publishEphemeral).not.toHaveBeenCalled();
    expect(logNet).not.toHaveBeenCalled();
  });

  it('matches the invited nick case-insensitively', () => {
    const conn = makeConn();
    conn.client.user.nick = 'Me';
    const publishEphemeral = vi.fn<(event: unknown) => void>();
    conn.publishEphemeral = publishEphemeral;
    conn.logNet = vi.fn<(text: string, level?: string) => void>();

    conn.client.emit('invite', { nick: 'alice', invited: 'mE', channel: '#secret' });

    expect(publishEphemeral).toHaveBeenCalledTimes(1);
  });

  it('drops a malformed invite missing the channel', () => {
    const conn = makeConn();
    conn.client.user.nick = 'me';
    const publishEphemeral = vi.fn<(event: unknown) => void>();
    conn.publishEphemeral = publishEphemeral;
    conn.logNet = vi.fn<(text: string, level?: string) => void>();

    conn.client.emit('invite', { nick: 'alice', invited: 'me' });

    expect(publishEphemeral).not.toHaveBeenCalled();
  });
});

// Outbound /invite confirmation (RPL_INVITING 341 -> 'invited') and op-visibility
// invite-notify lines (#261). Both render a persisted "X invited Y" channel line
// via publish(); the self-echo is deduped against the 341 line.
describe('invite channel lines + dedup (#261)', () => {
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
      onEvent: () => {},
    });
  }

  it('renders our own /invite as a channel line from RPL_INVITING (341)', () => {
    const conn = makeConn();
    conn.client.user.nick = 'me';
    const publish = vi.fn<(event: unknown) => void>();
    conn.publish = publish;

    // irc-framework emits 'invited' for 341 with { nick: invited, channel }.
    conn.client.emit('invited', { nick: 'bob', channel: '#secret' });

    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'invite', target: '#secret', nick: 'me', invited: 'bob' }),
    );
  });

  it('renders a third party invite-notify as a channel line', () => {
    const conn = makeConn();
    conn.client.user.nick = 'me';
    conn.upsertChannel('#secret');
    const publish = vi.fn<(event: unknown) => void>();
    conn.publish = publish;

    conn.client.emit('invite', { nick: 'alice', invited: 'bob', channel: '#secret' });

    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'invite', target: '#secret', nick: 'alice', invited: 'bob' }),
    );
  });

  it('suppresses the invite-notify echo of our OWN invite (deduped against 341)', () => {
    const conn = makeConn();
    conn.client.user.nick = 'me';
    const publish = vi.fn<(event: unknown) => void>();
    const publishEphemeral = vi.fn<(event: unknown) => void>();
    conn.publish = publish;
    conn.publishEphemeral = publishEphemeral;

    // Our own INVITE, echoed back via invite-notify (inviter === us).
    conn.client.emit('invite', { nick: 'me', invited: 'bob', channel: '#secret' });

    expect(publish).not.toHaveBeenCalled();
    expect(publishEphemeral).not.toHaveBeenCalled();
  });

  it('still routes an invite TO us as the actionable toast, not a channel line', () => {
    const conn = makeConn();
    conn.client.user.nick = 'me';
    const publish = vi.fn<(event: unknown) => void>();
    const publishEphemeral = vi.fn<(event: unknown) => void>();
    conn.publish = publish;
    conn.publishEphemeral = publishEphemeral;
    conn.logNet = vi.fn<(text: string, level?: string) => void>();

    conn.client.emit('invite', { nick: 'alice', invited: 'me', channel: '#secret' });

    expect(publish).not.toHaveBeenCalled(); // not a channel line
    expect(publishEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'invite', target: ':server:1', channel: '#secret' }),
    );
  });
});

describe('channel mode display (status bar)', () => {
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
      onEvent: () => {},
    });
  }

  // Grab the latest channel-modes payload (the (+...) status-bar string).
  function latestModes(publish: ReturnType<typeof vi.fn>): string | undefined {
    const calls = publish.mock.calls
      .map((c) => c[0] as { type: string; modes?: string })
      .filter((e) => e.type === 'channel-modes');
    return calls.at(-1)?.modes;
  }

  it('surfaces +k in the mode string but never the key value (#476)', () => {
    const conn = makeConn();
    conn.upsertChannel('#chan');
    const publish = vi.fn<(event: unknown) => void>();
    conn.publish = publish;

    conn.client.emit('mode', {
      target: '#chan',
      modes: [{ mode: '+k', param: 'hunter2' }],
      raw_modes: '+k',
      raw_params: ['hunter2'],
    });

    const modes = latestModes(publish);
    expect(modes).toContain('k');
    expect(modes).not.toContain('hunter2'); // only the letter, never the secret
  });

  it('surfaces +l (limit) as a flag', () => {
    const conn = makeConn();
    conn.upsertChannel('#chan');
    const publish = vi.fn<(event: unknown) => void>();
    conn.publish = publish;

    conn.client.emit('mode', {
      target: '#chan',
      modes: [{ mode: '+l', param: '42' }],
      raw_modes: '+l',
      raw_params: ['42'],
    });

    const modes = latestModes(publish);
    expect(modes).toContain('l');
    expect(modes).not.toContain('42');
  });

  it('excludes list-type modes (+b bans) from the display', () => {
    const conn = makeConn();
    conn.upsertChannel('#chan');
    const publish = vi.fn<(event: unknown) => void>();
    conn.publish = publish;

    conn.client.emit('mode', {
      target: '#chan',
      modes: [{ mode: '+n' }, { mode: '+b', param: 'troll!*@*' }],
      raw_modes: '+nb',
      raw_params: ['troll!*@*'],
    });

    const modes = latestModes(publish);
    expect(modes).toContain('n');
    expect(modes).not.toContain('b'); // the ban mask must not pollute the display
  });

  it('honours the server ISUPPORT CHANMODES when deciding what is a list mode', () => {
    const conn = makeConn();
    // Declare a server-specific list mode (+g) in CHANMODES group A. A hardcoded
    // b/e/I list would miss it; reading group A excludes exactly what the server
    // says is list-type.
    // irc-framework stores CHANMODES as the four comma-split groups at runtime
    // (see registration.js), though its .d.ts types it as a string.
    (conn.client.network.options as { CHANMODES?: unknown }).CHANMODES = [
      'beIg',
      'k',
      'l',
      'imnpst',
    ];
    conn.upsertChannel('#chan');
    const publish = vi.fn<(event: unknown) => void>();
    conn.publish = publish;

    conn.client.emit('mode', {
      target: '#chan',
      modes: [
        { mode: '+n' },
        { mode: '+g', param: 'spam' }, // server-declared list mode → excluded
        { mode: '+k', param: 'secret' }, // param mode, not a list mode → kept
      ],
      raw_modes: '+ngk',
      raw_params: ['spam', 'secret'],
    });

    const modes = latestModes(publish);
    expect([...(modes ?? '')].toSorted().join('')).toBe('kn');
    expect(modes).not.toContain('g');
    expect(modes).not.toContain('secret');
  });

  it('drops a channel mode when it is removed (-k)', () => {
    const conn = makeConn();
    conn.upsertChannel('#chan');
    const publish = vi.fn<(event: unknown) => void>();
    conn.publish = publish;

    conn.client.emit('mode', {
      target: '#chan',
      modes: [{ mode: '+k', param: 'secret' }],
      raw_modes: '+k',
      raw_params: ['secret'],
    });
    expect(latestModes(publish)).toContain('k');

    conn.client.emit('mode', {
      target: '#chan',
      modes: [{ mode: '-k', param: 'secret' }],
      raw_modes: '-k',
      raw_params: ['secret'],
    });
    expect(latestModes(publish)).not.toContain('k');
  });

  it('RPL_CHANNELMODEIS (324) captures param modes and drops list modes', () => {
    const conn = makeConn();
    conn.upsertChannel('#chan');
    const publish = vi.fn<(event: unknown) => void>();
    conn.publish = publish;

    conn.client.emit('channel info', {
      channel: '#chan',
      modes: [{ mode: '+n' }, { mode: '+k', param: 'secret' }, { mode: '+b', param: 'troll!*@*' }],
    });

    const modes = latestModes(publish);
    expect(modes).toContain('n');
    expect(modes).toContain('k');
    expect(modes).not.toContain('b');
    expect(modes).not.toContain('secret');
  });
});

describe('resolveKeyModeChange', () => {
  it('clears the stored key on -k', () => {
    expect(resolveKeyModeChange('-', 'ignored')).toEqual({ key: null });
    expect(resolveKeyModeChange('-', undefined)).toEqual({ key: null });
  });

  it('sets the key on +k with a real value', () => {
    expect(resolveKeyModeChange('+', 'hunter2')).toEqual({ key: 'hunter2' });
  });

  it('leaves the stored key untouched for a value-less +k (on-join mode burst)', () => {
    // The dangerous case: a +k echoed without its value must NOT wipe the key
    // we persisted from the join command, or the channel loses its key on the
    // next reconnect.
    expect(resolveKeyModeChange('+', undefined)).toBeNull();
    expect(resolveKeyModeChange('+', '')).toBeNull();
  });

  it('leaves the stored key untouched for a masked +k (* placeholder)', () => {
    // Some servers hide the key from non-ops by echoing it as `*`; persisting
    // that would replace the real key with an unusable one.
    expect(resolveKeyModeChange('+', '*')).toBeNull();
  });
});

describe('join key forwarding', () => {
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
      onEvent: () => {},
    });
  }

  it('forwards a string key to the underlying client', () => {
    const conn = makeConn();
    const join = vi.fn<(channel: string, key?: string) => void>();
    conn.client.join = join;
    conn.join('#secret', 'hunter2');
    expect(join).toHaveBeenCalledWith('#secret', 'hunter2');
  });

  it('drops a non-string key rather than passing it to the raw serialiser', () => {
    // A numeric key from an untrusted payload would otherwise throw inside
    // irc-framework (.match on a Number) and crash the process.
    const conn = makeConn();
    const join = vi.fn<(channel: string, key?: string) => void>();
    conn.client.join = join;
    conn.join('#secret', 123 as unknown as string);
    expect(join).toHaveBeenCalledWith('#secret', undefined);
  });

  it('omits the key for a plain join', () => {
    const conn = makeConn();
    const join = vi.fn<(channel: string, key?: string) => void>();
    conn.client.join = join;
    conn.join('#open');
    expect(join).toHaveBeenCalledWith('#open', undefined);
  });
});

// A forwarding server (Libera answers JOIN #apple with 470 → ##apple) used to
// leave a phantom row for the name we asked for: the old joinChannel wrote it
// optimistically on the request, and no channel-joined ever arrived for that
// name to correct it. Under the buffers registry nothing is persisted until
// the join ECHO, so the request can no longer plant anything — these tests
// cover the echo write itself plus the two correction paths that remain: a
// pre-existing row (config-seeded autojoin, or stale history) hit by a 470,
// and a 442 whose PART echo never comes.
describe('join echo, forwarded joins (470), and un-partable channels (442)', () => {
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

  it('self-join echo mints the registry row with autojoin and the stashed key', () => {
    const conn = makeConn('echo-mints');
    conn.client.user.nick = 'me';
    conn.stashJoinKey('#Secret', 'hunter2');

    conn.client.emit('join', { channel: '#Secret', nick: 'me' });

    const row = getBuffer(conn.network.user_id, conn.network.id, '#secret');
    expect(row?.target).toBe('#Secret');
    expect(row?.kind).toBe('channel');
    expect(row?.state).toBe('open');
    expect(row?.autojoin).toBe(true);
    expect(row?.key).toBe('hunter2');
  });

  it("someone else's join mints nothing", () => {
    const conn = makeConn('echo-other');
    conn.client.user.nick = 'me';
    conn.upsertChannel('#chan');

    conn.client.emit('join', { channel: '#chan', nick: 'stranger' });

    expect(getBuffer(conn.network.user_id, conn.network.id, '#chan')).toBeUndefined();
  });

  it('470 deletes a history-less pre-existing row even when the server relays a different case', () => {
    const conn = makeConn('fwd-row');
    const netId = conn.network.id;
    // A config-seeded autojoin entry (default_channels) — the one remaining way
    // a row can exist for a channel the server then forwards away from. Stored
    // with the case the user typed; the server relays its own.
    seedAutojoinChannel(conn.network.user_id, netId, '#Apple');
    expect(getBuffer(conn.network.user_id, netId, '#apple')).toBeDefined();

    // The shape irc-framework actually emits for ERR_LINKCHANNEL — it models
    // 470 as its own event, so this never arrives as 'unknown command'.
    conn.client.emit('channel_redirect', { from: '#apple', to: '##apple' });

    // Gone entirely — no history means nothing to show, and a surviving row
    // would replay the forwarded JOIN on every reconnect.
    expect(getBuffer(conn.network.user_id, netId, '#apple')).toBeUndefined();
  });

  it('470 discards a stashed join key for the forwarded-from channel', () => {
    const conn = makeConn('fwd-key');
    conn.client.user.nick = 'me';
    conn.stashJoinKey('#apple', 'sekrit');

    conn.client.emit('channel_redirect', { from: '#apple', to: '##apple' });
    // A later echo for that name (a genuine join) must not resurrect the key.
    conn.client.emit('join', { channel: '#apple', nick: 'me' });

    expect(getBuffer(conn.network.user_id, conn.network.id, '#apple')?.key).toBeNull();
  });

  it('470 evicts the forwarded-from channel from the joined set and announces the part', () => {
    const conn = makeConn('fwd-evict');
    conn.upsertChannel('#apple');
    const publish = vi.fn<(event: unknown) => void>();
    conn.publish = publish;

    // The shape irc-framework actually emits for ERR_LINKCHANNEL — it models
    // 470 as its own event, so this never arrives as 'unknown command'.
    conn.client.emit('channel_redirect', { from: '#apple', to: '##apple' });

    expect(conn.channels.has('#apple')).toBe(false);
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'channel-parted', target: '#apple' }),
    );
  });

  it('470 leaves the channel we were actually forwarded TO alone', () => {
    const conn = makeConn('fwd-target');
    conn.upsertChannel('##apple');
    ensureBufferOpen(conn.network.user_id, conn.network.id, '##apple', {
      kind: 'channel',
      autojoin: true,
    });

    // The shape irc-framework actually emits for ERR_LINKCHANNEL — it models
    // 470 as its own event, so this never arrives as 'unknown command'.
    conn.client.emit('channel_redirect', { from: '#apple', to: '##apple' });

    expect(conn.channels.has('##apple')).toBe(true);
    expect(getBuffer(conn.network.user_id, conn.network.id, '##apple')).toBeDefined();
  });

  it('442 on a PART evicts the channel the server says we are not on', () => {
    const conn = makeConn('notonchan');
    conn.upsertChannel('#apple');
    ensureBufferOpen(conn.network.user_id, conn.network.id, '#apple', {
      kind: 'channel',
      autojoin: true,
    });
    const publish = vi.fn<(event: unknown) => void>();
    conn.publish = publish;

    conn.client.emit('irc error', {
      error: 'not_on_channel',
      channel: '#apple',
      reason: "You're not on that channel",
    });

    // Without this the PART echo never lands and #apple stays "joined" forever.
    expect(conn.channels.has('#apple')).toBe(false);
    expect(getBuffer(conn.network.user_id, conn.network.id, '#apple')?.autojoin).toBe(false);
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'channel-parted', target: '#apple' }),
    );
  });

  it('442 still surfaces the error in the server buffer', () => {
    const conn = makeConn('notonchan-line');
    conn.upsertChannel('#apple');
    const publish = vi.fn<(event: unknown) => void>();
    conn.publish = publish;

    conn.client.emit('irc error', {
      error: 'not_on_channel',
      channel: '#apple',
      reason: "You're not on that channel",
    });

    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', target: `:server:${conn.network.id}` }),
    );
  });

  it('442 for a channel with no row does not conjure one', () => {
    // Correcting state must not CREATE it: a typo'd /part answered with 442
    // used to leave a phantom channels row behind. setAutojoin is update-only,
    // so the registry stays empty.
    const conn = makeConn('notonchan-phantom');
    conn.client.emit('irc error', {
      error: 'not_on_channel',
      channel: '#never-joined',
      reason: "You're not on that channel",
    });
    expect(listBufferRowsForNetwork(conn.network.id)).toHaveLength(0);
  });

  it('442 corrects a stale autojoin row even when the channel is not in the joined set', () => {
    // The in-memory set and the persisted row can disagree — after a restart
    // the row survives while this.channels is empty. The row is what
    // auto-rejoins, so it must be corrected regardless of whether we happened
    // to be tracking the channel.
    const conn = makeConn('notonchan-stale');
    ensureBufferOpen(conn.network.user_id, conn.network.id, '#apple', {
      kind: 'channel',
      autojoin: true,
    });
    expect(conn.channels.has('#apple')).toBe(false);

    conn.client.emit('irc error', {
      error: 'not_on_channel',
      channel: '#apple',
      reason: "You're not on that channel",
    });

    expect(getBuffer(conn.network.user_id, conn.network.id, '#apple')?.autojoin).toBe(false);
  });
});
