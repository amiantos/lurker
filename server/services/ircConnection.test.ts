// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, vi } from 'vitest';
import { ircLineParser } from 'irc-framework';
import type { ConnectOptions } from 'irc-framework';
import {
  IrcConnection,
  canonicalChannelTarget,
  computeFallbackNick,
  formatSocketCloseErrorMessage,
  formatServerNumeric,
  formatUnknownNumeric,
  isOverloadedSpeakRejection,
  joinRejectionMessage,
  joinRejectionMessageByTag,
  sendRejectionTargetKind,
  sendRejectionText,
} from './ircConnection.js';

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

const fmt = (line: string) => formatServerNumeric(ircLineParser(line));

describe('formatServerNumeric', () => {
  it('renders RPL_WELCOME (001) trailing text', () => {
    expect(
      fmt(
        ':tungsten.libera.chat 001 amiantos :Welcome to the Libera.Chat Internet Relay Chat Network amiantos',
      ),
    ).toBe('Welcome to the Libera.Chat Internet Relay Chat Network amiantos');
  });

  it('renders RPL_YOURHOST (002) trailing text', () => {
    expect(
      fmt(':srv 002 nick :Your host is tungsten.libera.chat, running version solanum-1.0-dev'),
    ).toBe('Your host is tungsten.libera.chat, running version solanum-1.0-dev');
  });

  it('renders RPL_CREATED (003) trailing text', () => {
    expect(fmt(':srv 003 nick :This server was created Tue Feb 17 2026 at 18:43:04 UTC')).toBe(
      'This server was created Tue Feb 17 2026 at 18:43:04 UTC',
    );
  });

  it('formats RPL_MYINFO (004) into a Host/IRCd/modes line', () => {
    expect(
      fmt(
        ':srv 004 nick tungsten.libera.chat solanum-1.0-dev DGIMQRSZaghilopsuwz CFILMPQRSTbcefgijklmnopqrstuvz bkloveqjfI',
      ),
    ).toBe(
      'Host: tungsten.libera.chat, IRCd: solanum-1.0-dev, user modes: DGIMQRSZaghilopsuwz, channel modes: CFILMPQRSTbcefgijklmnopqrstuvz, parametric channel modes: bkloveqjfI',
    );
  });

  it('formats RPL_UMODEIS (221) with the mode string', () => {
    expect(fmt(':srv 221 nick +Ziw')).toBe('Your user mode: +Ziw');
  });

  it('renders RPL_STATSCONN (250) trailing text', () => {
    expect(
      fmt(
        ':srv 250 nick :Highest connection count: 2419 (2418 clients) (135662 connections received)',
      ),
    ).toBe('Highest connection count: 2419 (2418 clients) (135662 connections received)');
  });

  it('renders RPL_LUSERCLIENT (251) trailing text', () => {
    expect(fmt(':srv 251 nick :There are 61 users and 30637 invisible on 29 servers')).toBe(
      'There are 61 users and 30637 invisible on 29 servers',
    );
  });

  it('joins count+label for LUSEROP/UNKNOWN/CHANNELS (252/253/254)', () => {
    expect(fmt(':srv 252 nick 37 :IRC Operators online')).toBe('37 IRC Operators online');
    expect(fmt(':srv 253 nick 35 :unknown connection(s)')).toBe('35 unknown connection(s)');
    expect(fmt(':srv 254 nick 22099 :channels formed')).toBe('22099 channels formed');
  });

  it('renders RPL_LUSERME (255) trailing text', () => {
    expect(fmt(':srv 255 nick :I have 1818 clients and 1 servers')).toBe(
      'I have 1818 clients and 1 servers',
    );
  });

  it('renders RPL_LOCAL/GLOBALUSERS (265/266) trailing text', () => {
    expect(fmt(':srv 265 nick 1818 2418 :Current local users 1818, max 2418')).toBe(
      'Current local users 1818, max 2418',
    );
    expect(fmt(':srv 266 nick 30698 35475 :Current global users 30698, max 35475')).toBe(
      'Current global users 30698, max 35475',
    );
  });

  it('formats RPL_HOSTCLOAKING (396)', () => {
    expect(fmt(':srv 396 nick uid752922@user/amiantos :is now your displayed host')).toBe(
      'Your hostmask: uid752922@user/amiantos',
    );
  });

  it('renders RPL_LOGGEDIN (900) and RPL_SASLLOGGEDIN (903) trailing text', () => {
    expect(fmt(':srv 900 nick nick!user@host amiantos :You are now logged in as amiantos')).toBe(
      'You are now logged in as amiantos',
    );
    expect(fmt(':srv 903 nick :SASL authentication successful')).toBe(
      'SASL authentication successful',
    );
  });

  it('renders RPL_LINKS (364) as "server access_via hops info" per line (#312)', () => {
    expect(fmt(':irc.tzirc.com 364 nick rock.tzirc.com irc.tzirc.com :1 #tZ IRC Network')).toBe(
      'rock.tzirc.com irc.tzirc.com 1 #tZ IRC Network',
    );
    // The hub server reports itself with hop count 0.
    expect(fmt(':irc.tzirc.com 364 nick irc.tzirc.com irc.tzirc.com/ :0 #tZ IRC Network')).toBe(
      'irc.tzirc.com irc.tzirc.com/ 0 #tZ IRC Network',
    );
  });

  it('renders RPL_ENDOFLINKS (365) terminator, dropping the mask param (#312)', () => {
    expect(fmt(':irc.tzirc.com 365 nick * :End of /LINKS list.')).toBe('End of /LINKS list.');
    // A bare 365 with no mask must not echo the nick back.
    expect(fmt(':irc.tzirc.com 365 nick')).toBeNull();
  });

  it('renders RPL_INFO (371) and RPL_ENDOFINFO (374) trailing text (#312)', () => {
    expect(fmt(':srv 371 nick :solanum-1.0-dev(20240101)')).toBe('solanum-1.0-dev(20240101)');
    expect(fmt(':srv 374 nick :End of /INFO list.')).toBe('End of /INFO list.');
    // A bare terminator must not echo the nick back.
    expect(fmt(':srv 374 nick')).toBeNull();
  });

  it('renders RPL_HELP* (704/705/706) trailing text, ignoring the subject param (#312)', () => {
    expect(fmt(':srv 704 nick index :Help topics available to users:')).toBe(
      'Help topics available to users:',
    );
    expect(fmt(':srv 705 nick index :ACCEPT    ADMIN    AWAY')).toBe('ACCEPT    ADMIN    AWAY');
    expect(fmt(':srv 706 nick index :End of /HELP.')).toBe('End of /HELP.');
  });

  it('renders WHOIS numerics as raw server lines, stripping the routing nick (#281)', () => {
    // The leading "you" (the requester nick / numeric routing target) is
    // dropped; everything the server sent after it is preserved verbatim.
    expect(fmt(':srv 311 you alice ~alice user/alice * :Alice Example')).toBe(
      'alice ~alice user/alice * Alice Example',
    );
    expect(fmt(':srv 319 you alice :#libera #lurker +#ops')).toBe('alice #libera #lurker +#ops');
    expect(fmt(':srv 312 you alice tungsten.libera.chat :Helsinki, FI')).toBe(
      'alice tungsten.libera.chat Helsinki, FI',
    );
    expect(fmt(':srv 671 you alice :is using a secure connection [TLSv1.3]')).toBe(
      'alice is using a secure connection [TLSv1.3]',
    );
    expect(fmt(':srv 330 you alice aliceacct :is logged in as')).toBe(
      'alice aliceacct is logged in as',
    );
    expect(fmt(':srv 317 you alice 234 1718500000 :seconds idle, signon time')).toBe(
      'alice 234 1718500000 seconds idle, signon time',
    );
    expect(fmt(':srv 318 you alice :End of /WHOIS list.')).toBe('alice End of /WHOIS list.');
  });

  it('renders WHOWAS numerics raw too, so /whowas reuses the same path (#281)', () => {
    expect(fmt(':srv 314 you Ghost ~ghost old.example.net * :A Spooky User')).toBe(
      'Ghost ~ghost old.example.net * A Spooky User',
    );
    expect(fmt(':srv 369 you Ghost :End of WHOWAS')).toBe('Ghost End of WHOWAS');
    expect(fmt(':srv 406 you Nobody :There was no such nickname')).toBe(
      'Nobody There was no such nickname',
    );
  });

  it('returns null for the deliberately-skipped 005/ISUPPORT', () => {
    expect(fmt(':srv 005 nick CHANTYPES=# EXCEPTS INVEX :are supported by this server')).toBeNull();
  });

  it('returns null for non-numerics and bad input', () => {
    expect(fmt(':alice!u@h PRIVMSG #chan :hi')).toBeNull();
    expect(fmt(':srv 372 nick :- MOTD line')).toBeNull(); // motd already handled separately
    expect(formatServerNumeric(null)).toBeNull();
    expect(formatServerNumeric({ command: '', params: [] })).toBeNull();
  });
});

// The catch-all that surfaces server numerics irc-framework doesn't model (#262):
// drop the leading recipient-nick param, join the rest.
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

  it('renders an allowlisted numeric too — the listener dedups via formatServerNumeric', () => {
    // formatUnknownNumeric is intentionally numeric-agnostic; the double-render
    // guard lives in the listener (skip when formatServerNumeric already claims
    // it). This documents why that guard is necessary.
    expect(fmtUnknown(':srv 001 nick :Welcome to the network nick')).toBe(
      'Welcome to the network nick',
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
