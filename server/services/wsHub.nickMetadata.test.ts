// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Metadata set on somebody else (#1449) over real sockets: `set-nick-metadata`
// from one session reaches every session of the user as the nick's whole
// record, a refused value reaches nobody, and the next snapshot carries it.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { WebSocket } from 'ws';
import { setupTestDb } from '../test-utils/testApp.js';

const testDb = setupTestDb('wshub-nickmetadata');

type Frame = Record<string, unknown>;

let server: http.Server;
let userId: number;
let otherUserId: number;
let networkId: number;
let url: string;
let createSession: typeof import('../db/sessions.js').createSession;

beforeAll(async () => {
  const { createUser } = await import('../db/users.js');
  const { createNetwork } = await import('../db/networks.js');
  ({ createSession } = await import('../db/sessions.js'));
  const { attachWsHub } = await import('./wsHub.js');
  // server.ts registers the verbs in a running server; the hub alone doesn't.
  await import('./verbs/index.js');

  userId = createUser('nickmetauser').id;
  otherUserId = createUser('nickmetaother').id;
  networkId = createNetwork(userId, {
    name: 'libera',
    host: 'h',
    port: 6697,
    tls: true,
    nick: 'nickmetauser',
  })!.id;

  server = http.createServer();
  attachWsHub(server, 'nickmetadata-test-secret');
  server.listen(0);
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('test server did not bind synchronously to a TCP port');
  }
  server.unref();
  url = `ws://127.0.0.1:${address.port}/ws`;
});

afterAll(() => {
  server.close();
  testDb.cleanup();
});

// A session, open once its snapshot is in. `frames` is everything it was sent.
async function session(forUser: number): Promise<{ ws: WebSocket; frames: Frame[] }> {
  const { token } = createSession(forUser);
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
  const frames: Frame[] = [];
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no snapshot')), 3000);
    ws.on('message', (raw) => {
      const f = JSON.parse(raw.toString()) as Frame;
      frames.push(f);
      if (f.kind === 'backlog-complete') {
        clearTimeout(timer);
        resolve();
      }
    });
    ws.on('error', reject);
  });
  return { ws, frames };
}

async function until<T>(read: () => T | undefined, what: string): Promise<T> {
  const deadline = Date.now() + 3000;
  for (;;) {
    const got = read();
    if (got !== undefined) return got;
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const updates = (frames: Frame[]) => frames.filter((f) => f.kind === 'nick-metadata-updated');

describe('set-nick-metadata', () => {
  it('reaches every session of the user, whole, and nobody else', async () => {
    const a = await session(userId);
    const b = await session(userId);
    const stranger = await session(otherUserId);
    try {
      a.ws.send(
        JSON.stringify({
          type: 'set-nick-metadata',
          networkId,
          nick: 'bob',
          key: 'lurker.chat/tz',
          value: 'europe/berlin',
        }),
      );
      a.ws.send(
        JSON.stringify({
          type: 'set-nick-metadata',
          networkId,
          nick: 'bob',
          key: 'display-name',
          value: null,
        }),
      );
      const want = {
        kind: 'nick-metadata-updated',
        networkId,
        nick: 'bob',
        values: { 'lurker.chat/tz': 'Europe/Berlin', 'display-name': null },
      };
      for (const s of [a, b]) {
        await until(() => (updates(s.frames).length >= 2 ? true : undefined), 'two updates');
        expect(updates(s.frames).at(-1)).toMatchObject(want);
      }
      expect(updates(stranger.frames)).toEqual([]);

      // Refused: a hex is not a slot, an avatar is only ever hidden, and a
      // missing value is not a statement. No frame, nothing saved.
      for (const bad of [
        { key: 'color', value: '#ff0000' },
        { key: 'avatar', value: 'https://example.org/a.png' },
        { key: 'display-name' },
        { key: 'pronouns', value: 'they/them' },
      ]) {
        a.ws.send(JSON.stringify({ type: 'set-nick-metadata', networkId, nick: 'bob', ...bad }));
      }
      // A reset behind them proves the refused ones were read and dropped.
      a.ws.send(
        JSON.stringify({
          type: 'set-nick-metadata',
          networkId,
          nick: 'bob',
          key: 'display-name',
          reset: true,
        }),
      );
      await until(() => (updates(b.frames).length >= 3 ? true : undefined), 'the reset');
      expect(updates(b.frames)).toHaveLength(3);
      expect(updates(b.frames).at(-1)).toMatchObject({
        values: { 'lurker.chat/tz': 'Europe/Berlin' },
      });
    } finally {
      a.ws.close();
      b.ws.close();
      stranger.ws.close();
    }
  });

  it('is in the next snapshot, under its network', async () => {
    const late = await session(userId);
    try {
      const snapshot = late.frames.find((f) => f.kind === 'snapshot') as
        | { networks: Array<{ networkId: number; nickMetadata: unknown }> }
        | undefined;
      expect(snapshot).toBeDefined();
      const net = snapshot!.networks.find((n) => n.networkId === networkId)!;
      expect(net.nickMetadata).toEqual([
        { nick: 'bob', values: { 'lurker.chat/tz': 'Europe/Berlin' } },
      ]);
    } finally {
      late.ws.close();
    }
  });

  it("cannot be set on a network that isn't the user's", async () => {
    const stranger = await session(otherUserId);
    const mine = await session(userId);
    try {
      stranger.ws.send(
        JSON.stringify({
          type: 'set-nick-metadata',
          networkId,
          nick: 'bob',
          key: 'color',
          value: '1',
        }),
      );
      // The owner's own write lands after it and is the only change.
      mine.ws.send(
        JSON.stringify({
          type: 'set-nick-metadata',
          networkId,
          nick: 'carol',
          key: 'color',
          value: '2',
        }),
      );
      await until(() => updates(mine.frames)[0], "the owner's update");
      expect(updates(mine.frames)).toHaveLength(1);
      expect(updates(mine.frames)[0]).toMatchObject({ nick: 'carol', values: { color: '2' } });
      expect(updates(stranger.frames)).toEqual([]);
    } finally {
      stranger.ws.close();
      mine.ws.close();
    }
  });
});
