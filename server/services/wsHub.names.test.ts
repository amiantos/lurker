// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The connect snapshot carries no channel's member list; the list arrives as a
// `names` frame the first time a socket hydrates the buffer (lurker#1292, from
// lurker-ios#257). A live connection against the fake ircd, a real WS hub, and
// real sockets — the memo is per socket, so two of them are the test.
import '../test-utils/isolateDb.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { WebSocket } from 'ws';
import { createUser } from '../db/users.js';
import { createNetwork } from '../db/networks.js';
import { createSession } from '../db/sessions.js';
import { FakeIrcd } from '../test-utils/fakeIrcd.js';
import { until } from '../test-utils/until.js';

type Frame = Record<string, unknown>;

let ircManager: typeof import('./ircManager.js').default;
let ircd: FakeIrcd;
let server: http.Server;
let url: string;
let userId: number;
let networkId: number;
let offlineNetworkId: number;

beforeAll(async () => {
  ircManager = (await import('./ircManager.js')).default;
  const { attachWsHub } = await import('./wsHub.js');
  // The `before` page goes through the verb registry, which server.ts loads.
  await import('./verbs/index.js');
  ircd = await FakeIrcd.start({});
  userId = createUser('names-user').id;
  networkId = createNetwork(userId, {
    name: 'live',
    host: '127.0.0.1',
    port: ircd.port,
    tls: false,
    nick: 'namesuser',
    autoconnect: false,
  })!.id;
  offlineNetworkId = createNetwork(userId, {
    name: 'offline',
    host: '127.0.0.1',
    port: 1,
    tls: false,
    nick: 'namesuser',
    autoconnect: false,
  })!.id;
  // The hub first, as in the process: its listeners mint the buffer rows the
  // joins below produce, and a `before` page reads through the registry.
  server = http.createServer();
  attachWsHub(server, 'names-test-secret');
  server.listen(0);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  server.unref();
  url = `ws://127.0.0.1:${address.port}/ws`;

  const conn = ircManager.startNetwork(userId, networkId)!;
  await until(() => conn.state === 'connected', 5000, 'connected');
  ircManager.joinChannel(userId, networkId, '#Big');
  ircManager.joinChannel(userId, networkId, '#small');
  await until(
    () => !conn.membersPending('#Big') && !conn.membersPending('#small'),
    5000,
    'names heard',
  );
  // Company, so the list is more than ourselves.
  ircd.sendRaw('namesuser', ':alice!~a@peer.fake JOIN #Big');
  ircd.sendRaw('namesuser', ':bob!~b@peer.fake JOIN #Big');
  await until(() => conn.channelState('#Big')?.members.size === 3, 5000, 'alice and bob in');
}, 20000);

afterAll(async () => {
  server.close();
  ircManager.stopNetwork(userId, networkId);
  await ircd.close();
});

interface Client {
  frames: Frame[];
  send(frame: Frame): void;
  waitFor(pred: (f: Frame) => boolean, what: string): Promise<Frame>;
  close(): void;
}

const isNames = (target: string) => (f: Frame) =>
  f.kind === 'irc' && f.type === 'names' && String(f.target).toLowerCase() === target;

async function connect(since?: number): Promise<Client> {
  const { token } = createSession(userId);
  const ws = new WebSocket(since ? `${url}?since=${since}` : url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const frames: Frame[] = [];
  const waiters: Array<{ pred: (f: Frame) => boolean; resolve: (f: Frame) => void }> = [];
  ws.on('message', (raw) => {
    const frame = JSON.parse(raw.toString()) as Frame;
    frames.push(frame);
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (waiters[i].pred(frame)) waiters.splice(i, 1)[0].resolve(frame);
    }
  });
  const client: Client = {
    frames,
    send: (frame) => ws.send(JSON.stringify(frame)),
    waitFor: (pred, what) =>
      new Promise((resolve, reject) => {
        const hit = frames.find(pred);
        if (hit) return resolve(hit);
        const timer = setTimeout(
          () =>
            reject(
              new Error(
                `no ${what}; after the burst: ${afterBurst(client)
                  .map(
                    (f) => `${f.kind}${f.type ? `/${f.type}` : ''}${f.text ? `(${f.text})` : ''}`,
                  )
                  .join(', ')}`,
              ),
            ),
          3000,
        );
        waiters.push({
          pred,
          resolve: (f) => {
            clearTimeout(timer);
            resolve(f);
          },
        });
      }),
    close: () => ws.close(),
  };
  await client.waitFor((f) => f.kind === 'backlog-complete', 'backlog-complete');
  return client;
}

/** Everything after the connect burst: frames the socket asked for. */
function afterBurst(client: Client): Frame[] {
  const end = client.frames.findIndex((f) => f.kind === 'backlog-complete');
  return client.frames.slice(end + 1);
}

