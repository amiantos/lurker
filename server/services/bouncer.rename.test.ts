// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// A channel rename through the bouncer (draft/channel-rename, #858).
//
// Lurker asks the network for the cap, so the network sends it one RENAME
// line. An attached client gets that line only if it negotiated the cap with
// the bouncer; any other gets what the spec has a server send such a client:
// a PART of the old name, then the new channel as if just joined.
//
// Against a real IrcConnection on the fake ircd, with the real bouncer in
// front. The RENAME lines are ergo 2.18's, probed live.

import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { setupTestDb } from '../test-utils/testApp.js';
import { FakeIrcd, DEFAULT_CAPS } from '../test-utils/fakeIrcd.js';
import { until } from '../test-utils/until.js';
import { CHANNEL_RENAME_CAP } from '../../shared/channelRename.js';

const ctx = setupTestDb('services-bouncer-rename');

let harnessMod: typeof import('../test-utils/bouncerHarness.js');
let bouncerMod: typeof import('./bouncer.js');
let ircManager: typeof import('./ircManager.js').default;
let buffers: typeof import('../db/buffers.js');
let users: typeof import('../db/users.js');
let networks: typeof import('../db/networks.js');
let hashPassword: typeof import('./password.js').hashPassword;
let harness: import('../test-utils/bouncerHarness.js').Harness;
let ircd: FakeIrcd;

beforeAll(async () => {
  process.env.LURKER_BOUNCER_ENABLED = 'true';
  harnessMod = await import('../test-utils/bouncerHarness.js');
  bouncerMod = await import('./bouncer.js');
  ircManager = (await import('./ircManager.js')).default;
  buffers = await import('../db/buffers.js');
  users = await import('../db/users.js');
  networks = await import('../db/networks.js');
  ({ hashPassword } = await import('./password.js'));
  ircd = await FakeIrcd.start({ caps: [...DEFAULT_CAPS, CHANNEL_RENAME_CAP] });
  harness = await harnessMod.startHarness();
});

afterAll(async () => {
  harness.stop();
  await ircd.close();
  ctx.cleanup();
});

beforeEach(() => {
  bouncerMod.resetAuthThrottle();
});

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

type Client = Awaited<ReturnType<import('../test-utils/bouncerHarness.js').Harness['connect']>>;
type Conn = import('./ircConnection.js').IrcConnection;

interface Account {
  userId: number;
  username: string;
  name: string;
  nick: string;
  networkId: number;
  conn: Conn;
}

const PASSWORD = 'hunter2hunter2';
const NUL = String.fromCharCode(0);
let seq = 0;

/** A user with one network, a real IrcConnection registered on the fake ircd. */
async function seedAccount(): Promise<Account> {
  seq += 1;
  const user = users.createUser(`ren_${seq}`);
  users.setPasswordHash(user.id, hashPassword(PASSWORD));
  const name = 'neta';
  const nick = `ren${seq}`;
  const network = networks.createNetwork(user.id, {
    name,
    host: '127.0.0.1',
    port: ircd.port,
    tls: false,
    nick,
    autoconnect: false,
  } as Parameters<typeof networks.createNetwork>[1])!;
  const conn = ircManager.startNetwork(user.id, network.id)!;
  cleanups.push(() => {
    conn.dispose();
    ircManager.connectionsForUser(user.id).delete(network.id);
  });
  await until(() => conn.state === 'connected', 5000, 'connected');
  return { userId: user.id, username: user.username, name, nick, networkId: network.id, conn };
}

/** Log in over SASL to the account's network, with `caps`, and wait out the welcome. */
async function attach(acct: Account, caps: string[] = []): Promise<Client> {
  const c = await harness.connect();
  cleanups.push(() => c.close());
  c.send('CAP LS 302');
  await c.waitFor((l) => l.includes('CAP') && l.includes('LS'));
  c.send('NICK client');
  c.send('USER client 0 * :client');
  c.send(`CAP REQ :${['sasl', ...caps].join(' ')}`);
  await c.waitFor((l) => l.includes('ACK'));
  c.send('AUTHENTICATE PLAIN');
  await c.waitFor((l) => l === 'AUTHENTICATE +');
  const login = `${acct.username}/${acct.name}`;
  c.send(`AUTHENTICATE ${Buffer.from(['', login, PASSWORD].join(NUL)).toString('base64')}`);
  await c.waitForCommand('903');
  c.send('CAP END');
  await c.waitForCommand('422');
  return c;
}

const commandOf = (line: string) => harnessMod.commandOf(line);

/** Join `chan` through the account's connection and wait for the echo. */
async function join(acct: Account, chan: string): Promise<void> {
  ircManager.joinChannel(acct.userId, acct.networkId, chan);
  await until(() => acct.conn.isChannelJoined(chan), 5000, `joined ${chan}`);
  await until(
    () => buffers.getState(acct.userId, acct.networkId, chan) === 'open',
    5000,
    `${chan} buffer open`,
  );
}

let chanSeq = 0;
/** A pair of channel names no other test has used: waitFor matches lines
 *  already received, so a reused name would answer for an earlier test. */
function names(): { from: string; to: string } {
  chanSeq += 1;
  return { from: `#before${chanSeq}`, to: `#after${chanSeq}` };
}

