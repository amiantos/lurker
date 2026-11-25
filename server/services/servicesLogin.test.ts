// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Saving a NickServ login given by hand (#1412): the parser on its own, then a
// real IrcConnection against the fake ircd, which is where the claim lives. The
// offer follows the network's 900, never the line that asked for it.

// MUST be first: redirects DATABASE_PATH before anything opens the db.
import '../test-utils/isolateDb.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createUser } from '../db/users.js';
import { createNetwork, getNetwork } from '../db/networks.js';
import type { Network } from '../db/networks.js';
import { ensureOpen as ensureBufferOpen } from '../db/buffers.js';
import { IrcConnection } from './ircConnection.js';
import { FakeIrcd } from '../test-utils/fakeIrcd.js';
import { until } from '../test-utils/until.js';
import { servicesLoginFromMessage, servicesLoginFromRaw } from './servicesLogin.js';

describe('servicesLoginFromMessage', () => {
  it('reads the password off IDENTIFY, with or without an account', () => {
    expect(servicesLoginFromMessage('NickServ', 'identify hunter2')).toEqual({
      password: 'hunter2',
    });
    expect(servicesLoginFromMessage('nickserv', 'IDENTIFY brad hunter2')).toEqual({
      account: 'brad',
      password: 'hunter2',
    });
  });

  it('knows ID and LOGIN as the same command', () => {
    expect(servicesLoginFromMessage('NickServ', 'id hunter2')).toEqual({ password: 'hunter2' });
    expect(servicesLoginFromMessage('NickServ', 'LOGIN brad hunter2')).toEqual({
      account: 'brad',
      password: 'hunter2',
    });
  });

  it('reads the password off REGISTER, and not the email after it', () => {
    expect(servicesLoginFromMessage('NickServ', 'REGISTER hunter2 me@example.test')).toEqual({
      password: 'hunter2',
    });
    expect(servicesLoginFromMessage('NickServ', '  register   hunter2  ')).toEqual({
      password: 'hunter2',
    });
  });

  it('takes NickServ addressed by its server', () => {
    expect(servicesLoginFromMessage('NickServ@services.libera.chat', 'identify pw')).toEqual({
      password: 'pw',
    });
  });

  it('is nothing for another target, another verb, or a verb with no password', () => {
    expect(servicesLoginFromMessage('ChanServ', 'identify #room pw')).toBeNull();
    expect(servicesLoginFromMessage('bob', 'identify hunter2')).toBeNull();
    expect(servicesLoginFromMessage('#room', 'identify hunter2')).toBeNull();
    expect(servicesLoginFromMessage('NickServ', 'INFO brad')).toBeNull();
    expect(servicesLoginFromMessage('NickServ', 'identify')).toBeNull();
    expect(servicesLoginFromMessage('NickServ', 'register')).toBeNull();
    expect(servicesLoginFromMessage('NickServ', '')).toBeNull();
  });
});

describe('servicesLoginFromRaw', () => {
  it('reads a raw PRIVMSG, which is what /ns sends', () => {
    expect(servicesLoginFromRaw('PRIVMSG NickServ :identify hunter2')).toEqual({
      password: 'hunter2',
    });
    expect(servicesLoginFromRaw('privmsg nickserv :REGISTER hunter2 me@example.test')).toEqual({
      password: 'hunter2',
    });
  });

  it('reads the NS and NICKSERV commands', () => {
    expect(servicesLoginFromRaw('NS IDENTIFY brad hunter2')).toEqual({
      account: 'brad',
      password: 'hunter2',
    });
    expect(servicesLoginFromRaw('nickserv :identify hunter2')).toEqual({ password: 'hunter2' });
  });

  it('is nothing for any other line', () => {
    expect(servicesLoginFromRaw('PRIVMSG #room :identify hunter2')).toBeNull();
    expect(servicesLoginFromRaw('JOIN #room')).toBeNull();
    expect(servicesLoginFromRaw('CS IDENTIFY #room pw')).toBeNull();
    expect(servicesLoginFromRaw('NS')).toBeNull();
    expect(servicesLoginFromRaw('')).toBeNull();
  });
});

