// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// WALLOPS is shown in the server buffer, as a notice search can find (#1437).

// MUST be first: redirects DATABASE_PATH before anything opens the db.
import '../test-utils/isolateDb.js';
import { describe, it, expect, afterEach } from 'vitest';
import { createUser } from '../db/users.js';
import { createNetwork } from '../db/networks.js';
import { searchMessages } from '../db/messages.js';
import { IrcConnection } from './ircConnection.js';
import ignoreRulesService from './ignoreRulesService.js';
import { FakeIrcd } from '../test-utils/fakeIrcd.js';
import { until } from '../test-utils/until.js';

type Row = {
  type: string;
  target?: string;
  nick?: string;
  text?: string;
  userhost?: string;
  notable?: boolean;
};

describe('WALLOPS', () => {
  let ircd: FakeIrcd | null = null;
  let conn: IrcConnection | null = null;
  let seq = 0;

  afterEach(async () => {
    conn?.dispose();
    conn = null;
    await ircd?.close();
    ircd = null;
  });

  async function connect() {
    ircd = await FakeIrcd.start();
    const nick = `wall${seq++}`;
    const userId = createUser(`wallops-${nick}`).id;
    const network = createNetwork(userId, {
      name: nick,
      host: '127.0.0.1',
      port: ircd.port,
      tls: false,
      nick,
      autoconnect: false,
    })!;
    const events: Row[] = [];
    conn = new IrcConnection({ network, onEvent: (e) => events.push(e as Row) });
    conn.connect();
    await until(() => conn!.state === 'connected', 5000, 'connected');
    await ircd.waitForRegistration(nick);
    const server = `:server:${network.id}`;
    const wallops = () => events.filter((e) => e.text?.startsWith('[WALLOPS]'));
    return { nick, userId, networkId: network.id, server, events, wallops };
  }

  it('shows an oper wallops in the server buffer, under the sender', async () => {
    const t = await connect();
    ircd!.sendRaw(t.nick, ':oper!o@staff.example WALLOPS :the hub is restarting');
    await until(() => t.wallops().length === 1, 5000, 'the wallops');
    expect(t.wallops()[0]).toMatchObject({
      type: 'notice',
      target: t.server,
      nick: 'oper',
      text: '[WALLOPS] the hub is restarting',
      userhost: 'oper!o@staff.example',
    });
  });

  it('shows a wallops from a server under the server name', async () => {
    const t = await connect();
    ircd!.sendRaw(t.nick, ':hub.example WALLOPS :netsplit ahead');
    await until(() => t.wallops().length === 1, 5000, 'the wallops');
    expect(t.wallops()[0]).toMatchObject({ target: t.server, nick: 'hub.example' });
  });

  it('does not count our own, relayed back, as news', async () => {
    const t = await connect();
    ircd!.sendRaw(t.nick, `:${t.nick}!u@h WALLOPS :restarting the hub`);
    ircd!.sendRaw(t.nick, ':oper!o@staff.example WALLOPS :noted');
    await until(() => t.wallops().length === 2, 5000, 'both');
    expect(t.wallops().map((e) => e.notable)).toEqual([false, undefined]);
  });

  it('is found by a search of the server buffer', async () => {
    const t = await connect();
    ircd!.sendRaw(t.nick, ':oper!o@staff.example WALLOPS :maintenance at midnight');
    await until(() => t.wallops().length === 1, 5000, 'the wallops');
    // What "Search this buffer" sends from a server buffer: in::server:<id>.
    const found = searchMessages(t.userId, { query: 'maintenance', target: t.server });
    expect(found.map((m) => [m.target, m.nick, m.text])).toEqual([
      [t.server, 'oper', '[WALLOPS] maintenance at midnight'],
    ]);
    // And scoped to it alone: nothing from another buffer, nothing missed.
    expect(searchMessages(t.userId, { query: 'maintenance', target: '#nowhere' })).toEqual([]);
  });

  it("drops an ignored sender's", async () => {
    const t = await connect();
    ignoreRulesService.add(t.userId, t.networkId, {
      mask: 'troll!*@*',
      channels: null,
      pattern: null,
      patternKind: 'substr',
      levels: ['ALL'],
      isExcept: false,
      expiresAt: null,
    });
    ircd!.sendRaw(t.nick, ':troll!t@h WALLOPS :look at me');
    ircd!.sendRaw(t.nick, ':oper!o@staff.example WALLOPS :after');
    await until(() => t.wallops().length === 1, 5000, 'the later wallops');
    expect(t.wallops().map((e) => e.nick)).toEqual(['oper']);
  });
});
