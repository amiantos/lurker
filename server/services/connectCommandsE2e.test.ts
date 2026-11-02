// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// A connect command is a raw line the user wrote once that runs on every
// (re)connect, with no echo. One naming an E2E channel is the same silent
// cleartext leak the other raw doors refuse (#1116) — repeated automatically.

import '../test-utils/isolateDb.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createUser } from '../db/users.js';
import { createNetwork } from '../db/networks.js';
import { FakeIrcd } from '../test-utils/fakeIrcd.js';
import { until } from '../test-utils/until.js';

type Ev = Record<string, unknown>;

let IrcConnection: typeof import('./ircConnection.js').IrcConnection;
let e2eManager: typeof import('./e2e/manager.js').e2eManager;
let ircd: FakeIrcd;
let userId: number;

beforeAll(async () => {
  ({ IrcConnection } = await import('./ircConnection.js'));
  ({ e2eManager } = await import('./e2e/manager.js'));
  ircd = await FakeIrcd.start({});
  userId = createUser('connect-cmd-e2e').id;
});

afterAll(async () => {
  await ircd.close();
});

describe('connect commands on an E2E channel', () => {
  it('refuses the cleartext line, tells the channel, and runs the rest', async () => {
    const network = createNetwork(userId, {
      name: 'connect-cmd-e2e',
      host: '127.0.0.1',
      port: ircd.port,
      tls: false,
      nick: 'cce',
      autoconnect: false,
      connect_commands: 'PRIVMSG #secret :back online\nPING connectdone',
    })!;
    e2eManager.setChannelConfig(userId, network.id, '#secret', true, 'normal');

    const events: Ev[] = [];
    const conn = new IrcConnection({ network, onEvent: (e) => events.push(e as Ev) });
    conn.connect();
    await until(() => conn.state === 'connected', 5000, 'connected');
    const me = await ircd.waitForRegistration('cce');
    await until(() => me.sent.includes('PING connectdone'), 5000, 'the next connect command');

    expect(me.sent.filter((l) => l.includes('#secret'))).toEqual([]);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'e2e', level: 'warn', target: '#secret' }),
    );
    conn.disconnect();
    await until(() => !ircd.client('cce'), 5000, 'gone');
  });
});
