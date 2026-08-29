// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// MUST be first: redirects DATABASE_PATH to a throwaway file before the static
// import of ircConnection.js below pulls in db/index.js (which opens its file
// at module-load time). Without this, the IrcConnections built in these tests
// write straight into the real data/lurker.db.
import '../test-utils/isolateDb.js';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
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
  outgoingNickIntents,
  commandResultError,
  isCommandResultErrorTag,
  sendRejectionTargetKind,
  sendRejectionText,
  outgoingAddr,
  resolveKeyModeChange,
} from './ircConnection.js';
import { createIdentdServer, unregisterIdent } from './identd.js';
import connectScheduler from './connectScheduler.js';
import { getRecent } from './systemLog.js';
import { createUser } from '../db/users.js';
import { createNetwork, getNetwork } from '../db/networks.js';
import {
  getBuffer,
  ensureOpen as ensureBufferOpen,
  seedAutojoinChannel,
  listForNetwork as listBufferRowsForNetwork,
} from '../db/buffers.js';
import { getPeerPresence, writePeerState } from '../db/peerPresence.js';
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

  it('resolves every channel prefix once joined, not just `#` (#724)', () => {
    // This test used to assert the opposite, on the rationale that "Lurker routes `&`/`!`/`+`
    // targets as non-channels" — which was the bug, not a decision. Now that both tiers classify
    // all four prefixes, a channel-context tag naming a joined `&local` must resolve to it;
    // refusing would strand the notice in the server buffer instead of its channel.
    const withLocal = new Map([
      ['#christian', { name: '#Christian' }],
      ['&local', { name: '&local' }],
    ]);
    expect(resolveChannelContext({ '+draft/channel-context': '&local' }, 'x', withLocal)).toBe(
      '&local',
    );
    expect(resolveChannelContext(undefined, '[&local] hi', withLocal)).toBe('&local');
  });

  it('still refuses a channel prefix we are NOT joined to', () => {
    // The membership check is what keeps this safe — widening the prefix set must not turn any
    // bracketed `[+foo]` in a notice body into a redirect target.
    const channels = new Map([['#christian', { name: '#Christian' }]]);
    expect(resolveChannelContext({ '+draft/channel-context': '&nope' }, 'x', channels)).toBe(null);
    expect(resolveChannelContext(undefined, '[+nope] hi', channels)).toBe(null);
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
        casemapping: null,
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
        casemapping: null,
        created_at: new Date().toISOString(),
      },
      onEvent: () => {},
    });
  }

  // A peer tracked while connected must get a MONITOR S follow-up: the server
  // only SHOULD (not MUST) volunteer current state in reply to MONITOR +, so
  // without the explicit status query a freshly-added offline peer lands with
  // no state and renders as if online until a reconnect re-seeds.
  it('follows MONITOR + with MONITOR S when a peer is tracked on a live connection', () => {
    const conn = makeConn();
    conn.useMonitor = true;
    conn.monitorLimit = 100;
    conn.state = 'connected';
    const raw = vi.fn<(...args: string[]) => void>();
    conn.client.raw = raw;

    conn.trackDmPeer('offlinepal');

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

    conn.trackDmPeer('offlinepal');

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
        casemapping: null,
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

// A channel command that fails (kick / invite / mode / topic) used to report
// only in the server buffer, far from the channel the user ran it in (#434).
describe('command-result error classification (#434)', () => {
  it('reads the channel out of ERR_CHANOPRIVSNEEDED (482)', () => {
    expect(commandResultError('482', ['me', '#chan', "You're not channel operator"])).toEqual({
      channel: '#chan',
      text: "You're not a channel operator.",
    });
  });

  it('takes ERR_USERNOTINCHANNEL (441) from the wire, not the framework', () => {
    // The whole reason this reads raw params. irc-framework's generic map for
    // 441 is off by one against its own 443: it reports OUR nick as `nick` and
    // the target NICK as `channel`, so an event-driven version of this would
    // publish into a buffer called "baduser".
    expect(
      commandResultError('441', ['me', 'baduser', '#chan', "They aren't on that channel"]),
    ).toEqual({ channel: '#chan', text: "baduser isn't on this channel." });
  });

  it('names the subject for ERR_USERONCHANNEL (443), which sends a fragment', () => {
    // The server's own trailing text is "is already on channel" — a sentence
    // with its subject missing, which is why these messages are ours.
    expect(commandResultError('443', ['me', 'bob', '#chan', 'is already on channel'])).toEqual({
      channel: '#chan',
      text: 'bob is already on this channel.',
    });
  });

  it('covers the mode failures irc-framework never models at all', () => {
    expect(commandResultError('467', ['me', '#chan', 'Channel key already set'])?.channel).toBe(
      '#chan',
    );
    expect(commandResultError('478', ['me', '#chan', 'b', 'Channel list is full'])?.channel).toBe(
      '#chan',
    );
  });

  it('names the list that actually filled up on ERR_BANLISTFULL (478)', () => {
    // Not always +b: the invite-exception and quiet limits send the same
    // numeric, so a hardcoded "ban list" would report the wrong one.
    expect(commandResultError('478', ['me', '#chan', 'I', 'Channel list is full'])?.text).toBe(
      "The channel's +I list is full.",
    );
  });

  it('stays vague on a 478 that omits the mode char', () => {
    // Without the guard params[2] is the trailing reason, and the sentence
    // becomes "The channel's +Channel list is full list is full."
    expect(commandResultError('478', ['me', '#chan', 'Channel list is full'])?.text).toBe(
      'That channel list is full.',
    );
  });

  it('accepts every channel prefix, not just #', () => {
    expect(commandResultError('482', ['me', '&local', 'nope'])?.channel).toBe('&local');
  });

  it('declines a numeric it does not own', () => {
    expect(commandResultError('401', ['me', 'ghost', 'No such nick'])).toBeNull();
    expect(commandResultError('482', [])).toBeNull();
  });

  it('declines when the channel param is not a channel', () => {
    // A server shipping these params in another order must not be routed on.
    expect(commandResultError('482', ['me', 'notachannel', 'nope'])).toBeNull();
    expect(commandResultError('441', ['me', '#chan', 'baduser', 'nope'])).toBeNull();
  });

  it('declines when the subject param is missing', () => {
    expect(commandResultError('443', ['me', '', '#chan'])).toBeNull();
  });

  it('claims exactly the tags whose server-buffer line is now a duplicate', () => {
    expect(isCommandResultErrorTag('chanop_privs_needed')).toBe(true);
    expect(isCommandResultErrorTag('user_not_in_channel')).toBe(true);
    expect(isCommandResultErrorTag('user_on_channel')).toBe(true);
    // Owned by other buckets — must keep their existing routing.
    expect(isCommandResultErrorTag('cannot_send_to_channel')).toBe(false);
    expect(isCommandResultErrorTag('banned_from_channel')).toBe(false);
    expect(isCommandResultErrorTag('no_such_nick')).toBe(false);
  });
});

// ERR_NOSUCHNICK names no channel, so the only thing that can place it is the
// command we sent — which the server, unlike the client, gets to read on the
// way out (#434).
describe('outgoing nick intent extraction (#434)', () => {
  it('reads KICK, whose channel comes first', () => {
    expect(outgoingNickIntents('KICK #anime fartboy')).toEqual([
      { nick: 'fartboy', channel: '#anime' },
    ]);
  });

  it('reads INVITE, whose operands are the other way round', () => {
    expect(outgoingNickIntents('INVITE fartboy #anime')).toEqual([
      { nick: 'fartboy', channel: '#anime' },
    ]);
  });

  it("doesn't mistake a word in a kick reason for a target", () => {
    expect(outgoingNickIntents('KICK #anime fartboy :go away bob')).toEqual([
      { nick: 'fartboy', channel: '#anime' },
    ]);
  });

  it('expands the comma lists KICK is allowed to carry', () => {
    expect(outgoingNickIntents('KICK #a,#b x,y')).toHaveLength(4);
  });

  it('takes MODE arguments without deciding which are nicks', () => {
    // Whether an arg is a nick depends on the mode string read against
    // CHANMODES; recording a mask or a limit anyway is inert, because it can
    // only match a 401 naming that exact string and a 401 names a bare nick.
    expect(outgoingNickIntents('MODE #anime +o ghost')).toEqual([
      { nick: 'ghost', channel: '#anime' },
    ]);
    expect(outgoingNickIntents('MODE #anime +b *!*@host')).toEqual([
      { nick: '*!*@host', channel: '#anime' },
    ]);
  });

  it('records a channel-less intent for commands that name a nick alone', () => {
    // Not "nothing to record": a positive statement that the user's last move
    // on this nick was direct, which has to overwrite a pending kick.
    expect(outgoingNickIntents('WHOIS fartboy')).toEqual([{ nick: 'fartboy', channel: null }]);
    expect(outgoingNickIntents('PRIVMSG fartboy :hi')).toEqual([
      { nick: 'fartboy', channel: null },
    ]);
  });

  it('claims nothing from a channel-directed message or a bare MODE query', () => {
    expect(outgoingNickIntents('PRIVMSG #anime :hi')).toEqual([]);
    expect(outgoingNickIntents('MODE #anime')).toEqual([]);
    expect(outgoingNickIntents('')).toEqual([]);
  });

  it('rejects operands the wrong way round rather than guessing', () => {
    expect(outgoingNickIntents('INVITE #anime #other')).toEqual([]);
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
        casemapping: null,
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

  // #434 — the third routing bucket. Driven through the 'raw' handler because
  // that is where it lives: it is the only place with the numeric's params
  // intact (see COMMAND_RESULT_ERRORS on why the parsed event won't do).
  function emitRaw(conn: IrcConnection, line: string) {
    conn.client.emit('raw', { from_server: true, line });
  }

  it('routes ERR_CHANOPRIVSNEEDED (482) inline to the channel the command ran in', () => {
    const conn = makeConn();
    conn.upsertChannel('#anime');
    const publish = vi.fn<(event: unknown) => void>();
    conn.publish = publish;

    emitRaw(conn, ":irc.example.test 482 nick #anime :You're not channel operator");

    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        target: '#anime',
        text: "You're not a channel operator.",
      }),
    );
  });

  it('still logs the server\u2019s own line to the server buffer', () => {
    // Additive, like a join rejection: the friendly line goes to the channel,
    // the authentic record stays in the server buffer (#342).
    const conn = makeConn();
    conn.upsertChannel('#anime');
    const publish = vi.fn<(event: unknown) => void>();
    conn.publish = publish;

    emitRaw(conn, ":irc.example.test 482 nick #anime :You're not channel operator");

    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'motd',
        target: ':server:1',
        text: "#anime You're not channel operator",
      }),
    );
  });

  it('routes 441 to the channel, never to the nick the framework calls a channel', () => {
    const conn = makeConn();
    conn.upsertChannel('#anime');
    const publish = vi.fn<(event: unknown) => void>();
    conn.publish = publish;

    emitRaw(conn, ":irc.example.test 441 nick baduser #anime :They aren't on that channel");

    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', target: '#anime' }),
    );
    expect(publish).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', target: 'baduser' }),
    );
  });

  it('publishes the channel under the name we joined it by, not the wire\u2019s', () => {
    // Membership and canonicalization used to be two different equivalence
    // relations here: isChannelJoined folds through the server's CASEMAPPING,
    // while publish()'s canonicalizer is a plain toLowerCase. They agree on
    // ASCII case and disagree on rfc1459, where [ \\ ] ^ fold to { | } ~ — so a
    // 482 naming #news{dev} while we were joined as #news[dev] passed the
    // membership test and then published a target no buffer is keyed by.
    // Resolving both through channelState is what fixes it; the fold rule
    // itself is channelState's and is tested where it lives. This pins the
    // wiring: that the handler publishes the name channelState hands back
    // rather than the one off the wire.
    const conn = makeConn();
    conn.channelState = ((name: string) =>
      name === '#news{dev}' ? { name: '#news[dev]' } : undefined) as never;
    const publish = vi.fn<(event: unknown) => void>();
    conn.publish = publish;

    emitRaw(conn, ":irc.example.test 482 nick #news{dev} :You're not channel operator");

    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', target: '#news[dev]' }),
    );
  });

  it('places a 401 in the channel the command that caused it was aimed at', () => {
    // The case a user actually hits: /kick someone who has left the network.
    // 401 carries no channel, so this is attributed from the outgoing line.
    const conn = makeConn();
    conn.upsertChannel('#anime');
    conn.client.raw = vi.fn<(line: string) => void>(); // don't touch a real socket
    const publish = vi.fn<(event: unknown) => void>();
    conn.publish = publish;

    conn.raw('KICK #anime fartboy');
    conn.client.emit('irc error', {
      error: 'no_such_nick',
      nick: 'fartboy',
      reason: 'No such nick/channel',
    });

    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        target: '#anime',
        text: "fartboy isn't on this network.",
      }),
    );
  });

  it('doesn\u2019t let a spent kick claim the query\u2019s 401 afterwards', () => {
    // The reported bug. Kick fartboy in #anime, then open a query with them and
    // send a message: both bounce 401, and the second belongs in the DM. The
    // attribution is consumed by the first, so it isn't lying in wait for the
    // second.
    const conn = makeConn();
    conn.upsertChannel('#anime');
    conn.client.raw = vi.fn<(line: string) => void>();
    conn.client.say = vi.fn<(target: string, message: string) => void>();
    const publish = vi.fn<(event: unknown) => void>();
    conn.publish = publish;

    conn.raw('KICK #anime fartboy');
    conn.client.emit('irc error', { error: 'no_such_nick', nick: 'fartboy' });
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ target: '#anime' }));

    publish.mockClear();
    conn.say('fartboy', 'hi');
    conn.client.emit('irc error', { error: 'no_such_nick', nick: 'fartboy' });

    expect(publish).not.toHaveBeenCalledWith(expect.objectContaining({ target: '#anime' }));
  });

  it('forgets an intent across a reconnect', () => {
    // The intent describes a command that went out on a socket that is now
    // gone; the reply to it died with it. Left in place, a kick nobody ever saw
    // the outcome of could place an unrelated 401 on the new connection —
    // resetSendState clears the sibling send-attribution maps for exactly this
    // reason (#283) and this one is the same class of state.
    const conn = makeConn();
    conn.upsertChannel('#anime');
    conn.client.raw = vi.fn<(line: string) => void>();
    const publish = vi.fn<(event: unknown) => void>();
    conn.publish = publish;

    conn.raw('KICK #anime fartboy');
    conn.resetSendState();
    conn.client.emit('irc error', { error: 'no_such_nick', nick: 'fartboy' });

    expect(publish).not.toHaveBeenCalledWith(expect.objectContaining({ target: '#anime' }));
  });

  it('attributes one command to one bounce, not to every 401 in the window', () => {
    // Pins the consume half specifically: the supersede rule only fires when
    // the user does something else with the nick, and a repeated numeric (a
    // bouncer replaying, a server sending it twice) isn't that.
    const conn = makeConn();
    conn.upsertChannel('#anime');
    conn.client.raw = vi.fn<(line: string) => void>();
    const publish = vi.fn<(event: unknown) => void>();
    conn.publish = publish;

    conn.raw('KICK #anime fartboy');
    conn.client.emit('irc error', { error: 'no_such_nick', nick: 'fartboy' });
    publish.mockClear();
    conn.client.emit('irc error', { error: 'no_such_nick', nick: 'fartboy' });

    expect(publish).not.toHaveBeenCalledWith(expect.objectContaining({ target: '#anime' }));
  });

  it('lets a direct send supersede a kick that never bounced', () => {
    // Same hazard without the first 401 to consume the entry: the kick may have
    // succeeded, or failed some other way. Messaging the nick says the user has
    // moved on, so the 401 that follows answers the message.
    const conn = makeConn();
    conn.upsertChannel('#anime');
    conn.client.raw = vi.fn<(line: string) => void>();
    conn.client.say = vi.fn<(target: string, message: string) => void>();
    const publish = vi.fn<(event: unknown) => void>();
    conn.publish = publish;

    conn.raw('KICK #anime fartboy');
    conn.say('fartboy', 'hi');
    conn.client.emit('irc error', { error: 'no_such_nick', nick: 'fartboy' });

    expect(publish).not.toHaveBeenCalledWith(expect.objectContaining({ target: '#anime' }));
  });

  it('lets a whois supersede it too', () => {
    // Same rule, via raw() rather than say(): "did that kick work? who is
    // fartboy?" must not put the whois miss back in the channel.
    const conn = makeConn();
    conn.upsertChannel('#anime');
    conn.client.raw = vi.fn<(line: string) => void>();
    const publish = vi.fn<(event: unknown) => void>();
    conn.publish = publish;

    conn.raw('KICK #anime fartboy');
    conn.raw('WHOIS fartboy');
    conn.client.emit('irc error', { error: 'no_such_nick', nick: 'fartboy' });

    expect(publish).not.toHaveBeenCalledWith(expect.objectContaining({ target: '#anime' }));
  });

  it('leaves an unprompted 401 alone', () => {
    // No command of ours named this nick, so there is nothing to attribute it
    // to and it keeps its existing server-buffer routing.
    const conn = makeConn();
    conn.upsertChannel('#anime');
    const publish = vi.fn<(event: unknown) => void>();
    conn.publish = publish;

    conn.client.emit('irc error', { error: 'no_such_nick', nick: 'stranger' });

    expect(publish).not.toHaveBeenCalledWith(expect.objectContaining({ target: '#anime' }));
  });

  it("doesn't drag an unrelated /whois miss into the channel", () => {
    // Attribution is keyed on the NICK, not on "a command went out recently",
    // so a 401 for a different nick inside the same window stays put.
    const conn = makeConn();
    conn.upsertChannel('#anime');
    conn.client.raw = vi.fn<(line: string) => void>();
    const publish = vi.fn<(event: unknown) => void>();
    conn.publish = publish;

    conn.raw('KICK #anime fartboy');
    conn.client.emit('irc error', { error: 'no_such_nick', nick: 'someoneelse' });

    expect(publish).not.toHaveBeenCalledWith(expect.objectContaining({ target: '#anime' }));
  });

  it('leaves a command aimed at a channel we are not in in the server buffer', () => {
    // No buffer to land in, and fabricating one would be worse than the status
    // quo. The raw line still reports it.
    const conn = makeConn();
    const publish = vi.fn<(event: unknown) => void>();
    conn.publish = publish;

    emitRaw(conn, ":irc.example.test 482 nick #elsewhere :You're not channel operator");

    expect(publish).not.toHaveBeenCalledWith(expect.objectContaining({ target: '#elsewhere' }));
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ target: ':server:1' }));
  });

  it('puts the first DM to a nick that does not exist in the query (#817)', () => {
    // The reported bug. Under echo-message nothing is persisted for a send the
    // server never echoes, so the has-DM-history gate is false by construction
    // on a FIRST message — the one case where the user most needs to be told.
    // The DB here is empty, which is exactly that state.
    const conn = makeConn();
    conn.client.say = vi.fn<(target: string, message: string) => void>();
    const publish = vi.fn<(event: unknown) => void>();
    conn.publish = publish;

    conn.say('fartboy', 'you stink');
    conn.client.emit('irc error', {
      error: 'no_such_nick',
      nick: 'fartboy',
      reason: 'No such nick/channel',
    });

    // In the query, not the server buffer, and in the same words the channel
    // routing and the profile modal use rather than the server's raw
    // "No such nick/channel". The publish is what leaves a buffer behind as
    // well: an 'error' row persists, so the query survives a reload.
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        target: 'fartboy',
        text: "fartboy isn't on this network.",
      }),
    );
    expect(publish).not.toHaveBeenCalledWith(expect.objectContaining({ target: ':server:1' }));
  });

  it('still refuses to open a query from a /whois miss', () => {
    // The guard rail on the widened gate. recentUserSend is set only by
    // say/action/notice, so looking someone up must not conjure a DM buffer for
    // a nick the user never messaged — it stays in the server buffer.
    const conn = makeConn();
    conn.client.raw = vi.fn<(line: string) => void>();
    const publish = vi.fn<(event: unknown) => void>();
    conn.publish = publish;

    conn.raw('WHOIS fartboy');
    conn.client.emit('irc error', { error: 'no_such_nick', nick: 'fartboy' });

    expect(publish).not.toHaveBeenCalledWith(expect.objectContaining({ target: 'fartboy' }));
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ target: ':server:1' }));
  });

  it("doesn't open a query from a /ctcp to a nick that isn't there", () => {
    // A CTCP is a real user-initiated PRIVMSG, so it marks the send — but its
    // outcome is reported into the buffer it was issued from, and answering the
    // 401 with a brand-new query would both fabricate a conversation the user
    // never started and split the exchange across two buffers.
    const conn = makeConn();
    conn.upsertChannel('#anime');
    conn.client.ctcpRequest = vi.fn<(target: string, type: string, payload?: string) => void>();
    const publish = vi.fn<(event: unknown) => void>();
    conn.publish = publish;

    conn.sendCtcpRequest('#anime', 'fartboy', 'VERSION', '');
    conn.client.emit('irc error', { error: 'no_such_nick', nick: 'fartboy' });

    expect(publish).not.toHaveBeenCalledWith(expect.objectContaining({ target: 'fartboy' }));
  });

  it('still surfaces a refused CTCP — in the buffer it was issued from', () => {
    // The guard above must not go so far as to silence 531 for a CTCP:
    // handleSendRejection reads recentUserSend to tell a real send from a
    // typing bounce, and a CTCP is a real send.
    //
    // ⚠ Where it surfaces changed in #821. This used to publish a persisted
    // error into the fartboy DM — one of the three different places the same
    // command's failure could land — and now joins its own echo and reply in the
    // issuing buffer. The assertion that matters is unchanged: not silenced.
    const conn = makeConn();
    conn.client.ctcpRequest = vi.fn<(target: string, type: string, payload?: string) => void>();
    const publish = vi.fn<(event: unknown) => void>();
    const publishEphemeral = vi.fn<(event: Record<string, unknown>) => void>();
    conn.publish = publish;
    conn.publishEphemeral = publishEphemeral;

    conn.sendCtcpRequest(':server:1', 'fartboy', 'VERSION', '');
    expect(conn.recentUserSend('fartboy')).toBe(true);
    expect(conn.recentConversationalSend('fartboy')).toBe(false);

    conn.client.emit('irc error', {
      error: 'cannot_send_to_user',
      nick: 'fartboy',
      reason: 'They are blocking messages',
    });
    expect(publishEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'ctcp',
        target: ':server:1',
        text: 'Message not delivered — They are blocking messages',
      }),
    );
    expect(publish).not.toHaveBeenCalledWith(expect.objectContaining({ target: 'fartboy' }));
  });

  it('forgets the send attribution across a reconnect, so a stale 401 stays put', () => {
    // Same reasoning resetSendState already applies to the 531 path: a send on
    // a dead socket must not place the first bounce on the new one.
    const conn = makeConn();
    conn.client.say = vi.fn<(target: string, message: string) => void>();
    const publish = vi.fn<(event: unknown) => void>();
    conn.publish = publish;

    conn.say('fartboy', 'you stink');
    conn.resetSendState();
    conn.client.emit('irc error', { error: 'no_such_nick', nick: 'fartboy' });

    expect(publish).not.toHaveBeenCalledWith(expect.objectContaining({ target: 'fartboy' }));
  });

  it('drops the duplicate tag line the server buffer used to get as well', () => {
    // 482 reached the server buffer twice: the raw line, plus a
    // "chanop_privs_needed #anime — …" line from the 'irc error' catch-all.
    const conn = makeConn();
    conn.upsertChannel('#anime');
    const publish = vi.fn<(event: unknown) => void>();
    conn.publish = publish;

    conn.client.emit('irc error', {
      error: 'chanop_privs_needed',
      channel: '#anime',
      reason: "You're not channel operator",
    });

    expect(publish).not.toHaveBeenCalled();
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

  // Found by QA against a real ergo 2.18, not by reading the RFC: 477 has a
  // THIRD meaning. A DM refused because the recipient only accepts messages from
  // registered users (+R) answers 477 naming the NICK — where the code, and
  // issue #821, both expected 531.
  //
  //   :ergo.test 477 me blocker :You must be registered to send a direct message
  //
  // params[1] is where a channel normally sits, so this raised a JOIN toast, in
  // the peer's DM, telling the user "This channel requires a registered
  // nickname" about a person.
  it('treats a 477 that names a nick as a send rejection, not a join failure', () => {
    const conn = makeConn();
    const publish = vi.fn<(event: unknown) => void>();
    const publishEphemeral = vi.fn<(event: unknown) => void>();
    conn.publish = publish;
    conn.publishEphemeral = publishEphemeral;
    conn.client.say = vi.fn<(target: string, message: string) => void>();
    conn.say('blocker', 'hi'); // marks the send, so the rejection is attributable

    conn.client.emit('unknown command', {
      command: '477',
      params: ['me', 'blocker', 'You must be registered to send a direct message to this user'],
    });

    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        target: 'blocker',
        text: 'Message not delivered — You must be registered to send a direct message to this user',
      }),
    );
    // Nothing can be joined that isn't a channel, so no join toast may fire.
    expect(publishEphemeral).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'join-error' }),
    );
  });

  it('routes a nick-targeted 477 for a /ctcp back to the issuing buffer', () => {
    // The #821 rule has to hold for every way a CTCP can be refused, or the same
    // command still reports in two places depending on which numeric the ircd
    // happens to use — and on ergo this is the one it uses.
    const conn = makeConn();
    conn.upsertChannel('#anime');
    conn.client.ctcpRequest = vi.fn<(target: string, type: string, payload?: string) => void>();
    const publish = vi.fn<(event: unknown) => void>();
    const publishEphemeral = vi.fn<(event: Record<string, unknown>) => void>();
    conn.publish = publish;
    conn.publishEphemeral = publishEphemeral;

    conn.sendCtcpRequest('#anime', 'blocker', 'VERSION', '');
    conn.client.emit('unknown command', {
      command: '477',
      params: ['me', 'blocker', 'You must be registered to send a direct message to this user'],
    });

    expect(publishEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'ctcp',
        target: '#anime',
        text: 'Message not delivered — You must be registered to send a direct message to this user',
      }),
    );
    expect(publish).not.toHaveBeenCalledWith(expect.objectContaining({ target: 'blocker' }));
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
        casemapping: null,
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
        casemapping: null,
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