/** The lines the client got from index `at` on, by command. */
const since = (c: Client, at: number) => c.lines.slice(at);

describe('a channel rename through the bouncer (#858)', () => {
  it('the network offers the cap, Lurker takes it, and the bouncer offers it on', async () => {
    const acct = await seedAccount();
    expect(acct.conn.client.network.cap.enabled).toContain(CHANNEL_RENAME_CAP);
    const c = await harness.connect();
    cleanups.push(() => c.close());
    c.send('CAP LS 302');
    c.send('NICK client');
    c.send('USER client 0 * :client');
    c.send('CAP REQ :sasl');
    await c.waitFor((l) => l.includes('ACK'));
    c.send('AUTHENTICATE PLAIN');
    await c.waitFor((l) => l === 'AUTHENTICATE +');
    const login = `${acct.username}/${acct.name}`;
    c.send(`AUTHENTICATE ${Buffer.from(['', login, PASSWORD].join(NUL)).toString('base64')}`);
    await c.waitForCommand('903');
    // A pass-through cap is known once the client is bound to a network.
    c.send('CAP LS 302');
    await c.waitFor((l) => l.includes(' LS ') && l.includes(CHANNEL_RENAME_CAP), 5000);
  });

  it('a client with the cap gets the RENAME as the network sent it', async () => {
    const acct = await seedAccount();
    const { from, to } = names();
    await join(acct, from);
    const c = await attach(acct, [CHANNEL_RENAME_CAP]);
    await c.waitFor((l) => commandOf(l) === 'JOIN' && l.includes(from));
    const at = c.lines.length;

    ircd.sendRaw(acct.nick, `:op!o@peer.fake RENAME ${from} ${to} :tidy up`);
    await c.waitFor((l) => commandOf(l) === 'RENAME' && l.includes(to), 5000);

    const got = since(c, at);
    expect(got.filter((l) => commandOf(l) === 'RENAME')).toEqual([
      expect.stringContaining(`:op!o@peer.fake RENAME ${from} ${to} :tidy up`),
    ]);
    // One line, not the fallback too.
    expect(got.filter((l) => ['PART', 'JOIN'].includes(commandOf(l)))).toEqual([]);
    expect(acct.conn.isChannelJoined(to)).toBe(true);
  });

  it('a client without it is parted from the old name and joined to the new', async () => {
    const acct = await seedAccount();
    const { from, to } = names();
    await join(acct, from);
    const c = await attach(acct);
    await c.waitFor((l) => commandOf(l) === 'JOIN' && l.includes(from));
    const at = c.lines.length;

    ircd.sendRaw(acct.nick, `:op!o@peer.fake RENAME ${from} ${to} :tidy up`);
    await c.waitFor((l) => commandOf(l) === '366' && l.includes(to), 5000);

    const got = since(c, at);
    expect(got.filter((l) => commandOf(l) === 'RENAME')).toEqual([]);
    const part = got.findIndex((l) => commandOf(l) === 'PART');
    const joinAt = got.findIndex((l) => commandOf(l) === 'JOIN');
    const namesAt = got.findIndex((l) => commandOf(l) === '353');
    // From us, not from whoever renamed it: the client's own PART and JOIN.
    expect(got[part]).toContain(`:${acct.nick}!`);
    expect(got[part]).toContain(`PART ${from} :Channel renamed: tidy up`);
    expect(got[joinAt]).toContain(`:${acct.nick}!`);
    expect(got[joinAt]).toContain(`JOIN ${to}`);
    expect(got[namesAt]).toContain(to);
    expect(got[namesAt]).toContain(acct.nick);
    expect(part).toBeLessThan(joinAt);
    expect(joinAt).toBeLessThan(namesAt);
  });

  it("words the PART without a reason when the rename gave none (ergo's two-parameter form)", async () => {
    const acct = await seedAccount();
    const { from, to } = names();
    await join(acct, from);
    const c = await attach(acct);
    await c.waitFor((l) => commandOf(l) === 'JOIN' && l.includes(from));

    ircd.sendRaw(acct.nick, `:op!o@peer.fake RENAME ${from} ${to}`);
    const part = await c.waitFor((l) => commandOf(l) === 'PART' && l.includes(from), 5000);

    expect(part.endsWith(`PART ${from} :Channel renamed`)).toBe(true);
  });

  it('sends a client without the cap nothing for a rename that only changes case', async () => {
    const acct = await seedAccount();
    const { from } = names();
    await join(acct, from);
    const c = await attach(acct);
    await c.waitFor((l) => commandOf(l) === 'JOIN' && l.includes(from));
    const at = c.lines.length;
    const to = from.toUpperCase();

    ircd.sendRaw(acct.nick, `:op!o@peer.fake RENAME ${from} ${to}`);
    await until(() => acct.conn.channelState(from)?.name === to, 5000, 'renamed upstream');
    // A round trip behind it: whatever the rename sent this client is here.
    c.send('NAMES #probe-case');
    await c.waitFor((l) => commandOf(l) === '366' && l.includes('#probe-case'), 5000);

    expect(since(c, at).filter((l) => ['PART', 'JOIN', 'RENAME'].includes(commandOf(l)))).toEqual(
      [],
    );
  });
});
