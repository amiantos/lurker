// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// An ignored nick's first DM must not open a DM. Driven through a real
// IrcConnection, unmocked, so the insert-time ignore stamp (decideStamp) is part
// of what's tested: the row it mints is closed, and wsHub's closed-row gate then
// drops the line (that half is in wsHub.push.test.ts).

// MUST be first — redirect DATABASE_PATH before the static imports below open
// the real data/lurker.db.
import '../test-utils/isolateDb.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { IrcConnection } from './ircConnection.js';
import ignoreRulesService from './ignoreRulesService.js';
import { createUser } from '../db/users.js';
import { createNetwork } from '../db/networks.js';
import { getState } from '../db/buffers.js';
import { listMessages } from '../db/messages.js';
import settingsService from './settingsService.js';

let userId: number;
let networkId: number;

beforeAll(() => {
  userId = createUser('ignored-dm-alice').id;
  networkId = createNetwork(userId, {
    name: 'n',
    host: 'h',
    port: 6697,
    tls: true,
    nick: 'alice',
  })!.id;
  const added = ignoreRulesService.add(userId, networkId, {
    mask: 'grima*!*@*',
    channels: null,
    pattern: null,
    patternKind: 'substr',
    levels: ['ALL'],
    isExcept: false,
    expiresAt: null,
  });
  if (!added.ok) throw new Error(added.error);
});

function makeConn(): IrcConnection {
  return new IrcConnection({
    network: {
      client_cert: null,
      client_key: null,
      proxy_enabled: 0,
      proxy_type: null,
      proxy_host: null,
      proxy_port: null,
      proxy_username: null,
      proxy_password: null,
      id: networkId,
      user_id: userId,
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
      casemapping: null,
      user_modes: null,
      flood_protection: 1,
      created_at: new Date().toISOString(),
    },
    onEvent: () => {},
  });
}

function dmFrom(conn: IrcConnection, nick: string, type: 'privmsg' | 'notice' = 'privmsg'): void {
  conn.client.emit('message', {
    nick,
    ident: nick,
    hostname: 'example.host',
    target: 'alice',
    type,
    message: 'hi',
  });
}

describe("an ignored nick's first DM", () => {
  it('mints the DM closed, so it never reaches the sidebar', () => {
    const conn = makeConn();
    dmFrom(conn, 'grima');
    dmFrom(conn, 'eomer');
    expect(getState(userId, networkId, 'grima')).toBe('closed');
    expect(getState(userId, networkId, 'eomer')).toBe('open');
  });

  it('does the same for a notice', () => {
    settingsService.update(userId, { 'chat.notice_buffer': 'private' });
    try {
      const conn = makeConn();
      dmFrom(conn, 'Grima2', 'notice');
      dmFrom(conn, 'theoden', 'notice');
      expect(getState(userId, networkId, 'grima2')).toBe('closed');
      expect(getState(userId, networkId, 'theoden')).toBe('open');
    } finally {
      settingsService.reset(userId, 'chat.notice_buffer');
    }
  });

  // chat.notice_buffer would put a notice from a nick with no buffer in the
  // server buffer (#1174), where no ignore reaches it.
  it('keeps their notice out of the server buffer, whatever chat.notice_buffer says', () => {
    for (const mode of ['auto', 'server']) {
      settingsService.update(userId, { 'chat.notice_buffer': mode });
      try {
        const conn = makeConn();
        dmFrom(conn, `Grima${mode}`, 'notice');
        dmFrom(conn, `eowyn${mode}`, 'notice');
        expect(getState(userId, networkId, `grima${mode}`)).toBe('closed');
        expect(getState(userId, networkId, `eowyn${mode}`)).toBeUndefined();
        const kept = listMessages(networkId, `:server:${networkId}`).map((m) => m.nick);
        expect(kept).toContain(`eowyn${mode}`);
        expect(kept).not.toContain(`Grima${mode}`);
      } finally {
        settingsService.reset(userId, 'chat.notice_buffer');
      }
    }
  });
});