// #785. Clicking Disconnect during a backoff cancels the retry ladder, and until
// now nothing said so — the outage's first "Reconnecting in Ns (attempt 1)…" is a
// PERSISTED row, so the server buffer's last word on the subject was a promise to
// retry that we then quietly broke.
describe('cancelled-reconnect notice (#785)', () => {
  // The notice is PERSISTED, not ephemeral — an ephemeral one would leave the
  // outage's "Reconnecting in Ns (attempt 1)…" row dangling in history with no
  // resolution, which is the complaint. So this needs a real network to insert
  // against.
  beforeAll(() => {
    if (!getNetwork(1, 1)) {
      createNetwork(1, {
        name: 'n',
        host: 'irc.example.test',
        port: 6697,
        tls: true,
        nick: 'nick',
      });
    }
  });

  function makeConn(events: unknown[]): IrcConnection {
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
        casemapping: null,
        created_at: new Date().toISOString(),
      },
      onEvent: (e: unknown) => events.push(e),
    });
  }

  function cancelText(events: unknown[]): string[] {
    return (events as Array<{ type?: string; text?: string }>)
      .filter((e) => e.type === 'notice' && /Reconnecting cancelled/.test(e.text ?? ''))
      .map((e) => e.text as string);
  }

  it('announces the cancellation when a retry was pending', () => {
    const events: unknown[] = [];
    const conn = makeConn(events);
    conn.client.quit = vi.fn<(reason?: string) => void>();
    conn.setState('reconnecting');
    conn.disconnect(undefined, { announceCancelledRetry: true });
    expect(cancelText(events)).toEqual(['Reconnecting cancelled — disconnected.']);
    expect(conn.state).toBe('disconnected');
  });

  it('says nothing when there was no retry to cancel', () => {
    // A normal /quit closes a healthy socket; it was never mid-ladder, and the
    // 'close' handler is what settles the state.
    const events: unknown[] = [];
    const conn = makeConn(events);
    conn.client.quit = vi.fn<(reason?: string) => void>();
    conn.setState('connected');
    conn.disconnect(undefined, { announceCancelledRetry: true });
    expect(cancelText(events)).toEqual([]);
  });

  // ⚠⚠ disconnect() is also how a PAUSE and a shutdown tear connections down.
  // Neither is the user cancelling anything, and announcing by default would
  // write this row into every network that happened to be reconnecting.
  it('stays silent on the paths that are not a person asking', () => {
    const events: unknown[] = [];
    const conn = makeConn(events);
    conn.client.quit = vi.fn<(reason?: string) => void>();
    conn.setState('reconnecting');
    conn.disconnect('shutting down');
    expect(cancelText(events)).toEqual([]);
    expect(conn.state).toBe('disconnected');
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
        casemapping: null,
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
        casemapping: null,
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
    conn.trackDmPeer('awaypal');
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

  it('markAllPeersOffline forces every tracked peer offline', () => {
    const conn = makeConn('disco');
    conn.trackDmPeer('pal');
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

  // Rows left behind by anything that no longer tracks the nick (the removed
  // friends system being the motivating case) can never be refreshed — but
  // they WOULD be served as live state if the nick is ever re-tracked, and on
  // a no-MONITOR network nothing ever corrects them. The hydrate-time orphan
  // sweep deletes them; rows for still-tracked peers survive.
  it('sweepUntrackedPresenceRows deletes rows for untracked nicks and keeps tracked ones', () => {
    const conn = makeConn('orphan-sweep');
    conn.trackDmPeer('keptpal');
    // Simulate leftovers: rows written under a prior regime for nicks nothing
    // tracks anymore (writePeerState bypasses the eligiblePeer gate on purpose).
    writePeerState(conn.network.id, 'exfriend', 'online', new Date().toISOString(), null);
    writePeerState(conn.network.id, 'keptpal', 'away', new Date().toISOString(), 'brb');

    conn.sweepUntrackedPresenceRows();

    expect(getPeerPresence(conn.network.id, 'exfriend')).toBeNull();
    expect(getPeerPresence(conn.network.id, 'keptpal')?.state).toBe('away');
  });

  // dispose() sets disposed=true before the socket tears down; on a deletion
  // dispose the network row (+ its peer_presence_state rows) may already be gone
  // when the async socket-close fires, so a write here would hit a FK violation.
  // The guard makes the sweep a no-op in that window.
  it('is a no-op when the connection is disposed (avoids a post-delete FK write)', () => {
    const conn = makeConn('disco-disposed');
    conn.trackDmPeer('pal');
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
    conn.trackDmPeer('pal');
    conn.markPeerEvent('pal', 'online');
    conn.client.emit('socket close', {});
    expect(getPeerPresence(conn.network.id, 'pal')?.state).toBe('offline');
  });

  it('WHO-on-join promotes a still-present peer back to online after the sweep', () => {
    const conn = makeConn('relight');
    conn.publish = vi.fn<typeof conn.publish>(); // assert on presence, not history
    conn.client.user.nick = 'me';
    conn.trackDmPeer('chanpal');
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
    conn.trackDmPeer('awaychan');
    conn.client.emit('join', { channel: '#room', nick: 'awaychan' });
    conn.client.emit('wholist', { target: '#room', users: [{ nick: 'awaychan', away: true }] });
    expect(getPeerPresence(conn.network.id, 'awaychan')?.state).toBe('away');
    // A later WHO with the away flag cleared must move away → back (renders online).
    conn.client.emit('wholist', { target: '#room', users: [{ nick: 'awaychan', away: false }] });
    expect(getPeerPresence(conn.network.id, 'awaychan')?.state).toBe('back');
  });
});

// Lurker owns the reconnect policy now (irc-framework's auto_reconnect is off).
// The controller retries any transient drop indefinitely with exponential
// backoff, but stops for an intentional disconnect or a classified-terminal
// reason (detected ban / hard SASL auth failure). Timers are faked; the actual
// socket open (conn.connect) is stubbed so no real connection is attempted.
describe('auto-reconnect controller', () => {
  function makeConn(name: string): { conn: IrcConnection; events: Record<string, unknown>[] } {
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
    const events: Record<string, unknown>[] = [];
    const conn = new IrcConnection({
      network,
      onEvent: (e) => events.push(e as Record<string, unknown>),
    });
    // Never open a real socket when the backoff fires.
    vi.spyOn(conn, 'connect').mockImplementation(() => {});
    return { conn, events };
  }

  // Emit 'registered' the way these stubbed connections must: connect() is
  // mocked, so the library's own 'registered' listener has no live
  // connection.options — pin harmless ping settings first so its
  // startPeriodicPing early-returns instead of dereferencing null.
  function emitRegistered(conn: IrcConnection): void {
    (conn.client as unknown as { options: unknown }).options = {
      ping_interval: 0,
      ping_timeout: 0,
    };
    conn.client.emit('registered', { nick: 'nick' });
  }

  // The connectScheduler is a process-wide singleton; clear its per-host gate
  // state before each test so a prior run's timestamps can't delay this launch.
  beforeEach(() => connectScheduler.reset());
  afterEach(() => {
    connectScheduler.reset();
    vi.useRealTimers();
  });

  it('schedules a backoff reconnect after an unexpected socket close', () => {
    vi.useFakeTimers();
    const { conn } = makeConn('rc-basic');
    conn.client.emit('close', false);
    expect(conn.state).toBe('reconnecting');
    expect(conn.connect).not.toHaveBeenCalled(); // still waiting out the backoff
    vi.runAllTimers();
    expect(conn.connect).toHaveBeenCalledTimes(1);
  });

  // The core gap this overhaul fixes: irc-framework only retried a connection
  // that had been healthy for >5s, so an initial-connect failure (DNS/refused/
  // registration timeout — never 'registered') got ZERO retries. It must now
  // reconnect like any other transient drop.
  it('reconnects after a never-registered initial-connect failure', () => {
    vi.useFakeTimers();
    const { conn } = makeConn('rc-initial');
    conn.client.emit('socket close', { code: 'ECONNREFUSED' });
    conn.client.emit('close', true);
    vi.runAllTimers();
    expect(conn.connect).toHaveBeenCalledTimes(1);
  });

  // A user who hits Disconnect while the network is mid-backoff has no live
  // socket to close, so quit() emits no 'close' — disconnect() must assert the
  // terminal 'disconnected' state itself or the UI stays stuck on 'Reconnecting'.
  it('settles to disconnected when the user disconnects mid-reconnect', () => {
    vi.useFakeTimers();
    const { conn } = makeConn('rc-mid');
    conn.client.emit('close', false); // drop → enters reconnecting/backoff
    expect(conn.state).toBe('reconnecting');
    conn.disconnect(); // user stops it while the backoff is still pending
    expect(conn.state).toBe('disconnected');
    vi.runAllTimers();
    expect(conn.connect).not.toHaveBeenCalled();
  });

  it('does not reconnect after an intentional disconnect', () => {
    vi.useFakeTimers();
    const { conn } = makeConn('rc-intentional');
    conn.disconnect(); // records intent; quit() is a no-op with no live socket
    conn.client.emit('close', false);
    vi.runAllTimers();
    expect(conn.connect).not.toHaveBeenCalled();
    expect(conn.state).toBe('disconnected');
  });

  // #616: auto-reconnect used to call connect() directly, walking past the
  // paused-account and network-lockdown gates every other connect path clears.
  describe('policy gate', () => {
    function makeGatedConn(
      name: string,
      gate: () => { ok: true } | { ok: false; reason: string },
    ): { conn: IrcConnection; events: Record<string, unknown>[] } {
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
      const events: Record<string, unknown>[] = [];
      const conn = new IrcConnection({
        network,
        onEvent: (e) => events.push(e as Record<string, unknown>),
        reconnectGate: gate,
      });
      vi.spyOn(conn, 'connect').mockImplementation(() => {});
      return { conn, events };
    }

    it('opens the socket when the gate allows it', () => {
      vi.useFakeTimers();
      const { conn } = makeGatedConn('rc-gate-ok', () => ({ ok: true }));
      conn.client.emit('close', true);
      vi.runAllTimers();
      expect(conn.connect).toHaveBeenCalledTimes(1);
    });

    it('refuses to reconnect a paused account', () => {
      vi.useFakeTimers();
      const { conn, events } = makeGatedConn('rc-gate-paused', () => ({
        ok: false,
        reason: 'this account is paused',
      }));
      conn.client.emit('close', true);
      vi.runAllTimers();
      expect(conn.connect).not.toHaveBeenCalled();
      expect(
        events.some((e) => e.type === 'error' && /account is paused/i.test(String(e.text))),
      ).toBe(true);
    });

    // The part review insisted on: scheduleReconnectIfWarranted has ALREADY
    // announced 'reconnecting' by the time the gate is asked, so a silent refusal
    // would pin the network on "Reconnecting…" forever — the exact stuck state
    // the auto-reconnect overhaul removed.
    it('settles to disconnected rather than hanging on "reconnecting"', () => {
      vi.useFakeTimers();
      const { conn } = makeGatedConn('rc-gate-state', () => ({
        ok: false,
        reason: 'this account is paused',
      }));
      conn.client.emit('close', true);
      expect(conn.state).toBe('reconnecting');
      vi.runAllTimers();
      expect(conn.state).toBe('disconnected');
    });

    // Read live, not captured at construction: a user paused DURING the backoff
    // wait must not get a socket out of a decision made before they were paused.
    it('asks the gate at launch time, not when the retry was scheduled', () => {
      vi.useFakeTimers();
      let allowed = true;
      const { conn } = makeGatedConn('rc-gate-live', () =>
        allowed ? { ok: true } : { ok: false, reason: 'this account is paused' },
      );
      conn.client.emit('close', true);
      expect(conn.state).toBe('reconnecting');
      allowed = false; // paused mid-backoff
      vi.runAllTimers();
      expect(conn.connect).not.toHaveBeenCalled();
    });

    // A gate that THROWS is not a gate that refuses. It reads the DB, so
    // SQLITE_BUSY or a closed handle can take it out — and connectScheduler only
    // console.errors a throwing task, with the backoff timer already spent. If
    // this escaped, the network would sit on "Reconnecting…" with nothing left
    // to fire it.
    it('re-arms rather than stranding the network when the gate throws', () => {
      vi.useFakeTimers();
      let throws = true;
      const { conn } = makeGatedConn('rc-gate-throws', () => {
        if (throws) throw new Error('SQLITE_BUSY: database is locked');
        return { ok: true };
      });
      conn.client.emit('close', true);
      // Bounded advance, not runAllTimers: a re-arming ladder never drains.
      vi.advanceTimersByTime(5 * 60 * 1000);
      // The failed reads cost attempts, not the ladder itself.
      expect(conn.connect).not.toHaveBeenCalled();
      expect(conn.state).toBe('reconnecting');

      throws = false;
      vi.advanceTimersByTime(5 * 60 * 1000);
      expect(conn.connect).toHaveBeenCalledTimes(1);
    });

    it('stops the ladder — a refusal does not schedule another attempt', () => {
      vi.useFakeTimers();
      const { conn } = makeGatedConn('rc-gate-stops', () => ({
        ok: false,
        reason: `irc.example.test is not permitted by this instance`,
      }));
      conn.client.emit('close', true);
      vi.runAllTimers();
      vi.advanceTimersByTime(10 * 60 * 1000);
      expect(conn.connect).not.toHaveBeenCalled();
    });
  });

  it('stops (no reconnect) and surfaces a notice on a detected server ban', () => {
    vi.useFakeTimers();
    const { conn, events } = makeConn('rc-ban');
    conn.client.emit('irc error', { error: 'irc', reason: 'Closing Link: nick[u@h] (G-Lined)' });
    conn.client.emit('close', true);
    vi.runAllTimers();
    expect(conn.connect).not.toHaveBeenCalled();
    expect(conn.state).toBe('disconnected');
    expect(
      events.some(
        (e) => e.type === 'error' && /Not reconnecting automatically/i.test(String(e.text)),
      ),
    ).toBe(true);
  });

  // #651: a ban-shaped ERROR that did NOT close its own socket must not lie in
  // wait — before the pending/promote treatment it set the terminal flag on
  // sight, and the next unrelated drop (netsplit, ping timeout, laptop lid)
  // inherited it and stopped auto-reconnect for good, telling the user they
  // were banned when they weren't. The survival proof is ORDERING, not time: a
  // real ban ERROR is the link's last line, so any later server line discards
  // the flag.
  it('a ban-shaped error followed by more server traffic does not poison a later drop', () => {
    vi.useFakeTimers();
    const { conn, events } = makeConn('rc-ban-stale');
    conn.client.emit('irc error', { error: 'irc', reason: 'you are banned from this server' });
    // The link keeps talking — proof the "ban" didn't kill it.
    conn.client.emit('raw', {
      from_server: true,
      line: ':irc.example.test PONG irc.example.test :keepalive',
    });
    vi.advanceTimersByTime(60 * 60 * 1000);
    conn.client.emit('close', true);
    vi.advanceTimersByTime(60 * 1000);
    expect(conn.connect).toHaveBeenCalled();
    expect(
      events.some(
        (e) => e.type === 'error' && /Not reconnecting automatically/i.test(String(e.text)),
      ),
    ).toBe(false);
  });

  // The counterpart that a wall-clock window would get wrong: an IP-level ban
  // whose FIN is blackholed closes only via the ping timeout, minutes after
  // the ERROR — but with NO lines in between, the ERROR was the link's last
  // word and must still be believed, or auto-reconnect hammers a server that
  // banned us forever.
  it('still stops when the close arrives long after the ban with no traffic in between', () => {
    vi.useFakeTimers();
    const { conn, events } = makeConn('rc-ban-blackhole');
    conn.client.emit('irc error', { error: 'irc', reason: 'Closing Link: nick[u@h] (Z-Lined)' });
    vi.advanceTimersByTime(120 * 1000); // irc-framework's ping timeout scale
    conn.client.emit('close', true);
    vi.runAllTimers();
    expect(conn.connect).not.toHaveBeenCalled();
    expect(
      events.some(
        (e) => e.type === 'error' && /Not reconnecting automatically/i.test(String(e.text)),
      ),
    ).toBe(true);
  });

  // Registration is proof positive too: whatever that line was, the server
  // kept us, so a close right after must retry.
  it('registering after a ban-shaped error clears it before any close can promote it', () => {
    vi.useFakeTimers();
    const { conn, events } = makeConn('rc-ban-registered');
    conn.client.emit('irc error', { error: 'irc', reason: 'you are banned from this server' });
    emitRegistered(conn);
    conn.client.emit('close', true);
    vi.advanceTimersByTime(60 * 1000);
    expect(conn.connect).toHaveBeenCalled();
    expect(
      events.some(
        (e) => e.type === 'error' && /Not reconnecting automatically/i.test(String(e.text)),
      ),
    ).toBe(false);
  });

  // Was "stops on a hard SASL authentication failure" — stopping on the FIRST
  // one is the behavior #617 changed, because a rejection the server didn't drop
  // us for would kill an unrelated later drop's reconnect. The intent it was
  // written for (bad credentials must not retry forever) is unchanged and still
  // asserted here; only the count moved.
  it('stops after a hard SASL authentication failure repeats', () => {
    vi.useFakeTimers();
    const { conn, events } = makeConn('rc-sasl');
    for (let i = 0; i < 3; i += 1) {
      conn.client.emit('sasl failed', { reason: 'fail' });
      conn.client.emit('close', true);
      vi.runAllTimers();
    }
    // Two retries, then the ladder ends — bounded, not a failed-login hammer.
    expect(conn.connect).toHaveBeenCalledTimes(2);
    expect(
      events.some((e) => e.type === 'error' && /SASL authentication failed/i.test(String(e.text))),
    ).toBe(true);
  });

  // #617: a single rejection is not proof the credentials killed THIS socket. On
  // a network where SASL is optional the server keeps us, so a later drop (a
  // stalled registration timing out, a blip) is unrelated and must still retry —
  // before this, that drop inherited the flag and killed reconnect forever.
  it('does not give up on the first SASL failure', () => {
    vi.useFakeTimers();
    const { conn } = makeConn('rc-sasl-first');
    conn.client.emit('sasl failed', { reason: 'fail' });
    conn.client.emit('close', true);
    vi.runAllTimers();
    expect(conn.connect).toHaveBeenCalledTimes(1);
  });

  // The optional-SASL recovery path the streak exists to protect: registering
  // unauthenticated proves the credentials aren't fatal here, so the count starts
  // over and a much later drop is still just a drop.
  it('resets the streak when registration succeeds despite repeated SASL failures', () => {
    vi.useFakeTimers();
    const { conn } = makeConn('rc-sasl-reset');
    for (let i = 0; i < 2; i += 1) {
      conn.client.emit('sasl failed', { reason: 'fail' });
      conn.client.emit('close', true);
      vi.runAllTimers();
    }
    emitRegistered(conn);

    // A third failure now starts a fresh streak rather than tipping the old one.
    conn.client.emit('sasl failed', { reason: 'fail' });
    conn.client.emit('close', true);
    vi.runAllTimers();
    expect(conn.connect).toHaveBeenCalledTimes(3);
  });

  // A rejection that didn't kill its own socket must not linger to be blamed for
  // a later one.
  it('consumes the pending SASL failure at the close it survived', () => {
    vi.useFakeTimers();
    const { conn } = makeConn('rc-sasl-consumed');
    conn.client.emit('sasl failed', { reason: 'fail' });
    conn.client.emit('close', true);
    vi.runAllTimers();
    expect(conn.connect).toHaveBeenCalledTimes(1);

    // Two further drops with no new SASL failure: nothing pending to promote, so
    // both are ordinary transients even though the streak sits at 1.
    conn.client.emit('close', true);
    vi.runAllTimers();
    conn.client.emit('close', true);
    vi.runAllTimers();
    expect(conn.connect).toHaveBeenCalledTimes(3);
  });

  // A clean SASL abort is transient (server hiccup), not a credential problem —
  // it must still reconnect.
  it('still reconnects after a clean SASL abort', () => {
    vi.useFakeTimers();
    const { conn } = makeConn('rc-sasl-abort');
    conn.client.emit('sasl failed', { reason: 'aborted' });
    conn.client.emit('close', true);
    vi.runAllTimers();
    expect(conn.connect).toHaveBeenCalledTimes(1);
  });

  // A SASL failure the server DIDN'T drop us for (we registered unauthenticated)
  // must not leave a stale terminal flag that blocks a later transient reconnect.
  it('clears the terminal flag when registration succeeds despite a SASL failure', () => {
    vi.useFakeTimers();
    const { conn } = makeConn('rc-sasl-recovered');
    conn.client.emit('sasl failed', { reason: 'fail' });
    emitRegistered(conn); // server let us in anyway
    conn.client.emit('close', false); // a later, unrelated drop
    vi.runAllTimers();
    expect(conn.connect).toHaveBeenCalledTimes(1);
  });

  it('resets the backoff ladder after a successful registration', () => {
    vi.useFakeTimers();
    const { conn, events } = makeConn('rc-reset');
    const attemptOf = (): number | null => {
      for (let i = events.length - 1; i >= 0; i--) {
        const m = /attempt (\d+)/.exec(String(events[i].text ?? ''));
        if (m) return Number(m[1]);
      }
      return null;
    };
    // First drop → attempt 1.
    conn.client.emit('close', false);
    expect(attemptOf()).toBe(1);
    vi.runAllTimers();
    // A full registration proves the network is reachable again → ladder resets.
    emitRegistered(conn);
    // Next drop starts back at attempt 1, not 2.
    conn.client.emit('close', false);
    expect(attemptOf()).toBe(1);
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
        casemapping: null,
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
        casemapping: null,
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
        casemapping: null,
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
        casemapping: null,
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

  // #486: prefix/membership modes come from ISUPPORT PREFIX, not a hardcode.
  // solanum/Libera declare `q` as a quiet LIST mode and leave it out of PREFIX;
  // the old q/a/o/h/v hardcode routed `+q` into the member branch, dropping it
  // before listModes() was consulted.
  function solanumIsupport(conn: IrcConnection): void {
    const options = conn.client.network.options as { CHANMODES?: unknown; PREFIX?: unknown };
    // `q` in group A (list), and absent from PREFIX — solanum's actual shape.
    options.CHANMODES = ['eIbq', 'k', 'flj', 'CFLMPQScgimnprstz'];
    options.PREFIX = [
      { symbol: '@', mode: 'o' },
      { symbol: '+', mode: 'v' },
    ];
  }

  // Grab the latest published `mode` row — the one that carries the stamped
  // change list the clients filter on.
  function latestModeRow(
    publish: ReturnType<typeof vi.fn>,
  ): { modes?: Array<{ mode: string; param?: string; kind?: string }> } | undefined {
    const calls = publish.mock.calls
      .map(
        (c) =>
          c[0] as { type: string; modes?: Array<{ mode: string; param?: string; kind?: string }> },
      )
      .filter((e) => e.type === 'mode');
    return calls.at(-1);
  }

  it('stamps each change with its class, so the clients can filter without ISUPPORT', () => {
    const conn = makeConn();
    solanumIsupport(conn);
    conn.upsertChannel('#chan');
    const publish = vi.fn<(event: unknown) => void>();
    conn.publish = publish;

    conn.client.emit('mode', {
      target: '#chan',
      modes: [
        { mode: '+o', param: 'alice' },
        { mode: '+b', param: '*!*@host' },
        { mode: '+m' },
        { mode: '+k', param: 'hunter2' },
      ],
      raw_modes: '+obmk',
      raw_params: ['alice', '*!*@host', 'hunter2'],
    });

    expect(latestModeRow(publish)?.modes).toEqual([
      { mode: '+o', param: 'alice', kind: 'prefix' },
      { mode: '+b', param: '*!*@host', kind: 'list' },
      { mode: '+m', kind: 'chan' },
      { mode: '+k', param: 'hunter2', kind: 'chan' },
    ]);
  });

  it('stamps solanum +q as list even though its param is a real member (#486)', () => {
    // The stamp and the member map have to reach the same verdict here, or a
    // quiet is filtered as op churn while being applied as a ban. They share
    // classifyModeChange precisely so they can't diverge — this pins both ends.
    const conn = makeConn();
    solanumIsupport(conn);
    const ch = conn.upsertChannel('#chan');
    ch.members.set('troll', {
      nick: 'troll',
      modes: [],
      away: false,
      user: null,
      host: null,
      account: null,
    });
    const publish = vi.fn<(event: unknown) => void>();
    conn.publish = publish;

    conn.client.emit('mode', {
      target: '#chan',
      modes: [{ mode: '+q', param: 'troll' }],
      raw_modes: '+q',
      raw_params: ['troll'],
    });

    expect(latestModeRow(publish)?.modes).toEqual([{ mode: '+q', param: 'troll', kind: 'list' }]);
    // …and the member map agrees: no phantom owner badge.
    expect(ch.members.get('troll')?.modes).toEqual([]);
  });

  it('stamps a param-less member mode as chan, matching where the handler applies it', () => {
    const conn = makeConn();
    solanumIsupport(conn);
    const ch = conn.upsertChannel('#chan');
    const publish = vi.fn<(event: unknown) => void>();
    conn.publish = publish;

    conn.client.emit('mode', {
      target: '#chan',
      modes: [{ mode: '+o' }],
      raw_modes: '+o',
      raw_params: [],
    });

    expect(latestModeRow(publish)?.modes).toEqual([{ mode: '+o', kind: 'chan' }]);
    // Tracked as a channel flag, which is what the handler has always done with
    // a malformed bare +o.
    expect(ch.modes.has('o')).toBe(true);
  });

  it('stamps modes for a channel it is not tracking members for', () => {
    // The class is a property of the letters and 005, not of whether the
    // channel is in our map — so the stamp must not sit behind the `ch` guard.
    const conn = makeConn();
    solanumIsupport(conn);
    const publish = vi.fn<(event: unknown) => void>();
    conn.publish = publish;

    conn.client.emit('mode', {
      target: '#untracked',
      modes: [{ mode: '+o', param: 'alice' }],
      raw_modes: '+o',
      raw_params: ['alice'],
    });

    expect(latestModeRow(publish)?.modes).toEqual([{ mode: '+o', param: 'alice', kind: 'prefix' }]);
  });

  it('stamps against the PREFIX fallback before 005 lands', () => {
    const conn = makeConn();
    conn.upsertChannel('#chan');
    const publish = vi.fn<(event: unknown) => void>();
    conn.publish = publish;

    conn.client.emit('mode', {
      target: '#chan',
      modes: [{ mode: '+o', param: 'alice' }],
      raw_modes: '+o',
      raw_params: ['alice'],
    });

    expect(latestModeRow(publish)?.modes?.[0]?.kind).toBe('prefix');
  });

  it('routes solanum +q to the list-mode path, not the member-prefix path (#486)', () => {
    const conn = makeConn();
    solanumIsupport(conn);
    const ch = conn.upsertChannel('#chan');
    // A joined member whose nick is exactly the quiet's parameter. This is the
    // case the hardcode got wrong: a bare-nick quiet matched a real member, so
    // `troll` was handed a phantom owner-style `q` badge.
    ch.members.set('troll', {
      nick: 'troll',
      modes: [],
      away: false,
      user: null,
      host: null,
      account: null,
    });
    const publish = vi.fn<(event: unknown) => void>();
    conn.publish = publish;

    conn.client.emit('mode', {
      target: '#chan',
      modes: [{ mode: '+n' }, { mode: '+q', param: 'troll' }],
      raw_modes: '+nq',
      raw_params: ['troll'],
    });

    // No phantom badge: +q never reached the member branch.
    expect(ch.members.get('troll')?.modes).toEqual([]);
    // And it was excluded from the status bar as the list mode it is.
    const modes = latestModes(publish);
    expect(modes).toContain('n');
    expect(modes).not.toContain('q');
  });

  it('still treats +q as a member prefix when the server declares it in PREFIX', () => {
    const conn = makeConn();
    // UnrealIRCd-shaped: q IS an owner prefix here, and not a list mode.
    const options = conn.client.network.options as { CHANMODES?: unknown; PREFIX?: unknown };
    options.CHANMODES = ['beI', 'k', 'l', 'imnpst'];
    options.PREFIX = [
      { symbol: '~', mode: 'q' },
      { symbol: '@', mode: 'o' },
      { symbol: '+', mode: 'v' },
    ];
    const ch = conn.upsertChannel('#chan');
    ch.members.set('owner', {
      nick: 'owner',
      modes: [],
      away: false,
      user: null,
      host: null,
      account: null,
    });
    conn.publish = vi.fn<(event: unknown) => void>();

    conn.client.emit('mode', {
      target: '#chan',
      modes: [{ mode: '+q', param: 'owner' }],
      raw_modes: '+q',
      raw_params: ['owner'],
    });

    expect(ch.members.get('owner')?.modes).toEqual(['q']);
  });

  it('falls back to the common prefix set before ISUPPORT PREFIX arrives', () => {
    const conn = makeConn();
    // No PREFIX declared yet (pre-005). +o must still land on the member.
    const ch = conn.upsertChannel('#chan');
    ch.members.set('bob', {
      nick: 'bob',
      modes: [],
      away: false,
      user: null,
      host: null,
      account: null,
    });
    conn.publish = vi.fn<(event: unknown) => void>();

    conn.client.emit('mode', {
      target: '#chan',
      modes: [{ mode: '+o', param: 'bob' }],
      raw_modes: '+o',
      raw_params: ['bob'],
    });

    expect(ch.members.get('bob')?.modes).toEqual(['o']);
  });

  it('falls back rather than trusting a malformed PREFIX token', () => {
    const conn = makeConn();
    // irc-framework leaves the raw string in place when `(modes)symbols` fails
    // to parse — Array.isArray, not truthiness, is what keeps this safe.
    (conn.client.network.options as { PREFIX?: unknown }).PREFIX = 'garbage';
    const ch = conn.upsertChannel('#chan');
    ch.members.set('bob', {
      nick: 'bob',
      modes: [],
      away: false,
      user: null,
      host: null,
      account: null,
    });
    conn.publish = vi.fn<(event: unknown) => void>();

    conn.client.emit('mode', {
      target: '#chan',
      modes: [{ mode: '+o', param: 'bob' }],
      raw_modes: '+o',
      raw_params: ['bob'],
    });

    expect(ch.members.get('bob')?.modes).toEqual(['o']);
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
        casemapping: null,
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

  /** A network whose connect_commands do something ordinary — connect_commands
   *  is a general-purpose script, not an identification marker. */
  function makeScriptedConn(name: string, connect_commands: string): IrcConnection {
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
      connect_commands,
    })!;
    return new IrcConnection({ network, onEvent: () => {} });
  }

  /** A network that identifies to services via NickServ — the case where a
   *  join rejection can arrive before identification has landed. */
  function makeNickServConn(name: string): IrcConnection {
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
      connect_commands: 'PRIVMSG NickServ :IDENTIFY hunter2',
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

  it("someone else's join grants no autojoin and no key", () => {
    const conn = makeConn('echo-other');
    conn.client.user.nick = 'me';
    conn.upsertChannel('#chan');

    conn.client.emit('join', { channel: '#chan', nick: 'stranger' });

    // Persisting the join event materializes the row (schema 17: the mint the
    // wsHub live filter used to perform moved to the insert itself), but the
    // property this test guards is unchanged: only the SELF echo is a join
    // confirmation, so a stranger's join must not turn the channel into a
    // rejoin carrier.
    const row = getBuffer(conn.network.user_id, conn.network.id, '#chan');
    expect(row?.autojoin).toBe(false);
    expect(row?.key).toBe(null);
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

  it('470-forget drops a favorite on the deleted row and flags the part event', async () => {
    // The hard delete would otherwise cascade the favorite away silently —
    // no renumber, no favorites-changed republish — leaving clients with a
    // ghost entry for the dead buffer id.
    const { favoriteBuffer, listFavoritesForUser } = await import('../db/favoriteBuffers.js');
    const conn = makeConn('fwd-fav');
    const netId = conn.network.id;
    // An OPEN history-less row (a quiet just-joined channel) — the config-row
    // variant seedAutojoinChannel mints is born closed, which favoriteBuffer
    // now refuses by design (the stale-tab orphan guard).
    ensureBufferOpen(conn.network.user_id, netId, '#apple', { kind: 'channel' });
    expect(favoriteBuffer(conn.network.user_id, netId, '#apple')).toBe(true);
    const published: Array<Record<string, unknown>> = [];
    conn.publish = ((ev: Record<string, unknown>) => {
      published.push(ev);
    }) as typeof conn.publish;

    conn.client.emit('channel_redirect', { from: '#apple', to: '##apple' });

    expect(getBuffer(conn.network.user_id, netId, '#apple')).toBeUndefined();
    expect(listFavoritesForUser(conn.network.user_id).some((f) => f.target === '#apple')).toBe(
      false,
    );
    const parted = published.find((e) => e.type === 'channel-parted');
    expect(parted).toMatchObject({ target: '#apple', favoritesChanged: true });
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
    // so no channel row appears. (The error line itself persists into the
    // server buffer, which as of schema 17 mints the `:server:` sentinel row —
    // a real, deliberately-kinded fixture, not the phantom this test guards.)
    const conn = makeConn('notonchan-phantom');
    conn.client.emit('irc error', {
      error: 'not_on_channel',
      channel: '#never-joined',
      reason: "You're not on that channel",
    });
    expect(
      listBufferRowsForNetwork(conn.network.id).filter((b) => b.kind !== 'server'),
    ).toHaveLength(0);
  });

  // A join the server durably refuses must stop replaying on every reconnect.
  // The reported case: an invite-only channel seeded as a network default, so
  // the join never echoed, no buffer was ever surfaced, and the rejection
  // repeated on every connect with nothing on screen to cancel it.
  it('473 stops auto-joining an invite-only channel and says so', () => {
    const conn = makeConn('inviteonly-stop');
    ensureBufferOpen(conn.network.user_id, conn.network.id, '#marco', {
      kind: 'channel',
      autojoin: true,
    });
    const publish = vi.fn<(event: unknown) => void>();
    conn.publish = publish;

    conn.client.emit('irc error', {
      error: 'invite_only_channel',
      channel: '#marco',
      reason: 'Cannot join channel (+i)',
    });

    expect(getBuffer(conn.network.user_id, conn.network.id, '#marco')?.autojoin).toBe(false);
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        target: `:server:${conn.network.id}`,
        text: 'Stopped auto-joining #marco because it is invite-only (+i). Use /join #marco to try again.',
      }),
    );
  });

  it('473 clears a config-seeded default channel without surfacing its buffer', () => {
    // seedDefaultChannel's row is 'closed' with a NULL closed_at — the "never
    // surfaced" shape. Cancelling the rejoin must not turn it into a visible
    // empty buffer; the point is that it stops trying, silently, in the sidebar.
    const conn = makeConn('inviteonly-seed');
    seedAutojoinChannel(conn.network.user_id, conn.network.id, '#marco');
    expect(getBuffer(conn.network.user_id, conn.network.id, '#marco')?.autojoin).toBe(true);

    conn.client.emit('irc error', {
      error: 'invite_only_channel',
      channel: '#marco',
      reason: 'Cannot join channel (+i)',
    });

    const row = getBuffer(conn.network.user_id, conn.network.id, '#marco')!;
    expect(row.autojoin).toBe(false);
    expect(row.state).toBe('closed');
    expect(row.closedAt).toBeNull();
  });

  it('474 stops auto-joining a channel we are banned from', () => {
    const conn = makeConn('banned-stop');
    ensureBufferOpen(conn.network.user_id, conn.network.id, '#apple', {
      kind: 'channel',
      autojoin: true,
    });

    conn.client.emit('irc error', {
      error: 'banned_from_channel',
      channel: '#apple',
      reason: 'Cannot join channel (+b)',
    });

    expect(getBuffer(conn.network.user_id, conn.network.id, '#apple')?.autojoin).toBe(false);
  });

  it('471 leaves autojoin alone — a full channel is a state of the moment', () => {
    // The guard that keeps this from becoming a silent unsubscribe. Same for
    // 405, and for 477 (which races SASL identification and would hit every
    // channel on a slow-identify reconnect).
    const conn = makeConn('full-keeps');
    ensureBufferOpen(conn.network.user_id, conn.network.id, '#apple', {
      kind: 'channel',
      autojoin: true,
    });

    conn.client.emit('irc error', {
      error: 'channel_is_full',
      channel: '#apple',
      reason: 'Cannot join channel (+l)',
    });

    expect(getBuffer(conn.network.user_id, conn.network.id, '#apple')?.autojoin).toBe(true);
  });

  it('473 on a channel we never auto-joined announces nothing', () => {
    // A manual `/join #private` persists nothing (joinChannel writes on the
    // echo, never the request), so there is no subscription to cancel — and
    // claiming to have stopped one would be a lie.
    const conn = makeConn('inviteonly-manual');
    const publish = vi.fn<(event: unknown) => void>();
    conn.publish = publish;

    conn.client.emit('irc error', {
      error: 'invite_only_channel',
      channel: '#private',
      reason: 'Cannot join channel (+i)',
    });

    expect(getBuffer(conn.network.user_id, conn.network.id, '#private')).toBeUndefined();
    expect(publish).not.toHaveBeenCalledWith(
      expect.objectContaining({ target: `:server:${conn.network.id}` }),
    );
  });

  it('473 still shows the join-error toast on the channel (#260)', () => {
    const conn = makeConn('inviteonly-toast');
    ensureBufferOpen(conn.network.user_id, conn.network.id, '#marco', {
      kind: 'channel',
      autojoin: true,
    });
    const ephemeral = vi.fn<(event: unknown) => void>();
    conn.publishEphemeral = ephemeral;

    conn.client.emit('irc error', {
      error: 'invite_only_channel',
      channel: '#marco',
      reason: 'Cannot join channel (+i)',
    });

    expect(ephemeral).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'join-error',
        target: '#marco',
        text: 'This channel is invite-only.',
      }),
    );
  });

  // The identification race. Account-based access (+I/$a:, +e/$a:) only starts
  // matching once services consider us identified, and connect_commands and the
  // autojoin batch both fire on 'registered' — so an early 473/474 can mean
  // "NickServ hasn't caught up", not "you don't belong here".
  it('473 before RPL_LOGGEDIN leaves autojoin alone on a NickServ network', () => {
    const conn = makeNickServConn('inviteonly-race');
    ensureBufferOpen(conn.network.user_id, conn.network.id, '#marco', {
      kind: 'channel',
      autojoin: true,
    });
    const publish = vi.fn<(event: unknown) => void>();
    conn.publish = publish;

    conn.client.emit('irc error', {
      error: 'invite_only_channel',
      channel: '#marco',
      reason: 'Cannot join channel (+i)',
    });

    // Still in the rejoin list: the next reconnect gets to try again once
    // NickServ has landed, instead of the channel silently disappearing.
    expect(getBuffer(conn.network.user_id, conn.network.id, '#marco')?.autojoin).toBe(true);
    expect(publish).not.toHaveBeenCalledWith(
      expect.objectContaining({ target: `:server:${conn.network.id}` }),
    );
  });

  it('473 after RPL_LOGGEDIN does stop auto-joining on a NickServ network', () => {
    // Same network, same rejection — but now services have confirmed us, so
    // the invex would already have matched. The refusal is durable.
    const conn = makeNickServConn('inviteonly-identified');
    ensureBufferOpen(conn.network.user_id, conn.network.id, '#marco', {
      kind: 'channel',
      autojoin: true,
    });
    conn.client.emit('loggedin', {});

    conn.client.emit('irc error', {
      error: 'invite_only_channel',
      channel: '#marco',
      reason: 'Cannot join channel (+i)',
    });

    expect(getBuffer(conn.network.user_id, conn.network.id, '#marco')?.autojoin).toBe(false);
  });

  it('connect_commands that do not identify are not treated as a services wait', () => {
    // connect_commands is a general-purpose script. Gating on its presence
    // alone would disable this fix entirely for anyone using it for ordinary
    // things on a server that never sends 900.
    const conn = makeScriptedConn('script-nonauth', 'JOIN #foo\nMODE me +x');
    ensureBufferOpen(conn.network.user_id, conn.network.id, '#marco', {
      kind: 'channel',
      autojoin: true,
    });

    conn.client.emit('irc error', {
      error: 'invite_only_channel',
      channel: '#marco',
      reason: 'Cannot join channel (+i)',
    });

    expect(getBuffer(conn.network.user_id, conn.network.id, '#marco')?.autojoin).toBe(false);
  });

  // Every services flavour has to read as "wait", because a miss here is the
  // dangerous direction: it unsubscribes someone mid-race. Matched as a family
  // (any *Serv) plus the identification verbs, since the two networks whose
  // services are not named *Serv — QuakeNet's Q, Undernet's X — are reachable
  // only through the verb.
  it.each([
    ['NickServ', 'PRIVMSG NickServ :IDENTIFY me hunter2'],
    ['SaslServ', 'PRIVMSG SaslServ :IDENTIFY me hunter2'],
    ['SaslServ, no verb', 'PRIVMSG SaslServ :HELP'],
    ['HostServ', 'MSG HostServ ON'],
    ['GameSurge AuthServ', 'PRIVMSG AuthServ@services.gamesurge.net :AUTH me hunter2'],
    ['QuakeNet Q', 'PRIVMSG Q@CServe.quakenet.org :AUTH me hunter2'],
    ['Undernet X', 'PRIVMSG X@channels.undernet.org :LOGIN me hunter2'],
  ])('treats %s in connect_commands as a services wait', (label, commands) => {
    const conn = makeScriptedConn(`script-${label.replace(/\W+/g, '-')}`, commands);
    ensureBufferOpen(conn.network.user_id, conn.network.id, '#marco', {
      kind: 'channel',
      autojoin: true,
    });

    conn.client.emit('irc error', {
      error: 'invite_only_channel',
      channel: '#marco',
      reason: 'Cannot join channel (+i)',
    });

    expect(getBuffer(conn.network.user_id, conn.network.id, '#marco')?.autojoin).toBe(true);
  });

  it('475 tells the user to supply the key, since a bare /join will not resend it', () => {
    // joinChannel coerces an absent key to undefined and passes it straight to
    // client.join, so `/join #x` on a +k channel reproduces the failure.
    const conn = makeConn('badkey-remedy');
    ensureBufferOpen(conn.network.user_id, conn.network.id, '#marco', {
      kind: 'channel',
      autojoin: true,
    });
    const publish = vi.fn<(event: unknown) => void>();
    conn.publish = publish;

    conn.client.emit('irc error', {
      error: 'bad_channel_key',
      channel: '#marco',
      reason: 'Cannot join channel (+k)',
    });

    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Stopped auto-joining #marco because the saved channel key is wrong (+k). Use /join #marco <key> to try again.',
      }),
    );
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

// #695: a DM buffer follows its peer through /nick (weechat/irssi parity).
describe('DM rename on peer NICK', () => {
  function connFor(name: string) {
    const network = createNetwork(1, {
      name,
      host: 'irc.example.test',
      port: 6697,
      tls: 1,
      trusted_certificates: 1,
      nick: 'me',
      username: null,
      realname: null,
      server_password: null,
      autoconnect: 0,
      sasl_account: null,
      sasl_password: null,
      connect_commands: null,
    })!;
    const conn = new IrcConnection({ network, onEvent: () => {} });
    conn.client.user.nick = 'me';
    const published: Array<Record<string, unknown>> = [];
    conn.publish = vi.fn<(event: unknown) => void>((e) => {
      published.push(e as Record<string, unknown>);
    }) as typeof conn.publish;
    conn.publishEphemeral = vi.fn<(event: unknown) => void>((e) => {
      published.push(e as Record<string, unknown>);
    }) as typeof conn.publishEphemeral;
    return { conn, network, published };
  }

  it('renames the DM row, announces it, and persists the "known as" line under the NEW name', async () => {
    const { conn, network, published } = connFor('dmrename');
    const { ensureOpen, getBuffer: get } = await import('../db/buffers.js');
    ensureOpen(network.user_id, network.id, 'bob', { kind: 'dm' });
    const id = get(network.user_id, network.id, 'bob')!.id;

    conn.client.emit('nick', { nick: 'bob', new_nick: 'bob_away' });

    // The registry row kept its id and adopted the new name.
    expect(get(network.user_id, network.id, 'bob')).toBeUndefined();
    expect(get(network.user_id, network.id, 'bob_away')?.id).toBe(id);
    // The announcement, then the DM's own nick row — in that order, so the
    // row lands under the buffer's new name.
    const renamed = published.find((e) => e.type === 'buffer-renamed');
    expect(renamed).toMatchObject({ from: 'bob', to: 'bob_away', bufferId: id, merged: false });
    const nickRow = published.find((e) => e.type === 'nick' && e.target === 'bob_away');
    expect(nickRow).toMatchObject({ nick: 'bob', newNick: 'bob_away' });
    expect(published.indexOf(renamed!)).toBeLessThan(published.indexOf(nickRow!));
  });

  it('a collision merges source-survives and announces the absorbed id', async () => {
    const { conn, network, published } = connFor('dmrename-merge');
    const { ensureOpen, getBuffer: get } = await import('../db/buffers.js');
    ensureOpen(network.user_id, network.id, 'stale_carol', { kind: 'dm' });
    const absorbedId = get(network.user_id, network.id, 'stale_carol')!.id;
    ensureOpen(network.user_id, network.id, 'carol', { kind: 'dm' });
    const liveId = get(network.user_id, network.id, 'carol')!.id;

    conn.client.emit('nick', { nick: 'carol', new_nick: 'stale_carol' });

    expect(get(network.user_id, network.id, 'stale_carol')?.id).toBe(liveId);
    expect(published.find((e) => e.type === 'buffer-renamed')).toMatchObject({
      bufferId: liveId,
      merged: true,
      mergedFromBufferId: absorbedId,
    });
  });

  it('a closed DM renames too, without reopening', async () => {
    const { conn, network } = connFor('dmrename-closed');
    const { ensureOpen, close, getBuffer: get } = await import('../db/buffers.js');
    ensureOpen(network.user_id, network.id, 'ghost', { kind: 'dm' });
    close(network.user_id, network.id, 'ghost');

    conn.client.emit('nick', { nick: 'ghost', new_nick: 'phantom' });

    expect(get(network.user_id, network.id, 'phantom')?.state).toBe('closed');
  });

  it('no DM row means no rename and no announcement', async () => {
    const { conn, network, published } = connFor('dmrename-none');
    conn.client.emit('nick', { nick: 'stranger', new_nick: 'stranger2' });
    const { getBuffer: get } = await import('../db/buffers.js');
    expect(get(network.user_id, network.id, 'stranger2')).toBeUndefined();
    expect(published.find((e) => e.type === 'buffer-renamed')).toBeUndefined();
  });

  it('our own /nick never renames a buffer', async () => {
    const { conn, network, published } = connFor('dmrename-self');
    const { ensureOpen, getBuffer: get } = await import('../db/buffers.js');
    // Pathological but possible: a DM buffer named like our own nick.
    ensureOpen(network.user_id, network.id, 'me', { kind: 'dm' });

    conn.client.emit('nick', { nick: 'me', new_nick: 'me2' });

    expect(get(network.user_id, network.id, 'me')).toBeDefined();
    expect(published.find((e) => e.type === 'buffer-renamed')).toBeUndefined();
  });
});

describe('CASEMAPPING capture + refold (#707)', () => {
  function connFor(name: string) {
    const network = createNetwork(1, {
      name,
      host: 'irc.example.test',
      port: 6697,
      tls: 1,
      trusted_certificates: 1,
      nick: 'me',
      username: null,
      realname: null,
      server_password: null,
      autoconnect: 0,
      sasl_account: null,
      sasl_password: null,
      connect_commands: null,
    })!;
    const conn = new IrcConnection({ network, onEvent: () => {} });
    const published: Array<Record<string, unknown>> = [];
    conn.publish = vi.fn<(event: unknown) => void>((e) => {
      published.push(e as Record<string, unknown>);
    }) as typeof conn.publish;
    conn.publishEphemeral = vi.fn<(event: unknown) => void>((e) => {
      published.push(e as Record<string, unknown>);
    }) as typeof conn.publishEphemeral;
    return { conn, network, published };
  }

  function raw005(conn: IrcConnection, tokens: string) {
    // Capture reads the RAW 005 tokens, deliberately NOT network.options —
    // irc-framework pre-seeds options.CASEMAPPING to 'rfc1459' in its
    // NetworkInfo constructor, so through the options bag "declared rfc1459"
    // and "declared nothing" are the same value. Drive the real 'raw' handler
    // with a wire line, exactly as the socket would.
    conn.client.emit('raw', {
      from_server: true,
      line: `:irc.example.test 005 me ${tokens} :are supported by this server`,
    });
  }

  it('stores a declared mapping and merges rows that now fold together', async () => {
    const { conn, network, published } = connFor('casemap');
    const { ensureOpen, getBuffer: get } = await import('../db/buffers.js');
    // Two rows under the legacy fold; ONE channel under rfc1459.
    ensureOpen(network.user_id, network.id, '#foo[bar]');
    ensureOpen(network.user_id, network.id, '#foo{bar}');

    raw005(conn, 'CHANTYPES=# CASEMAPPING=rfc1459 MONITOR=100');

    expect(getNetwork(network.id, network.user_id)?.casemapping).toBe('rfc1459');
    const merged = get(network.user_id, network.id, '#foo[bar]');
    expect(merged?.id).toBe(get(network.user_id, network.id, '#foo{bar}')?.id);
    expect(published.find((e) => e.type === 'buffer-renamed')).toMatchObject({
      merged: true,
      bufferId: merged!.id,
    });
  });

  it("NEVER captures irc-framework's defaulted rfc1459 — no token, no store", () => {
    const { conn, network } = connFor('casemap-absent');
    // The framework default is sitting right there in the options bag; a 005
    // line without the token must not launder it into a declaration.
    expect(conn.client.network.options.CASEMAPPING).toBe('rfc1459');
    raw005(conn, 'CHANTYPES=# MONITOR=100');
    expect(getNetwork(network.id, network.user_id)?.casemapping).toBeNull();
  });

  it('a declaration on a LATER 005 line still captures', async () => {
    const { conn, network } = connFor('casemap-late');
    raw005(conn, 'CHANTYPES=# PREFIX=(ov)@+');
    raw005(conn, 'MONITOR=100 CASEMAPPING=ascii TARGMAX=NAMES:1');
    expect(getNetwork(network.id, network.user_id)?.casemapping).toBe('ascii');
  });

  it('an unknown value is not stored and changes nothing', async () => {
    const { conn, network, published } = connFor('casemap-unknown');
    const { ensureOpen, getBuffer: get } = await import('../db/buffers.js');
    ensureOpen(network.user_id, network.id, '#a[1]');
    ensureOpen(network.user_id, network.id, '#a{1}');

    raw005(conn, 'CASEMAPPING=rfc8265');

    expect(getNetwork(network.id, network.user_id)?.casemapping).toBeNull();
    expect(get(network.user_id, network.id, '#a[1]')?.id).not.toBe(
      get(network.user_id, network.id, '#a{1}')?.id,
    );
    // No lifecycle frames — the raw 005 line itself still renders as server
    // text via the ordinary numeric path, which is not this test's concern.
    expect(published.filter((e) => e.type === 'buffer-renamed')).toEqual([]);
  });

  it('re-declaring the stored mapping is a no-op — reconnects do no work', () => {
    const { conn, published } = connFor('casemap-again');
    raw005(conn, 'CASEMAPPING=rfc1459');
    raw005(conn, 'CASEMAPPING=rfc1459');
    expect(published.filter((e) => e.type === 'buffer-renamed')).toEqual([]);
  });

  it('a merge of two CLOSED twins is silent — clients hold nothing to correct', async () => {
    const { conn, network, published } = connFor('casemap-closed');
    const { ensureOpen, close, getBuffer: get } = await import('../db/buffers.js');
    ensureOpen(network.user_id, network.id, 'ghost^', { kind: 'dm' });
    ensureOpen(network.user_id, network.id, 'ghost~', { kind: 'dm' });
    close(network.user_id, network.id, 'ghost^');
    close(network.user_id, network.id, 'ghost~');

    raw005(conn, 'CASEMAPPING=rfc1459');

    // Merged server-side, closed, and NOT announced — an announced merge
    // would make clients materialize a sidebar row for it.
    expect(get(network.user_id, network.id, 'ghost~')?.state).toBe('closed');
    expect(published.filter((e) => e.type === 'buffer-renamed')).toEqual([]);
  });

  it('adopts the wire spelling on a join echo when the folds diverge', async () => {
    // The state a refold merge can leave behind: the surviving twin isn't the
    // spelling the ircd echoes. The join echo respells it (casing-only
    // rename, announced) so the id-less control frames that follow can't
    // fork a ghost buffer client-side. Plain ASCII case differences keep
    // first-writer-wins display casing.
    const { conn, network, published } = connFor('casemap-respell');
    const { ensureOpen, getBuffer: get } = await import('../db/buffers.js');
    raw005(conn, 'CASEMAPPING=rfc1459');
    ensureOpen(network.user_id, network.id, '#chat{dev}');
    const id = get(network.user_id, network.id, '#chat{dev}')!.id;
    conn.client.user.nick = 'me';

    conn.client.emit('join', { nick: 'me', channel: '#chat[dev]' });

    // Same row (the spellings fold together); display adopts the wire spelling.
    const row = get(network.user_id, network.id, '#chat[dev]');
    expect(row?.id).toBe(id);
    expect(row?.target).toBe('#chat[dev]');
    expect(published.find((e) => e.type === 'buffer-renamed')).toMatchObject({
      from: '#chat{dev}',
      to: '#chat[dev]',
      bufferId: id,
      merged: false,
    });
  });

  it('isChannelJoined folds both sides per the declared mapping', () => {
    // The one membership probe every consumer must use instead of the raw
    // channels-map key (legacy-lowercased wire names): a fold-variant
    // spelling of a joined channel reads joined, and a Unicode case-twin on
    // an ascii-family network does NOT (toLowerCase over-folds).
    const { conn } = connFor('casemap-joined');
    conn.upsertChannel('#foo[bar]');
    conn.upsertChannel('#ärger');
    raw005(conn, 'CASEMAPPING=rfc1459');

    expect(conn.isChannelJoined('#foo{bar}')).toBe(true);
    expect(conn.isChannelJoined('#FOO[BAR]')).toBe(true);
    expect(conn.isChannelJoined('#ärger')).toBe(true);
    // Distinct channels under rfc1459: Ä is not in the fold range.
    expect(conn.isChannelJoined('#Ärger')).toBe(false);
    expect(conn.isChannelJoined('#elsewhere')).toBe(false);
  });

  it('channelState resolves the live channel under the declared mapping', () => {
    // The contents counterpart to isChannelJoined: consumers that need the
    // topic or member list (the MCP get_topic / list_members verbs) must
    // resolve a fold-variant spelling to the SAME ChannelState, or they
    // report an empty channel for one we are demonstrably in.
    const { conn } = connFor('casemap-state');
    const ch = conn.upsertChannel('#foo[bar]');
    ch.topic = 'the topic';
    raw005(conn, 'CASEMAPPING=rfc1459');

    // Exact wire spelling: the fast raw-probe path.
    expect(conn.channelState('#foo[bar]')).toBe(ch);
    // Fold variants: only the folded scan finds these.
    expect(conn.channelState('#foo{bar}')).toBe(ch);
    expect(conn.channelState('#FOO[BAR]')).toBe(ch);
    // Agrees with isChannelJoined in both directions, including the
    // over-folding Unicode case it exists to reject.
    conn.upsertChannel('#ärger');
    expect(conn.channelState('#Ärger')).toBeUndefined();
    expect(conn.channelState('#elsewhere')).toBeUndefined();
  });
});

// #716 QA follow-up: a DM opened fresh from the nicklist showed its peer
// offline until the first message, because the presence probe refused to
// track anything without a conversation. The gate exists for notice-only
// service buffers (NickServ, #439) — an EMPTY buffer is deliberate user
// intent and must probe.
describe('probePresence intent gate', () => {
  function connFor(name: string) {
    const network = createNetwork(1, {
      name,
      host: 'irc.example.test',
      port: 6697,
      tls: 1,
      trusted_certificates: 1,
      nick: 'me',
      username: null,
      realname: null,
      server_password: null,
      autoconnect: 0,
      sasl_account: null,
      sasl_password: null,
      connect_commands: null,
    })!;
    const conn = new IrcConnection({ network, onEvent: () => {} });
    const tracked: string[] = [];
    conn.trackDmPeer = vi.fn<(nick: string) => boolean>((n) => {
      tracked.push(n);
      return true;
    }) as typeof conn.trackDmPeer;
    return { conn, network, tracked };
  }

  it('probes a brand-new empty DM (the just-opened query)', async () => {
    const { conn, network, tracked } = connFor('probe-fresh');
    const { ensureOpen } = await import('../db/buffers.js');
    ensureOpen(network.user_id, network.id, 'newperson', { kind: 'dm' });
    conn.probePresence('newperson');
    expect(tracked).toEqual(['newperson']);
  });

  it('probes a real conversation', async () => {
    const { conn, network, tracked } = connFor('probe-convo');
    const { ensureOpen } = await import('../db/buffers.js');
    const { insertMessage } = await import('../db/messages.js');
    ensureOpen(network.user_id, network.id, 'talker', { kind: 'dm' });
    insertMessage({
      networkId: network.id,
      target: 'talker',
      time: new Date().toISOString(),
      type: 'message',
      nick: 'talker',
      text: 'hi',
    });
    conn.probePresence('talker');
    expect(tracked).toEqual(['talker']);
  });

  it('still refuses a notice-only service buffer', async () => {
    const { conn, network, tracked } = connFor('probe-service');
    const { ensureOpen } = await import('../db/buffers.js');
    const { insertMessage } = await import('../db/messages.js');
    ensureOpen(network.user_id, network.id, 'NickServ', { kind: 'dm' });
    insertMessage({
      networkId: network.id,
      target: 'NickServ',
      time: new Date().toISOString(),
      type: 'notice',
      nick: 'NickServ',
      text: 'This nickname is registered.',
    });
    conn.probePresence('NickServ');
    expect(tracked).toEqual([]);
  });
});
