// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Our own metadata, saved per network and set again after a fresh
// registration (#1189), against the fake ircd. Its metadata store outlives a
// connection, so a reconnect sees the server keep our values the way an
// always-on ergo account does; deleting the nick's store is a server that
// forgot them, as ergo does for everyone else.

// MUST be first: redirects DATABASE_PATH before anything opens the db.
import '../test-utils/isolateDb.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createUser } from '../db/users.js';
import { createNetwork } from '../db/networks.js';
import type { Network } from '../db/networks.js';
import { listNetworkMetadata, saveNetworkMetadata } from '../db/networkMetadata.js';
import { DEFAULT_CAPS, FakeIrcd } from '../test-utils/fakeIrcd.js';
import type { FakeClient } from '../test-utils/fakeIrcd.js';
import { until } from '../test-utils/until.js';

type Ev = Record<string, unknown>;

let IrcConnection: typeof import('./ircConnection.js').IrcConnection;
let ircd: FakeIrcd;
let userId: number;
let seq = 0;

beforeAll(async () => {
  ({ IrcConnection } = await import('./ircConnection.js'));
  ircd = await FakeIrcd.start({ metadata: true });
  userId = createUser('own-metadata').id;
});

afterAll(async () => {
  await ircd.close();
});

function makeNetwork(nick: string, port = ircd.port): Network {
  return createNetwork(userId, {
    name: `own-metadata-${seq++}`,
    host: '127.0.0.1',
    port,
    tls: false,
    nick,
    autoconnect: false,
  })!;
}

// A fresh process's connection to the network: nothing held but the saved rows.
async function connect(network: Network, server = ircd) {
  const events: Ev[] = [];
  const conn = new IrcConnection({ network, onEvent: (e) => events.push(e as Ev) });
  conn.connect();
  await until(() => conn.state === 'connected', 5000, 'connected');
  const me = await server.waitForRegistration(network.nick);
  return { conn, events, me };
}

async function drop(conn: InstanceType<typeof IrcConnection>, nick: string, server = ircd) {
  conn.disconnect();
  await until(() => !server.client(nick), 5000, 'gone');
}

const metadataSent = (me: FakeClient) =>
  me.sent.filter((l) => l.startsWith('METADATA') && !l.includes(' SUB ') && !l.includes('SYNC'));

const saved = (network: Network) => Object.fromEntries(listNetworkMetadata(network.id));

