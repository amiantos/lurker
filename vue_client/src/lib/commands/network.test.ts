// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { parseNetworkCommand } from './network.js';

describe('parseNetworkCommand', () => {
  it('treats no args and `list`/`ls` as a list', () => {
    expect(parseNetworkCommand('')).toEqual({ kind: 'list' });
    expect(parseNetworkCommand('   ')).toEqual({ kind: 'list' });
    expect(parseNetworkCommand('list')).toEqual({ kind: 'list' });
    expect(parseNetworkCommand('ls')).toEqual({ kind: 'list' });
  });

  describe('add', () => {
    it('maps irssi-style flags onto the network payload', () => {
      expect(
        parseNetworkCommand(
          'add -host irc.libera.chat -port 6697 -tls -nick mynick -user me ' +
            `-realname "My Name" -sasl_username acct -sasl_password s3cr3t Libera`,
        ),
      ).toEqual({
        kind: 'add',
        name: 'Libera',
        input: {
          host: 'irc.libera.chat',
          port: 6697,
          tls: true,
          nick: 'mynick',
          username: 'me',
          realname: 'My Name',
          sasl_account: 'acct',
          sasl_password: 's3cr3t',
        },
      });
    });

    it('defaults to TLS on 6697 when neither is given', () => {
      const cmd = parseNetworkCommand('add -host irc.libera.chat -nick bob Libera');
      expect(cmd).toMatchObject({ kind: 'add', input: { tls: true, port: 6697 } });
    });

    it('defaults to the plaintext port when -notls and no -port', () => {
      const cmd = parseNetworkCommand('add -host irc.example.org -nick bob -notls Net');
      expect(cmd).toMatchObject({ kind: 'add', input: { tls: false, port: 6667 } });
    });

    it('honors an explicit -port even with -notls', () => {
      const cmd = parseNetworkCommand('add -host h -nick n -notls -port 7000 Net');
      expect(cmd).toMatchObject({ kind: 'add', input: { tls: false, port: 7000 } });
    });

    it('maps a quoted multi-word network name', () => {
      const cmd = parseNetworkCommand('add -host h -nick n "Libera Chat"');
      expect(cmd).toMatchObject({ kind: 'add', name: 'Libera Chat' });
    });

    it('requires a name, a host, and a nick', () => {
      expect(parseNetworkCommand('add -host h -nick n')).toMatchObject({ kind: 'error' });
      expect(parseNetworkCommand('add -nick n Libera')).toEqual({
        kind: 'error',
        message: '/network add needs -host <address>',
      });
      expect(parseNetworkCommand('add -host h Libera')).toEqual({
        kind: 'error',
        message: '/network add needs -nick <nick>',
      });
    });

    it('rejects an invalid port', () => {
      expect(parseNetworkCommand('add -host h -nick n -port abc Net')).toEqual({
        kind: 'error',
        message: 'invalid port: abc',
      });
      expect(parseNetworkCommand('add -host h -nick n -port 99999 Net')).toMatchObject({
        kind: 'error',
      });
    });

    it('rejects conflicting tls flags', () => {
      expect(parseNetworkCommand('add -host h -nick n -tls -notls Net')).toEqual({
        kind: 'error',
        message: 'cannot combine -tls and -notls',
      });
    });

    it('rejects an unknown option', () => {
      expect(parseNetworkCommand('add -host h -nick n -bogus x Net')).toEqual({
        kind: 'error',
        message: 'unknown option: -bogus',
      });
    });

    it('errors when a value flag is missing its argument', () => {
      expect(parseNetworkCommand('add -host h -nick')).toEqual({
        kind: 'error',
        message: '-nick needs a value',
      });
    });

    it('flags an unquoted multi-word name as ambiguous', () => {
      expect(parseNetworkCommand('add -host h -nick n Libera Chat')).toMatchObject({
        kind: 'error',
      });
    });
  });

  describe('modify', () => {
    it('parses a partial update by name', () => {
      expect(parseNetworkCommand('modify Libera -nick newnick -notls')).toEqual({
        kind: 'modify',
        ref: 'Libera',
        input: { nick: 'newnick', tls: false },
      });
    });

    it('accepts `edit` as an alias', () => {
      expect(parseNetworkCommand('edit Libera -port 6667')).toMatchObject({
        kind: 'modify',
        ref: 'Libera',
        input: { port: 6667 },
      });
    });

    it('errors when no changes are given', () => {
      expect(parseNetworkCommand('modify Libera')).toEqual({
        kind: 'error',
        message: '/network modify Libera: no changes given',
      });
    });

    it('rejects -channel on modify (create-only field)', () => {
      expect(parseNetworkCommand('modify Libera -channel #foo')).toEqual({
        kind: 'error',
        message: '-channel can only be set when adding a network',
      });
    });
  });

  describe('remove / connect / disconnect', () => {
    it('parses each with a single ref and supports remove aliases', () => {
      expect(parseNetworkCommand('remove Libera')).toEqual({ kind: 'remove', ref: 'Libera' });
      expect(parseNetworkCommand('rm Libera')).toEqual({ kind: 'remove', ref: 'Libera' });
      expect(parseNetworkCommand('del 3')).toEqual({ kind: 'remove', ref: '3' });
      expect(parseNetworkCommand('connect Libera')).toEqual({ kind: 'connect', ref: 'Libera' });
      expect(parseNetworkCommand('disconnect Libera')).toEqual({
        kind: 'disconnect',
        ref: 'Libera',
      });
    });

    it('requires a ref', () => {
      expect(parseNetworkCommand('connect')).toEqual({
        kind: 'error',
        message: '/network connect needs a network name',
      });
    });
  });

  describe('move', () => {
    it('parses a name and a 1-based position', () => {
      expect(parseNetworkCommand('move Libera 1')).toEqual({
        kind: 'move',
        ref: 'Libera',
        position: 1,
      });
    });

    it('rejects a non-positive or non-integer position', () => {
      expect(parseNetworkCommand('move Libera 0')).toMatchObject({ kind: 'error' });
      expect(parseNetworkCommand('move Libera x')).toMatchObject({ kind: 'error' });
    });

    it('needs both a name and a position', () => {
      expect(parseNetworkCommand('move Libera')).toMatchObject({ kind: 'error' });
    });
  });

  it('errors on an unknown subcommand', () => {
    expect(parseNetworkCommand('frobnicate Libera')).toMatchObject({ kind: 'error' });
  });
});