describe('offering to save a NickServ login', () => {
  let ircd: FakeIrcd;
  let userId: number;
  let seq = 0;

  beforeAll(async () => {
    ircd = await FakeIrcd.start({});
    userId = createUser('save-login-int').id;
  });

  afterAll(async () => {
    await ircd.close();
  });

  type Event = Record<string, unknown>;

  async function connect(fields: Record<string, unknown> = {}) {
    const nick = `saver${seq++}`;
    const network = createNetwork(userId, {
      name: nick,
      host: '127.0.0.1',
      port: ircd.port,
      tls: false,
      nick,
      autoconnect: false,
      ...fields,
    })!;
    const events: Event[] = [];
    const conn = new IrcConnection({ network, onEvent: (e) => events.push(e as Event) });
    conn.connect();
    await until(() => conn.state === 'connected', 5000, 'connected');
    await ircd.waitForRegistration(nick);
    const server = (conn as unknown as { serverTarget(): string }).serverTarget();
    // The network's word that a login worked.
    const loggedIn = (account: string) =>
      ircd.sendRaw(
        nick,
        `:fake.ircd 900 ${nick} ${nick}!u@h ${account} :You are now logged in as ${account}`,
      );
    const said = (text: string) =>
      ircd.waitForLine((line, c) => c.nick === nick && line === text).then(() => undefined);
    // Lurker's lines about the login, among its others (`Connecting to…`).
    const lurkerLines = () =>
      events.filter(
        (e) =>
          e.type === 'notice' && e.nick === 'lurker' && /^(Logged in|Saved)/.test(String(e.text)),
      );
    const saved = (): Network => getNetwork(network.id, userId)!;
    return { conn, network, nick, events, server, loggedIn, said, lurkerLines, saved };
  }

  it('offers once the network confirms a /msg NickServ identify, and /save keeps it', async () => {
    const t = await connect();
    try {
      // The user's own line opens the buffer; wsHub does that off the row.
      ensureBufferOpen(userId, t.network.id, 'NickServ');
      t.conn.say('NickServ', 'identify hunter2');
      await t.said('PRIVMSG NickServ :identify hunter2');
      // Nothing on the strength of the asking alone.
      expect(t.lurkerLines()).toEqual([]);

      t.loggedIn('SaverAccount');
      await until(() => t.lurkerLines().length === 1, 5000, 'the offer');
      expect(t.lurkerLines()[0]).toMatchObject({
        target: 'NickServ',
        notable: false,
        text: 'Logged in as SaverAccount. Type /save to log in automatically from now on.',
      });
      // Offered, not done.
      expect(t.saved().sasl_password).toBeNull();

      expect(t.conn.saveLoginOffer('NickServ')).toBe(true);
      // The account is the one the network named, not the nick.
      expect(t.saved()).toMatchObject({ sasl_account: 'SaverAccount', sasl_password: 'hunter2' });
      // And on the copy this connection's own reconnects read.
      expect(t.conn.network).toMatchObject({
        sasl_account: 'SaverAccount',
        sasl_password: 'hunter2',
      });
      expect(t.lurkerLines()[1]).toMatchObject({
        target: 'NickServ',
        text: 'Saved. Lurker will log in as SaverAccount on connect.',
      });

      // Once: the offer is spent.
      expect(t.conn.saveLoginOffer('NickServ')).toBe(false);
      expect(t.events.at(-1)).toMatchObject({
        type: 'error',
        target: 'NickServ',
        text: 'Nothing to save. /save follows a login to NickServ.',
      });
    } finally {
      t.conn.dispose();
    }
  });

  it('offers after a register sent with /ns, in the buffer it was typed in', async () => {
    const t = await connect();
    try {
      ensureBufferOpen(userId, t.network.id, '&local');
      t.conn.raw('PRIVMSG NickServ :REGISTER hunter2 me@example.test', 'user', {
        issuingTarget: '&local',
      });
      await t.said('PRIVMSG NickServ :REGISTER hunter2 me@example.test');
      t.loggedIn(t.nick);
      await until(() => t.lurkerLines().length === 1, 5000, 'the offer');
      expect(t.lurkerLines()[0]).toMatchObject({ target: '&local' });
      expect(t.conn.saveLoginOffer('&local')).toBe(true);
      expect(t.saved()).toMatchObject({ sasl_account: t.nick, sasl_password: 'hunter2' });
    } finally {
      t.conn.dispose();
    }
  });

  it('says it in the server buffer when the buffer it was typed in is not open', async () => {
    const t = await connect();
    try {
      t.conn.raw('NS IDENTIFY hunter2', 'user', { issuingTarget: '#gone' });
      await t.said('NS IDENTIFY hunter2');
      t.loggedIn(t.nick);
      await until(() => t.lurkerLines().length === 1, 5000, 'the offer');
      expect(t.lurkerLines()[0]).toMatchObject({ target: t.server });
    } finally {
      t.conn.dispose();
    }
  });

  it('offers nothing for a login the user did not type: a 900 on its own', async () => {
    const t = await connect();
    try {
      t.loggedIn(t.nick);
      await until(() => t.conn.identifiedToServices, 5000, 'the 900');
      expect(t.lurkerLines()).toEqual([]);
      expect(t.conn.saveLoginOffer()).toBe(false);
      expect(t.saved().sasl_password).toBeNull();
    } finally {
      t.conn.dispose();
    }
  });

  it('offers nothing for an identify in the connect commands', async () => {
    const t = await connect({ connect_commands: 'PRIVMSG NickServ :identify hunter2' });
    try {
      await t.said('PRIVMSG NickServ :identify hunter2');
      t.loggedIn(t.nick);
      await until(() => t.conn.identifiedToServices, 5000, 'the 900');
      expect(t.lurkerLines()).toEqual([]);
    } finally {
      t.conn.dispose();
    }
  });

  it('offers nothing on a network that already has a password saved', async () => {
    const t = await connect();
    try {
      // Saved in the settings since this connection was built.
      const { updateNetwork } = await import('../db/networks.js');
      updateNetwork(t.network.id, userId, { sasl_account: 'main', sasl_password: 'first' });
      t.conn.say('NickServ', 'identify other second');
      await t.said('PRIVMSG NickServ :identify other second');
      t.loggedIn('other');
      await until(() => t.conn.identifiedToServices, 5000, 'the 900');
      expect(t.lurkerLines()).toEqual([]);
      expect(t.conn.saveLoginOffer()).toBe(false);
      expect(t.saved()).toMatchObject({ sasl_account: 'main', sasl_password: 'first' });
    } finally {
      t.conn.dispose();
    }
  });

  it('forgets a password the network never confirmed once the socket is gone', async () => {
    const t = await connect();
    try {
      t.conn.say('NickServ', 'identify wrong');
      await t.said('PRIVMSG NickServ :identify wrong');
      t.conn.client.emit('close');
      // A 900 on the next socket is that socket's login, not this password's.
      t.conn.client.emit('loggedin', { account: t.nick });
      expect(t.lurkerLines()).toEqual([]);
      expect(t.conn.saveLoginOffer()).toBe(false);
    } finally {
      t.conn.dispose();
    }
  });
});