describe('saving', () => {
  it("saves the user's SET and unset as they go out, and CLEAR as saved unsets", async () => {
    const network = makeNetwork('saver');
    const { conn } = await connect(network);
    try {
      conn.raw('METADATA * SET avatar :https://example.org/me/{size}.png');
      conn.raw('METADATA * SET display-name :Saver Person');
      // Saved from the server's answer, which lands after the server stores it.
      await until(() => Object.keys(saved(network)).length === 2, 5000, 'both saved');
      expect(saved(network)).toEqual({
        avatar: 'https://example.org/me/{size}.png',
        'display-name': 'Saver Person',
      });
      conn.raw('METADATA * SET display-name');
      await until(() => saved(network)['display-name'] === null, 5000, 'unset saved');
      conn.raw('METADATA * CLEAR');
      await until(() => saved(network).avatar === null, 5000, 'cleared');
      // Every key Lurker shows is a saved unset now, saved or not before.
      expect(saved(network).pronouns).toBeNull();
    } finally {
      conn.disconnect();
    }
  });

  it("saves halloy's form (our nick as the target) and a bouncer client's SET", async () => {
    const network = makeNetwork('halloyish');
    const { conn } = await connect(network);
    try {
      const client = {};
      conn.raw('METADATA halloyish SET pronouns :they/them', client as never);
      await until(() => saved(network).pronouns === 'they/them', 5000, 'saved');
      // Someone else's target is never ours to save.
      conn.raw('METADATA otherperson SET pronouns :he/him');
      conn.raw('METADATA #chan SET display-name :Channel');
      await until(() => metadataSent(ircd.client('halloyish')!).length >= 3, 5000, 'sent');
      expect(saved(network)).toEqual({ pronouns: 'they/them' });
    } finally {
      conn.disconnect();
    }
  });

  it("doesn't save a SET the server refused", async () => {
    const network = makeNetwork('refused');
    const { conn, events } = await connect(network);
    try {
      ircd.metadataSetsToThrottle = 1;
      conn.raw('METADATA * SET status :too soon');
      await until(
        () => events.some((e) => String(e.text).includes('RATE_LIMITED')),
        5000,
        'the FAIL reached the user',
      );
      expect(saved(network)).toEqual({});
      // And the next one, which the server takes, is.
      conn.raw('METADATA * SET status :now');
      await until(() => saved(network).status === 'now', 5000, 'saved from the answer');
    } finally {
      ircd.metadataSetsToThrottle = 0;
      conn.disconnect();
    }
  });

  it("doesn't save a value Lurker wouldn't show, but still sends it", async () => {
    const network = makeNetwork('badvalue');
    const { conn, me } = await connect(network);
    try {
      conn.raw('METADATA * SET avatar :javascript:alert(1)');
      await until(
        () => me.sent.includes('METADATA * SET avatar :javascript:alert(1)'),
        5000,
        'sent',
      );
      expect(saved(network)).toEqual({});
    } finally {
      conn.disconnect();
    }
  });

  it('saves a change another session made, and not the lines that only read', async () => {
    const network = makeNetwork('mirror');
    saveNetworkMetadata(userId, network.id, 'status', 'old');
    ircd.setMetadata('mirror', 'status', 'old');
    const { conn } = await connect(network);
    try {
      await until(() => conn.ownMetadataOnServer()?.status === 'old', 5000, 'listed');
      // A batched 761 is a read (a burst, a LIST): not saved.
      ircd.inject('mirror', ':fake.server BATCH +r1 metadata mirror');
      ircd.inject('mirror', '@batch=r1 :fake.server 761 mirror mirror status * :from a batch');
      ircd.inject('mirror', ':fake.server BATCH -r1');
      await until(() => conn.ownMetadataOnServer()?.status === 'from a batch', 5000, 'read');
      expect(saved(network).status).toBe('old');
      // A bare one is another session's SET.
      ircd.inject('mirror', ':fake.server 761 * mirror status * :from my phone');
      await until(() => saved(network).status === 'from my phone', 5000, 'saved');
      ircd.inject('mirror', ':fake.server 766 * mirror status :Key deleted');
      await until(() => saved(network).status === null, 5000, 'unset saved');
    } finally {
      conn.disconnect();
    }
  });

  it("doesn't save a bare line without the batch cap, where a read comes bare too", async () => {
    const unbatched = await FakeIrcd.start({
      metadata: true,
      caps: DEFAULT_CAPS.filter((cap) => cap !== 'batch'),
    });
    const network = makeNetwork('nobatch', unbatched.port);
    try {
      const { conn } = await connect(network, unbatched);
      try {
        unbatched.inject('nobatch', ':fake.server 761 * nobatch status * :an old record');
        await until(() => conn.ownMetadataOnServer()?.status === 'an old record', 5000, 'read');
        expect(saved(network)).toEqual({});
      } finally {
        conn.disconnect();
      }
    } finally {
      await unbatched.close();
    }
  });

  it('saves nothing while the socket is down', async () => {
    const network = makeNetwork('offline');
    saveNetworkMetadata(userId, network.id, 'status', 'kept');
    const { conn } = await connect(network);
    await drop(conn, 'offline');
    try {
      conn.raw('METADATA * SET display-name :Later');
      conn.raw('METADATA * CLEAR');
      expect(saved(network)).toEqual({ status: 'kept' });
    } finally {
      conn.dispose();
    }
  });

  it("saves nothing for a CLEAR typed right after /disconnect, and says it wasn't sent", async () => {
    // #1259, deterministically. The test above raced this: it waited for the
    // SERVER to see us go, and our own socket's 'close' — which is what moved
    // the state off 'connected' — could still be a tick away. Here nothing is
    // waited for at all: the QUIT has been handed to the socket and the CLEAR
    // follows it, to a server that has stopped reading us.
    const network = makeNetwork('quitter');
    saveNetworkMetadata(userId, network.id, 'status', 'kept');
    const { conn, events } = await connect(network);
    try {
      conn.disconnect();
      expect(conn.state).toBe('connected'); // the close has not run yet
      conn.raw('METADATA * CLEAR');
      expect(saved(network)).toEqual({ status: 'kept' });
      expect(events.filter((e) => e.type === 'error').map((e) => e.text)).toEqual([
        'not sent (connection dropped): METADATA * CLEAR',
      ]);
      await until(() => conn.state === 'disconnected', 5000, 'closed');
      expect(saved(network)).toEqual({ status: 'kept' });
    } finally {
      conn.dispose();
    }
  });

  it("a CLEAR that waits its turn doesn't undo a profile value saved meanwhile", async () => {
    // The save happens when the CLEAR GOES (see the test above), so a value
    // saved while it waited behind a backlog is newer than it — and the
    // re-set that save queued follows the CLEAR out, so the server keeps it.
    const network = makeNetwork('queued');
    saveNetworkMetadata(userId, network.id, 'status', 'old');
    const { conn } = await connect(network);
    try {
      await until(() => ircd.metadata.get('queued')?.get('status') === 'old', 5000, 'set');
      process.env.LURKER_SEND_PACING = '1';
      // Five lines fill the budget; the CLEAR waits its 2 s behind them.
      for (let i = 0; i < 5; i++) conn.raw(`PRIVMSG someone :fill ${i}`);
      conn.raw('METADATA * CLEAR');
      // The profile editor, while it waits.
      saveNetworkMetadata(userId, network.id, 'status', 'new');
      conn.reconcileOwnMetadata();
      await until(
        () => ircd.metadata.get('queued')?.get('status') === 'new',
        8000,
        'new on server',
      );
      expect(saved(network).status).toBe('new');
      // The CLEAR still cleared what it was typed over.
      expect(saved(network).avatar).toBeNull();
    } finally {
      process.env.LURKER_SEND_PACING = '0';
      conn.disconnect();
    }
  });

  it("a SET the server refused doesn't hold its key back from the next re-set", async () => {
    const network = makeNetwork('held');
    const { conn, me } = await connect(network);
    try {
      await until(() => me.sent.some((l) => l.startsWith('METADATA * SUB')), 5000, 'SUB');
      ircd.metadataSetsToThrottle = 1;
      ircd.metadataRetryAfter = '3600';
      conn.raw('METADATA * SET avatar :https://example.org/typed.png');
      await until(() => ircd.metadataSetsToThrottle === 0, 5000, 'refused');
      // The profile editor's save, after the refusal.
      saveNetworkMetadata(userId, network.id, 'avatar', 'https://example.org/saved.png');
      conn.reconcileOwnMetadata('user');
      await until(
        () => ircd.metadata.get('held')?.get('avatar') === 'https://example.org/saved.png',
        5000,
        'set',
      );
      expect(metadataSent(me).filter((l) => l.startsWith('METADATA * SET'))).toEqual([
        'METADATA * SET avatar :https://example.org/typed.png',
        'METADATA * SET avatar :https://example.org/saved.png',
      ]);
    } finally {
      ircd.metadataSetsToThrottle = 0;
      ircd.metadataRetryAfter = '1';
      conn.disconnect();
    }
  });
});