describe('the connect snapshot has no member lists', () => {
  it('ships every live channel with members: [] and membersPending, and no names frame', async () => {
    const client = await connect();
    try {
      const snapshot = client.frames.find((f) => f.kind === 'snapshot')!;
      const networks = snapshot.networks as Array<Record<string, unknown>>;
      const live = networks.find((n) => n.networkId === networkId)!;
      const channels = live.channels as Array<Record<string, unknown>>;
      expect(channels.map((c) => String(c.name).toLowerCase()).sort()).toEqual(['#big', '#small']);
      for (const ch of channels) {
        expect(ch.members).toEqual([]);
        expect(ch.membersPending).toBe(true);
        // The rest of the channel's state still rides the snapshot.
        expect(ch).toHaveProperty('topic');
        expect(ch).toHaveProperty('modes');
      }
      const offline = networks.find((n) => n.networkId === offlineNetworkId)!;
      expect(offline.channels).toEqual([]);
      expect(client.frames.some((f) => f.kind === 'irc' && f.type === 'names')).toBe(false);
    } finally {
      client.close();
    }
  });
});

describe('the list arrives with the first hydration', () => {
  it('history latest: a names frame with the full list precedes the reply, once per socket', async () => {
    const client = await connect();
    try {
      client.send({ type: 'history', mode: 'latest', networkId, target: '#big', limit: 50 });
      const reply = await client.waitFor(
        (f) => f.kind === 'history' && String(f.target).toLowerCase() === '#big',
        'history reply',
      );
      const names = client.frames.find(isNames('#big'))!;
      expect(names).toBeDefined();
      expect(names).not.toHaveProperty('membersPending');
      expect(names.networkId).toBe(networkId);
      expect(typeof names.time).toBe('string');
      const nicks = (names.members as Array<{ nick: string }>).map((m) => m.nick).sort();
      expect(nicks).toEqual(['alice', 'bob', 'namesuser']);
      // Casing is the server's, like every other frame about this channel.
      expect(names.target).toBe('#Big');
      expect(client.frames.indexOf(names)).toBeLessThan(client.frames.indexOf(reply));

      // The next page — any mode — sends no second list.
      const before = afterBurst(client).filter(isNames('#big')).length;
      // A `before` page always names its anchor, as both clients send it.
      const oldest = (reply.events as Array<{ id: number }>)[0]?.id ?? 1;
      client.send({
        type: 'history',
        mode: 'before',
        networkId,
        target: '#big',
        before: oldest,
        limit: 50,
      });
      await client.waitFor(
        (f) =>
          f.kind === 'history' && f.mode === 'before' && String(f.target).toLowerCase() === '#big',
        'before reply',
      );
      client.send({ type: 'history', mode: 'latest', networkId, target: '#BIG', limit: 50 });
      await until(
        () => afterBurst(client).filter((f) => f.kind === 'history').length === 3,
        3000,
        'third reply',
      );
      expect(afterBurst(client).filter(isNames('#big')).length).toBe(before);
      expect(before).toBe(1);
    } finally {
      client.close();
    }
  });

  it('a second socket gets its own list; a jump (around) counts as an open', async () => {
    const a = await connect();
    const b = await connect();
    try {
      a.send({ type: 'history', mode: 'latest', networkId, target: '#small', limit: 50 });
      await a.waitFor(isNames('#small'), 'names on a');
      expect(afterBurst(b).some(isNames('#small'))).toBe(false);
      b.send({
        type: 'history',
        mode: 'around',
        networkId,
        target: '#small',
        anchorId: 1,
        limit: 20,
      });
      await b.waitFor(isNames('#small'), 'names on b');
      expect(afterBurst(a).filter(isNames('#small')).length).toBe(1);
    } finally {
      a.close();
      b.close();
    }
  });

  it('open-buffer on a channel we are in sends the list before the backlog', async () => {
    const client = await connect();
    try {
      client.send({ type: 'open-buffer', networkId, target: '#small' });
      // The burst shipped #small as a shell `backlog` already; the reply is the
      // `buffer-opened` ack, and the backlog right before it.
      const opened = await client.waitFor(
        (f) => f.kind === 'buffer-opened' && String(f.target).toLowerCase() === '#small',
        'buffer-opened',
      );
      const after = afterBurst(client);
      const backlog = after.find(
        (f) => f.kind === 'backlog' && String(f.target).toLowerCase() === '#small',
      )!;
      expect(backlog).toBeDefined();
      const names = after.find(isNames('#small'))!;
      expect(names).toBeDefined();
      expect(after.indexOf(names)).toBeLessThan(after.indexOf(backlog));
      expect(after.indexOf(backlog)).toBeLessThan(after.indexOf(opened));
      // And the memo covers both doors: a history page after the open sends none.
      client.send({ type: 'history', mode: 'latest', networkId, target: '#small', limit: 50 });
      await client.waitFor(
        (f) => f.kind === 'history' && String(f.target).toLowerCase() === '#small',
        'history reply',
      );
      expect(afterBurst(client).filter(isNames('#small')).length).toBe(1);
    } finally {
      client.close();
    }
  });

  it('nothing for a DM, a channel we are not in, or a channel on an offline network', async () => {
    const client = await connect();
    try {
      client.send({ type: 'history', mode: 'latest', networkId, target: 'alice', limit: 50 });
      await client.waitFor((f) => f.kind === 'history' && f.target === 'alice', 'dm history');
      client.send({ type: 'history', mode: 'latest', networkId, target: '#elsewhere', limit: 50 });
      await client.waitFor(
        (f) => f.kind === 'history' && f.target === '#elsewhere',
        'unjoined history',
      );
      client.send({
        type: 'history',
        mode: 'latest',
        networkId: offlineNetworkId,
        target: '#small',
        limit: 50,
      });
      await client.waitFor(
        (f) => f.kind === 'history' && f.networkId === offlineNetworkId,
        'offline history',
      );
      expect(afterBurst(client).some((f) => f.kind === 'irc' && f.type === 'names')).toBe(false);
    } finally {
      client.close();
    }
  });

  it("a resume connect sends the list ahead of each live channel's gap frame", async () => {
    // A cursor from before any row: the gap is the whole buffer, so each live
    // channel gets a real slice, not a shell. The client holding these buffers
    // never asks for history, so the list has to ride the slice.
    const client = await connect(1);
    try {
      const burst = client.frames;
      const end = burst.findIndex((f) => f.kind === 'backlog-complete');
      for (const chan of ['#big', '#small']) {
        const backlog = burst.findIndex(
          (f) => f.kind === 'backlog' && String(f.target).toLowerCase() === chan,
        );
        const names = burst.findIndex(isNames(chan));
        expect(backlog, `${chan} backlog`).toBeGreaterThan(-1);
        expect(backlog).toBeLessThan(end);
        expect((burst[backlog] as { mode?: string }).mode).not.toBe('shell');
        expect(names, `${chan} names`).toBeGreaterThan(-1);
        expect(names).toBeLessThan(backlog);
      }
      expect(burst.filter((f) => f.kind === 'irc' && f.type === 'names').length).toBe(2);
      // And the memo counts it: opening the buffer now sends no second list.
      client.send({ type: 'history', mode: 'latest', networkId, target: '#big', limit: 50 });
      await client.waitFor(
        (f) => f.kind === 'history' && String(f.target).toLowerCase() === '#big',
        'history reply',
      );
      expect(afterBurst(client).some(isNames('#big'))).toBe(false);
    } finally {
      client.close();
    }
  });

  it('the names verb answers from server state, every time, for a channel we are in', async () => {
    const client = await connect();
    try {
      client.send({ type: 'names', networkId, target: '#BIG' });
      const first = await client.waitFor(isNames('#big'), 'names on request');
      expect((first.members as unknown[]).length).toBe(3);
      expect(first.target).toBe('#Big');
      // Asked outright, it is answered again — the verb is not the memo.
      client.send({ type: 'names', networkId, target: '#big' });
      await until(
        () => afterBurst(client).filter(isNames('#big')).length === 2,
        3000,
        'second answer',
      );
      // Nothing for a channel we are not in, or a DM; the socket stays quiet.
      client.send({ type: 'names', networkId, target: '#elsewhere' });
      client.send({ type: 'names', networkId, target: 'alice' });
      client.send({ type: 'history', mode: 'latest', networkId, target: 'alice', limit: 1 });
      await client.waitFor((f) => f.kind === 'history' && f.target === 'alice', 'dm history');
      expect(afterBurst(client).filter((f) => f.kind === 'irc' && f.type === 'names').length).toBe(
        2,
      );
    } finally {
      client.close();
    }
  });

  it('the 366 fan-out still reaches a socket that already holds the list', async () => {
    const client = await connect();
    try {
      client.send({ type: 'history', mode: 'latest', networkId, target: '#big', limit: 50 });
      await client.waitFor(isNames('#big'), 'names on hydration');
      const count = () => afterBurst(client).filter(isNames('#big')).length;
      expect(count()).toBe(1);
      // A prefix-mode change on ourselves republishes the list to everyone.
      ircd.sendRaw('namesuser', ':oper!~oper@peer.fake MODE #Big +o namesuser');
      await until(() => count() === 2, 5000, 'republished names');
    } finally {
      client.close();
    }
  });
});
