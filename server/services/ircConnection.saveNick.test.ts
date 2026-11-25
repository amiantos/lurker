// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// A nick the user asks for with /nick is the network's nick from then on
// (#1418): the next connect asks for it, instead of the one in the settings.
// A rename the network makes on its own is not the user's, and is not kept.

// MUST be first: redirects DATABASE_PATH before anything opens the db.
import '../test-utils/isolateDb.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createUser } from '../db/users.js';
import { createNetwork, getNetwork, updateNetwork } from '../db/networks.js';
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
    let refusals = 0;
    const conn = new IrcConnection({
      network,
      onEvent: (e) => {
        if (/already in use/i.test(String(e.text))) refusals++;
      },
      onNetworkSaved: () => saves++,
    });
    conn.connect();
    await until(() => conn.state === 'connected', 5000, 'connected');
    await ircd.waitForRegistration(nick);
    const saved = () => getNetwork(network.id, userId)!;
    const savedNick = () => saved().nick;
    return { conn, network, nick, saved, savedNick, saves: () => saves, refusals: () => refusals };
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
      const asked = t.conn as unknown as { nickAsked: Set<string> };
      t.conn.raw(`NICK ${holder.nick}`, 'user');
      // Asked for as it goes out, and dropped by the 433 that answers it.
      await until(() => t.refusals() === 1, 5000, 'the refusal');
      expect(asked.nickAsked.size).toBe(0);
      // The nick comes free and the network moves us onto it: not our asking.
      holder.conn.dispose();
      await until(() => !ircd.client(holder.nick), 5000, 'the nick freed');
      ircd.forceNick(t.nick, holder.nick);
      await until(() => t.conn.currentNick === holder.nick, 5000, 'the rename');
      expect(t.savedNick()).toBe(t.nick);
      expect(t.saves()).toBe(0);
    } finally {
      t.conn.dispose();
      holder.conn.dispose();
    }
  });

  it('keeps the one granted of two asked for in a row', async () => {
    const t = await connect();
    const holder = await connect();
    try {
      t.conn.raw(`NICK ${t.nick}-a`, 'user');
      t.conn.raw(`NICK ${holder.nick}`, 'user');
      const asked = t.conn as unknown as { nickAsked: Set<string> };
      await until(() => t.conn.currentNick === `${t.nick}-a`, 5000, 'the rename');
      await until(() => asked.nickAsked.size === 0, 5000, 'the refusal');
      expect(t.savedNick()).toBe(`${t.nick}-a`);
    } finally {
      t.conn.dispose();
      holder.conn.dispose();
    }
  });

  // The login was the old nick's: it must not follow the new one.
  it('names the account a saved password logged in as, when it had none', async () => {
    const t = await connect();
    try {
      updateNetwork(t.network.id, userId, { sasl_password: 'hunter2' });
      t.conn.raw(`NICK ${t.nick}-afk`, 'user');
      await until(() => t.conn.currentNick === `${t.nick}-afk`, 5000, 'the rename');
      expect(t.saved()).toMatchObject({ nick: `${t.nick}-afk`, sasl_account: t.nick });
      expect(t.conn.network.sasl_account).toBe(t.nick);
    } finally {
      t.conn.dispose();
    }
  });

  it('leaves an account that was named alone', async () => {
    const t = await connect();
    try {
      updateNetwork(t.network.id, userId, { sasl_account: 'main', sasl_password: 'hunter2' });
      t.conn.raw(`NICK ${t.nick}-afk`, 'user');
      await until(() => t.conn.currentNick === `${t.nick}-afk`, 5000, 'the rename');
      expect(t.saved()).toMatchObject({ nick: `${t.nick}-afk`, sasl_account: 'main' });
    } finally {
      t.conn.dispose();
    }
  });

  // The network answers a NICK for the nick we hold with silence.
  it('keeps a fallback the user asks to stay on, and stops trying for the old nick', async () => {
    const t = await connect();
    try {
      // On a nick the network gave us, with a watch out for the saved one.
      const fallback = `${t.nick}1`;
      ircd.forceNick(t.nick, fallback);
      await until(() => t.conn.currentNick === fallback, 5000, 'the fallback');
      expect(t.savedNick()).toBe(t.nick);
      t.conn.regainNick = t.nick;
      t.conn.raw(`NICK ${fallback}`, 'user');
      await until(() => t.savedNick() === fallback, 5000, 'the save');
      expect(t.conn.regainNick).toBeNull();
      expect(t.saves()).toBe(1);
    } finally {
      t.conn.dispose();
    }
  });

  it('judges what is saved by the row, not the copy it connected with', async () => {
    const t = await connect();
    try {
      t.conn.raw(`NICK ${t.nick}-x`, 'user');
      await until(() => t.conn.currentNick === `${t.nick}-x`, 5000, 'the rename');
      // Changed in the settings since; the connection's copy still says -x.
      updateNetwork(t.network.id, userId, { nick: 'elsewhere' });
      t.conn.raw(`NICK ${t.nick}`, 'user');
      await until(() => t.conn.currentNick === t.nick, 5000, 'the rename back');
      t.conn.raw(`NICK ${t.nick}-x`, 'user');
      await until(() => t.conn.currentNick === `${t.nick}-x`, 5000, 'the rename again');
      expect(t.savedNick()).toBe(`${t.nick}-x`);
    } finally {
      t.conn.dispose();
    }
  });

  it('keeps a NICK from an attached IRC client, but not one for the nick it already has', async () => {
    const t = await connect();
    try {
      const client = {} as Parameters<typeof t.conn.raw>[1];
      t.conn.raw(`NICK ${t.nick}`, client);
      t.conn.raw(`NICK ${t.nick}-irc`, client);
      await until(() => t.conn.currentNick === `${t.nick}-irc`, 5000, 'the rename');
      expect(t.savedNick()).toBe(`${t.nick}-irc`);
      expect(t.saves()).toBe(1);
    } finally {
      t.conn.dispose();
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