describe('after a fresh registration', () => {
  it('sets every saved key a server that forgot them lacks, after a LIST', async () => {
    const network = makeNetwork('forgot');
    saveNetworkMetadata(userId, network.id, 'display-name', 'Forgot Me Not');
    saveNetworkMetadata(userId, network.id, 'avatar', 'https://example.org/f.png');
    // A saved unset the server doesn't have either: nothing to send for it.
    saveNetworkMetadata(userId, network.id, 'status', null);
    const { conn, me } = await connect(network);
    try {
      await until(() => ircd.metadata.get('forgot')?.size === 2, 5000, 'set');
      expect(metadataSent(me)).toEqual([
        'METADATA * LIST',
        'METADATA * SET avatar :https://example.org/f.png',
        'METADATA * SET display-name :Forgot Me Not',
      ]);
      await drop(conn, 'forgot');
      ircd.metadata.delete('forgot');
      const again = await connect(network);
      try {
        await until(() => ircd.metadata.get('forgot')?.size === 2, 5000, 'set again');
        expect(metadataSent(again.me)).toHaveLength(3);
      } finally {
        again.conn.disconnect();
      }
    } finally {
      conn.disconnect();
    }
  });

  it('sends nothing to a server that kept them (an always-on account)', async () => {
    const network = makeNetwork('kept');
    saveNetworkMetadata(userId, network.id, 'display-name', 'Kept');
    ircd.setMetadata('kept', 'display-name', 'Kept');
    const { conn, me } = await connect(network);
    try {
      await until(() => conn.ownMetadataOnServer()?.['display-name'] === 'Kept', 5000, 'listed');
      // Long enough for a SET behind the LIST to have gone.
      await new Promise((r) => setTimeout(r, 200));
      expect(metadataSent(me)).toEqual(['METADATA * LIST']);
    } finally {
      conn.disconnect();
    }
  });

  it('the saved profile wins over what the server kept, and clears a saved unset', async () => {
    const network = makeNetwork('winner');
    saveNetworkMetadata(userId, network.id, 'avatar', 'https://example.org/mine.png');
    saveNetworkMetadata(userId, network.id, 'status', null);
    ircd.setMetadata('winner', 'avatar', 'https://example.org/changed-elsewhere.png');
    ircd.setMetadata('winner', 'status', 'stale');
    ircd.setMetadata('winner', 'pronouns', 'set elsewhere');
    const { conn, me } = await connect(network);
    try {
      await until(() => !ircd.metadata.get('winner')?.has('status'), 5000, 'unset');
      expect(metadataSent(me)).toEqual([
        'METADATA * LIST',
        'METADATA * SET avatar :https://example.org/mine.png',
        'METADATA * SET status',
      ]);
      // A key we never saved is left as the server has it, and the server's
      // LIST of it isn't saved either.
      expect(ircd.metadata.get('winner')?.get('pronouns')).toBe('set elsewhere');
      expect(saved(network)).toEqual({ avatar: 'https://example.org/mine.png', status: null });
    } finally {
      conn.disconnect();
    }
  });

  it("asks nothing when there's nothing saved", async () => {
    const network = makeNetwork('nothing');
    const { conn, me } = await connect(network);
    try {
      await until(() => me.sent.some((l) => l.startsWith('METADATA * SUB')), 5000, 'SUB');
      await new Promise((r) => setTimeout(r, 200));
      expect(metadataSent(me)).toEqual([]);
    } finally {
      conn.disconnect();
    }
  });

  it('retries a RATE_LIMITED key once, after the wait the server gave', async () => {
    const network = makeNetwork('throttled');
    saveNetworkMetadata(userId, network.id, 'display-name', 'Patient');
    ircd.metadataSetsToThrottle = 1;
    ircd.metadataRetryAfter = '1';
    const { conn, me } = await connect(network);
    try {
      await until(
        () => ircd.metadata.get('throttled')?.get('display-name') === 'Patient',
        5000,
        'set on the retry',
      );
      expect(metadataSent(me).filter((l) => l.startsWith('METADATA * SET'))).toEqual([
        'METADATA * SET display-name :Patient',
        'METADATA * SET display-name :Patient',
      ]);
    } finally {
      ircd.metadataSetsToThrottle = 0;
      conn.disconnect();
    }
  });

  it("retries the profile editor's RATE_LIMITED key too, and tells the user", async () => {
    const network = makeNetwork('eager');
    const { conn, me, events } = await connect(network);
    try {
      await until(() => me.sent.some((l) => l.startsWith('METADATA * SUB')), 5000, 'SUB');
      ircd.metadataSetsToThrottle = 1;
      saveNetworkMetadata(userId, network.id, 'avatar', 'https://example.org/a.png');
      conn.reconcileOwnMetadata('user');
      await until(
        () => ircd.metadata.get('eager')?.get('avatar') === 'https://example.org/a.png',
        5000,
        'set on the retry',
      );
      expect(events.some((e) => String(e.text).includes('RATE_LIMITED'))).toBe(true);
      expect(metadataSent(me)).toEqual([
        'METADATA * SET avatar :https://example.org/a.png',
        'METADATA * SET avatar :https://example.org/a.png',
      ]);
    } finally {
      ircd.metadataSetsToThrottle = 0;
      conn.disconnect();
    }
  });

  it("doesn't retry a RATE_LIMITED key twice on one socket before one lands", async () => {
    const network = makeNetwork('stubborn');
    saveNetworkMetadata(userId, network.id, 'display-name', 'Stubborn');
    ircd.metadataSetsToThrottle = 5;
    ircd.metadataRetryAfter = '1';
    const { conn, me } = await connect(network);
    try {
      await until(() => ircd.metadataSetsToThrottle === 3, 5000, 'two refused');
      await new Promise((r) => setTimeout(r, 1500));
      expect(ircd.metadataSetsToThrottle).toBe(3);
      expect(metadataSent(me).filter((l) => l.startsWith('METADATA * SET'))).toHaveLength(2);
    } finally {
      ircd.metadataSetsToThrottle = 0;
      conn.disconnect();
    }
  });

  it("skips a network that can't carry our keys (soju's max-keys=0)", async () => {
    const soju = await FakeIrcd.start({
      metadata: true,
      metadataCapValue: 'before-connect,max-keys=0,max-value-bytes=1',
    });
    const network = makeNetwork('sojuuser', soju.port);
    saveNetworkMetadata(userId, network.id, 'display-name', 'Not Here');
    try {
      const { conn, me } = await connect(network, soju);
      try {
        expect(conn.canSetOwnMetadata()).toBe(false);
        await new Promise((r) => setTimeout(r, 200));
        expect(metadataSent(me)).toEqual([]);
        // And a SET typed there goes out unsaved: the server's FAIL says why.
        conn.raw('METADATA * SET pronouns :any');
        expect(saved(network)).toEqual({ 'display-name': 'Not Here' });
      } finally {
        conn.disconnect();
      }
    } finally {
      await soju.close();
    }
  });

  it("never undoes the user's SET still waiting on its answer", async () => {
    const network = makeNetwork('racer');
    saveNetworkMetadata(userId, network.id, 'status', 'old');
    ircd.setMetadata('racer', 'status', 'old');
    const { conn, me } = await connect(network);
    try {
      await until(() => conn.ownMetadataOnServer()?.status === 'old', 5000, 'listed');
      // The server's record moves on without a change Lurker saves (a read).
      // ⚠ The fake's own store moves with it. Like ergo, the fake answers the
      // SUB with a 774 pointing at `*ALL SYNC`, and the sync's batch replays
      // its store a few ms on — under load that landed AFTER the injected read
      // and put `old` back, so the wait below never saw `elsewhere` (#1259).
      // Written to the store directly: `setMetadata` would also broadcast a
      // bare 761, which Lurker saves as another session's SET, and then there
      // is nothing stale left for the reconcile to be tempted by.
      ircd.metadata.get('racer')!.set('status', 'elsewhere');
      ircd.inject('racer', ':fake.server BATCH +r2 metadata racer');
      ircd.inject('racer', '@batch=r2 :fake.server 761 racer racer status * :elsewhere');
      ircd.inject('racer', ':fake.server BATCH -r2');
      await until(() => conn.ownMetadataOnServer()?.status === 'elsewhere', 5000, 'read');
      // The saved row is stale now: exactly what the reconcile below would
      // re-set, were the user's SET not pending.
      expect(saved(network).status).toBe('old');
      // The user's SET goes, and a reconcile runs before its answer.
      conn.raw('METADATA * SET status :typed-new');
      conn.reconcileOwnMetadata();
      await until(() => saved(network).status === 'typed-new', 5000, 'answered');
      await new Promise((r) => setTimeout(r, 200));
      expect(ircd.metadata.get('racer')?.get('status')).toBe('typed-new');
      expect(me.sent.filter((l) => l.includes('SET status :old'))).toEqual([]);
    } finally {
      conn.disconnect();
    }
  });

  it('reconciles when the profile is saved while connected', async () => {
    const network = makeNetwork('editor');
    const { conn, me } = await connect(network);
    try {
      await until(() => me.sent.some((l) => l.startsWith('METADATA * SUB')), 5000, 'SUB');
      saveNetworkMetadata(userId, network.id, 'homepage', 'https://example.org/');
      conn.reconcileOwnMetadata();
      await until(() => ircd.metadata.get('editor')?.has('homepage') ?? false, 5000, 'set');
      // Again with nothing changed: nothing more goes.
      conn.reconcileOwnMetadata();
      await new Promise((r) => setTimeout(r, 200));
      expect(metadataSent(me)).toEqual(['METADATA * SET homepage :https://example.org/']);
    } finally {
      conn.disconnect();
    }
  });
});
