// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The app's side of the engine link on its own, against a bare listener
// standing in for the engine: what the link does with the socket and with the
// frames it is offered, not what the engine does with the frames it is sent
// (server/engine/engine.test.ts has that).

// MUST be first: the link reads this instance's id from the database.
import '../test-utils/isolateDb.js';
import net from 'node:net';
import { describe, it, expect, afterEach } from 'vitest';
import { EngineLink } from './engineLink.js';
import { FrameReader, PROTOCOL_MAJOR, PROTOCOL_MINOR, encodeFrame } from '../engine/protocol.js';
import type { AppToEngine, EngineToApp } from '../engine/protocol.js';
import { until } from '../test-utils/until.js';

interface FakeEngine {
  port: number;
  seen: AppToEngine[];
  // The engine's end of the current link, once it has arrived.
  peer: net.Socket | null;
  // How many links have arrived.
  links: number;
  // How the first link ended from the engine's side: a FIN, or a reset.
  ended: 'end' | 'error' | null;
  say(frame: EngineToApp): void;
  close(): Promise<void>;
}

async function fakeEngine(): Promise<FakeEngine> {
  const fake: FakeEngine = {
    port: 0,
    seen: [],
    peer: null,
    links: 0,
    ended: null,
    say(frame) {
      fake.peer!.write(encodeFrame(frame));
    },
    close: () => new Promise((r) => server.close(() => r())),
  };
  const server = net.createServer((s) => {
    fake.peer = s;
    fake.links++;
    s.setEncoding('utf8');
    const reader = new FrameReader();
    s.on('data', (chunk: string) => {
      for (const f of reader.push(chunk) as AppToEngine[]) {
        fake.seen.push(f);
        if (f.op === 'hello') {
          s.write(
            encodeFrame({
              op: 'hello',
              protocol: PROTOCOL_MAJOR,
              minor: PROTOCOL_MINOR,
              engine: { version: 'fake' },
              held: [],
            }),
          );
        }
      }
    });
    s.on('end', () => {
      fake.ended ??= 'end';
    });
    s.on('error', () => {
      fake.ended ??= 'error';
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  fake.port = (server.address() as net.AddressInfo).port;
  return fake;
}

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

async function readyLink(fake: FakeEngine): Promise<EngineLink> {
  const link = new EngineLink({
    host: '127.0.0.1',
    port: fake.port,
    secret: 'link-test',
    retryBaseMs: 100,
    heartbeatMs: 600_000,
    log: () => {},
  });
  cleanup.push(
    () => link.stop(),
    () => fake.close(),
  );
  link.start();
  await until(() => link.state === 'ready', 3000, 'link ready');
  return link;
}

// A frame the fake sends after another is answered only once the first was
// read, so a pong to it bounds what the link has processed.
async function roundTrip(fake: FakeEngine): Promise<void> {
  const before = fake.seen.filter((f) => f.op === 'pong').length;
  fake.say({ op: 'ping' });
  await until(() => fake.seen.filter((f) => f.op === 'pong').length > before, 3000, 'pong');
}

const connectFrame = (id: string): AppToEngine => ({
  op: 'connect',
  id,
  host: '127.0.0.1',
  port: 1,
  tls: false,
  rejectUnauthorized: true,
});

describe('EngineLink', () => {
  // What shutdown() does: one `detach` per connection, then stopEngineLink(),
  // all in one tick. Those frames must still reach the engine. A destroy()
  // closes the descriptor with them possibly still queued behind an unacked
  // segment, and — when the engine has sent something we have not read yet —
  // as a RESET, which throws the queue away (#894: the engine still had the
  // dead link's claim when the next process said hello).
  it('stop() half-closes the link, so what was just written arrives and the engine sees a FIN', async () => {
    const fake = await fakeEngine();
    const link = await readyLink(fake);
    const offered: string[] = [];
    link.on('held', (id: string) => offered.push(id));
    // Something the app has not read yet, deliberately: sent and stopped in
    // the same tick, so the app's socket closes with data pending.
    fake.peer!.write(encodeFrame({ op: 'pong' }).repeat(2000));
    link.send({ op: 'detach', id: 'a:1:1' });
    link.send({ op: 'detach', id: 'a:1:2' });
    const stopped = link.stop();
    // A stopped link is dark: not ready, and what the engine still writes
    // before it reads the FIN goes nowhere.
    expect(link.state).not.toBe('ready');
    fake.say({ op: 'held', id: 'a:1:3' });
    await stopped;
    await until(() => fake.ended !== null, 3000, 'the engine saw the link end');
    expect(fake.ended).toBe('end');
    expect(fake.seen.filter((f) => f.op === 'detach').map((f) => f.id)).toEqual(['a:1:1', 'a:1:2']);
    expect(offered).toEqual([]);
    expect(link.held).toEqual([]);
  });

  it("answers the engine's ping, and takes a held offer as one more held id", async () => {
    const fake = await fakeEngine();
    const link = await readyLink(fake);
    await roundTrip(fake);
    const offered: string[] = [];
    link.on('held', (id: string) => offered.push(id));
    expect(link.holds('x:1:1')).toBe(false);
    fake.say({ op: 'held', id: 'x:1:1' });
    await until(() => offered.length === 1, 3000, 'held event');
    expect(offered).toEqual(['x:1:1']);
    expect(link.held).toContain('x:1:1');
    expect(link.holds('x:1:1')).toBe(true);
  });

  // The engine writes an offer without knowing what is already on its way in:
  // a `close` this link sent for the same id — a user's Disconnect during a
  // link blip, flushed the moment the link is back — is read after the offer
  // was written, and would then hand the app a fresh dial of what it just
  // ended if the offer were taken. Frames on a link are read in order, so an
  // offer that arrives after the close went out is stale, exactly.
  it('drops a held offer for an id it has closed on this link, until it connects it again', async () => {
    const fake = await fakeEngine();
    const link = await readyLink(fake);
    const offered: string[] = [];
    link.on('held', (id: string) => offered.push(id));
    link.requestClose('x:1:1');
    await until(() => fake.seen.some((f) => f.op === 'close'), 3000, 'close sent');
    fake.say({ op: 'held', id: 'x:1:1' });
    await roundTrip(fake);
    expect(offered).toEqual([]);
    expect(link.holds('x:1:1')).toBe(false);
    // Wanting a session under the id again lifts it.
    link.send(connectFrame('x:1:1'));
    fake.say({ op: 'held', id: 'x:1:1' });
    await until(() => offered.length === 1, 3000, 'held after connect');
  });

  it('a new link starts with a clean slate: a close sent on the old one does not shadow an offer', async () => {
    const fake = await fakeEngine();
    const link = await readyLink(fake);
    const offered: string[] = [];
    link.on('held', (id: string) => offered.push(id));
    link.requestClose('y:1:1');
    await until(() => fake.seen.some((f) => f.op === 'close'), 3000, 'close sent');
    link.simulateLoss();
    await until(() => fake.links === 2 && link.state === 'ready', 3000, 'link back');
    fake.say({ op: 'held', id: 'y:1:1' });
    await until(() => offered.length === 1, 3000, 'held on the new link');
    expect(offered).toEqual(['y:1:1']);
    expect(link.holds('y:1:1')).toBe(true);
  });

  it('a close that had to wait for the link is sent at hello, and shadows an offer on that link', async () => {
    const fake = await fakeEngine();
    const link = await readyLink(fake);
    const offered: string[] = [];
    link.on('held', (id: string) => offered.push(id));
    link.simulateLoss();
    await until(() => link.state !== 'ready', 3000, 'link down');
    link.requestClose('z:1:1');
    await until(() => fake.links === 2 && link.state === 'ready', 3000, 'link back');
    // 'ready' is the app's view; the close it sent at hello may still be in
    // flight to the fake. The pong to a ping sent now trails it on the same
    // stream, so once the fake has that, it has read the close too.
    await roundTrip(fake);
    expect(fake.seen.filter((f) => f.op === 'close').map((f) => f.id)).toEqual(['z:1:1']);
    fake.say({ op: 'held', id: 'z:1:1' });
    await roundTrip(fake);
    expect(offered).toEqual([]);
  });
});
