// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// A nick the user asks for with /nick is the network's nick from then on
// (#1418): the next connect asks for it, instead of the one in the settings.
// A rename the network makes on its own is not the user's, and is not kept.

// MUST be first: redirects DATABASE_PATH before anything opens the db.
import '../test-utils/isolateDb.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createUser } from '../db/users.js';
import { createNetwork, getNetwork } from '../db/networks.js';
import { IrcConnection, nickAskedIn } from './ircConnection.js';
import { FakeIrcd } from '../test-utils/fakeIrcd.js';
import { until } from '../test-utils/until.js';

describe('nickAskedIn', () => {
  it('reads the nick off a NICK line', () => {
    expect(nickAskedIn('NICK brad')).toBe('brad');
    expect(nickAskedIn('nick :brad')).toBe('brad');
    expect(nickAskedIn('@label=1 NICK brad')).toBe('brad');
  });

  it('is nothing for any other line', () => {
    expect(nickAskedIn('NICK')).toBeNull();
    expect(nickAskedIn('NICKSERV identify x')).toBeNull();
    expect(nickAskedIn('PRIVMSG #room :NICK brad')).toBeNull();
  });
});

describe('saving a nick the user asked for', () => {
  let ircd: FakeIrcd;
  let userId: number;
  let seq = 0;

  beforeAll(async () => {
    ircd = await FakeIrcd.start({});
    userId = createUser('save-nick-int').id;
  });

  afterAll(async () => {
    await ircd.close();
  });

  async function connect() {
    const nick = `nicker${seq++}`;
    const network = createNetwork(userId, {
      name: nick,
      host: '127.0.0.1',
      port: ircd.port,
      tls: false,
      nick,
      autoconnect: false,
    })!;
    let saves = 0;
    const conn = new IrcConnection({ network, onEvent: () => {}, onNetworkSaved: () => saves++ });
    conn.connect();
    await until(() => conn.state === 'connected', 5000, 'connected');
    await ircd.waitForRegistration(nick);
    const savedNick = () => getNetwork(network.id, userId)!.nick;
    return { conn, nick, savedNick, saves: () => saves };
  }

  it('keeps a /nick the network granted, and says the network changed', async () => {
    const t = await connect();
    try {
      t.conn.raw(`NICK ${t.nick}-new`, 'user');
      await until(() => t.conn.currentNick === `${t.nick}-new`, 5000, 'the rename');
      expect(t.savedNick()).toBe(`${t.nick}-new`);
      // On the copy this connection's own reconnects read, too.
      expect(t.conn.network.nick).toBe(`${t.nick}-new`);
      expect(t.saves()).toBe(1);
    } finally {
      t.conn.dispose();
    }
  });

  it('keeps nothing for a rename the network made on its own', async () => {
    const t = await connect();
    try {
      ircd.sendRaw(t.nick, `:${t.nick}!u@h NICK ${t.nick}-forced`);
      await until(() => t.conn.currentNick === `${t.nick}-forced`, 5000, 'the rename');
      expect(t.savedNick()).toBe(t.nick);
      expect(t.saves()).toBe(0);
    } finally {
      t.conn.dispose();
    }
  });

  it('forgets a /nick the network refused', async () => {
    const t = await connect();
    const holder = await connect();
    try {
      const asked = t.conn as unknown as { nickAsked: string | null };
      t.conn.raw(`NICK ${holder.nick}`, 'user');
      await ircd.waitForLine((line, c) => c.nick === t.nick && line === `NICK ${holder.nick}`);
      // The 433 that answers it.
      await until(() => asked.nickAsked === null, 5000, 'the refusal');
      expect(t.conn.currentNick).toBe(t.nick);
      expect(t.savedNick()).toBe(t.nick);
      expect(t.saves()).toBe(0);
    } finally {
      t.conn.dispose();
      holder.conn.dispose();
    }
  });

  it("keeps nothing for a NICK of Lurker's own", async () => {
    const t = await connect();
    try {
      t.conn.raw(`NICK ${t.nick}-own`, 'lurker');
      await until(() => t.conn.currentNick === `${t.nick}-own`, 5000, 'the rename');
      expect(t.savedNick()).toBe(t.nick);
    } finally {
      t.conn.dispose();
    }
  });
});
