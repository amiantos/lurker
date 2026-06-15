// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, vi } from 'vitest';
import { ircLineParser } from 'irc-framework';
import type { ConnectOptions } from 'irc-framework';
import {
  IrcConnection,
  canonicalChannelTarget,
  computeFallbackNick,
  formatWhoisRaw,
  formatSocketCloseErrorMessage,
  formatServerNumeric,
  formatUnknownNumeric,
  joinRejectionMessage,
  joinRejectionMessageByTag,
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

describe('formatWhoisRaw', () => {
  it('formats the raw whois payload as a single server-buffer line', () => {
    expect(
      formatWhoisRaw({
        nick: 'alice',
        ident: 'a',
        hostname: 'host.example',
        channels: '#a #b',
      }),
    ).toBe(
      'WHOIS alice: {"nick":"alice","ident":"a","hostname":"host.example","channels":"#a #b"}',
    );
  });

  it('returns null for missing nick', () => {
    expect(formatWhoisRaw({ ident: 'a' })).toBeNull();
    expect(formatWhoisRaw(null)).toBeNull();
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
