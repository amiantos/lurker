// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// A line sent to a rank of a channel alone (`NOTICE @#chan`, STATUSMSG) is the
// channel's line, and says which rank it was for (#1408).

// MUST be first: redirects DATABASE_PATH before anything opens the db.
import '../test-utils/isolateDb.js';
import { describe, it, expect, afterEach } from 'vitest';
import { createUser } from '../db/users.js';
import { createNetwork } from '../db/networks.js';
import { listMessages } from '../db/messages.js';
import { IrcConnection } from './ircConnection.js';
import { FakeIrcd } from '../test-utils/fakeIrcd.js';
import { until } from '../test-utils/until.js';

type Row = { type: string; target?: string; text?: string; statusmsg?: string; self?: boolean };

describe('STATUSMSG lines', () => {
  let ircd: FakeIrcd | null = null;
  let conn: IrcConnection | null = null;
  let seq = 0;

  afterEach(async () => {
    conn?.dispose();
    conn = null;
    await ircd?.close();
    ircd = null;
  });

  async function connect(isupport: string[], caps?: string[]) {
    ircd = await FakeIrcd.start({ isupport, ...(caps ? { caps } : {}) });
    const nick = `ranker${seq++}`;
    const network = createNetwork(createUser(`statusmsg-${nick}`).id, {
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
    const chat = () =>
      events.filter(
        (e) => ['message', 'notice', 'action'].includes(e.type) && !e.target?.startsWith(':'),
      );
    const stored = (target: string) => listMessages(network.id, target) as unknown as Row[];
    return { nick, chat, stored };
  }

  it('puts a notice to the ops in the channel, marked with the rank', async () => {
    const t = await connect(['STATUSMSG=@+']);
    ircd!.sendRaw(t.nick, ':alice!u@h NOTICE @#room :ops only');
    ircd!.sendRaw(t.nick, ':alice!u@h PRIVMSG +#room :voiced and up');
    ircd!.sendRaw(t.nick, ':alice!u@h PRIVMSG #room :everyone');
    await until(() => t.chat().length === 3, 5000, 'three lines');
    expect(t.chat().map((e) => [e.type, e.target, e.statusmsg, e.text])).toEqual([
      ['notice', '#room', '@', 'ops only'],
      ['message', '#room', '+', 'voiced and up'],
      ['message', '#room', undefined, 'everyone'],
    ]);
    // And after a reload: the rank is stored with the row.
    expect(t.stored('#room').map((r) => r.statusmsg)).toEqual(['@', '+', undefined]);
  });

  it("files our own line to the ops under the channel, not under '@#room'", async () => {
    // No echo-message: the row is the one we publish as the line goes.
    const t = await connect(['STATUSMSG=@+'], []);
    conn!.publish({ type: 'notice', target: '@#room', nick: t.nick, text: 'psst', self: true });
    expect(t.chat().map((e) => [e.target, e.statusmsg, e.self])).toEqual([['#room', '@', true]]);
    expect(t.stored('#room').map((r) => r.statusmsg)).toEqual(['@']);
    expect(t.stored('@#room')).toEqual([]);
  });

  it('reads a target as written on a network with no STATUSMSG', async () => {
    const t = await connect([]);
    expect(conn!.statusTarget('@#room')).toBeNull();
    conn!.publish({ type: 'message', target: '@#room', nick: t.nick, text: 'hi', self: true });
    expect(t.chat().map((e) => [e.target, e.statusmsg])).toEqual([['@#room', undefined]]);
  });

  it('leaves a channel whose own sigil is a rank symbol alone', async () => {
    await connect(['STATUSMSG=@+', 'CHANTYPES=#+']);
    expect(conn!.statusTarget('+room')).toBeNull();
    expect(conn!.statusTarget('+#room')).toEqual({ channel: '#room', prefix: '+' });
    expect(conn!.statusTarget('#room')).toBeNull();
  });
});
