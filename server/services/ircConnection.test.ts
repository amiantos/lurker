// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { ircLineParser } from 'irc-framework';
import { computeFallbackNick, formatServerNumeric } from './ircConnection.js';

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

describe('formatServerNumeric', () => {
  const fmt = (line: string) => formatServerNumeric(ircLineParser(line));

  it('renders RPL_WELCOME (001) trailing text', () => {
    expect(fmt(':tungsten.libera.chat 001 amiantos :Welcome to the Libera.Chat Internet Relay Chat Network amiantos'))
      .toBe('Welcome to the Libera.Chat Internet Relay Chat Network amiantos');
  });

  it('renders RPL_YOURHOST (002) trailing text', () => {
    expect(fmt(':srv 002 nick :Your host is tungsten.libera.chat, running version solanum-1.0-dev'))
      .toBe('Your host is tungsten.libera.chat, running version solanum-1.0-dev');
  });

  it('renders RPL_CREATED (003) trailing text', () => {
    expect(fmt(':srv 003 nick :This server was created Tue Feb 17 2026 at 18:43:04 UTC'))
      .toBe('This server was created Tue Feb 17 2026 at 18:43:04 UTC');
  });

  it('formats RPL_MYINFO (004) into a Host/IRCd/modes line', () => {
    expect(fmt(':srv 004 nick tungsten.libera.chat solanum-1.0-dev DGIMQRSZaghilopsuwz CFILMPQRSTbcefgijklmnopqrstuvz bkloveqjfI'))
      .toBe('Host: tungsten.libera.chat, IRCd: solanum-1.0-dev, user modes: DGIMQRSZaghilopsuwz, channel modes: CFILMPQRSTbcefgijklmnopqrstuvz, parametric channel modes: bkloveqjfI');
  });

  it('formats RPL_UMODEIS (221) with the mode string', () => {
    expect(fmt(':srv 221 nick +Ziw')).toBe('Your user mode: +Ziw');
  });

  it('renders RPL_STATSCONN (250) trailing text', () => {
    expect(fmt(':srv 250 nick :Highest connection count: 2419 (2418 clients) (135662 connections received)'))
      .toBe('Highest connection count: 2419 (2418 clients) (135662 connections received)');
  });

  it('renders RPL_LUSERCLIENT (251) trailing text', () => {
    expect(fmt(':srv 251 nick :There are 61 users and 30637 invisible on 29 servers'))
      .toBe('There are 61 users and 30637 invisible on 29 servers');
  });

  it('joins count+label for LUSEROP/UNKNOWN/CHANNELS (252/253/254)', () => {
    expect(fmt(':srv 252 nick 37 :IRC Operators online')).toBe('37 IRC Operators online');
    expect(fmt(':srv 253 nick 35 :unknown connection(s)')).toBe('35 unknown connection(s)');
    expect(fmt(':srv 254 nick 22099 :channels formed')).toBe('22099 channels formed');
  });

  it('renders RPL_LUSERME (255) trailing text', () => {
    expect(fmt(':srv 255 nick :I have 1818 clients and 1 servers'))
      .toBe('I have 1818 clients and 1 servers');
  });

  it('renders RPL_LOCAL/GLOBALUSERS (265/266) trailing text', () => {
    expect(fmt(':srv 265 nick 1818 2418 :Current local users 1818, max 2418'))
      .toBe('Current local users 1818, max 2418');
    expect(fmt(':srv 266 nick 30698 35475 :Current global users 30698, max 35475'))
      .toBe('Current global users 30698, max 35475');
  });

  it('formats RPL_HOSTCLOAKING (396)', () => {
    expect(fmt(':srv 396 nick uid752922@user/amiantos :is now your displayed host'))
      .toBe('Your hostmask: uid752922@user/amiantos');
  });

  it('renders RPL_LOGGEDIN (900) and RPL_SASLLOGGEDIN (903) trailing text', () => {
    expect(fmt(':srv 900 nick nick!user@host amiantos :You are now logged in as amiantos'))
      .toBe('You are now logged in as amiantos');
    expect(fmt(':srv 903 nick :SASL authentication successful'))
      .toBe('SASL authentication successful');
  });

  it('returns null for the deliberately-skipped 005/ISUPPORT', () => {
    expect(fmt(':srv 005 nick CHANTYPES=# EXCEPTS INVEX :are supported by this server'))
      .toBeNull();
  });

  it('returns null for non-numerics and bad input', () => {
    expect(fmt(':alice!u@h PRIVMSG #chan :hi')).toBeNull();
    expect(fmt(':srv 372 nick :- MOTD line')).toBeNull(); // motd already handled separately
    expect(formatServerNumeric(null)).toBeNull();
    expect(formatServerNumeric({ command: '', params: [] })).toBeNull();
  });
});
