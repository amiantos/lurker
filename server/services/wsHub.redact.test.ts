// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The hub's side of message redaction (#1013): the `redact` command's
// refusals, the `message-redacted` frame a deletion fans out as, and the
// deletions a `sync-reactions` answer carries.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { WebSocket } from 'ws';
import { setupTestDb } from '../test-utils/testApp.js';

const testDb = setupTestDb('wshub-redact');
const CHANNEL = '#redact';

let server: http.Server;
let userId: number;
let networkId: number;
let bufferId: number;
let tagged: number;
let untagged: number;
let createSession: typeof import('../db/sessions.js').createSession;
let redactMessage: typeof import('../db/messages.js').redactMessage;
let ircManager: typeof import('./ircManager.js').default;
let url: string;

beforeAll(async () => {
  const { createUser } = await import('../db/users.js');
  const { createNetwork } = await import('../db/networks.js');
  const { insertMessage } = await import('../db/messages.js');
  ({ redactMessage } = await import('../db/messages.js'));
  const buffers = await import('../db/buffers.js');
  ({ createSession } = await import('../db/sessions.js'));
  ircManager = (await import('./ircManager.js')).default;
  const { attachWsHub } = await import('./wsHub.js');
  userId = createUser('redactuser').id;
  const net = createNetwork(userId, { name: 'n', host: 'h', port: 6697, tls: true, nick: 'me' });
  networkId = net!.id;
  buffers.ensureExists(userId, networkId, CHANNEL);
  bufferId = buffers.getBuffer(userId, networkId, CHANNEL)!.id;
  const put = (text: string, msgid?: string) =>
    Number(
      insertMessage({
        networkId,
        target: CHANNEL,
        time: new Date().toISOString(),
        type: 'message',
        nick: 'me',
        text,
        self: true,
        msgid,
      }).id,
    );
  tagged = put('tagged', 'm1');
  untagged = put('untagged');
  server = http.createServer();
  attachWsHub(server, 'redact-test-secret');
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

type Frame = Record<string, unknown>;

// Connect, collect the burst, then run `act` and resolve with every frame up to
// the first `until` after it.
function session(act: (ws: WebSocket) => void, until: string): Promise<Frame[]> {
  return new Promise((resolve, reject) => {
    const { token } = createSession(userId);
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
    const after: Frame[] = [];
    let acted = false;
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`no ${until}; after: ${after.map((f) => f.kind).join(', ')}`));
    }, 3000);
    ws.on('message', (raw) => {
      const frame = JSON.parse(raw.toString()) as Frame;
      if (!acted) {
        if (frame.kind !== 'backlog-complete') return;
        acted = true;
        act(ws);
        return;
      }
      after.push(frame);
      if (frame.kind === until) {
        clearTimeout(timer);
        ws.close();
        resolve(after);
      }
    });
  });
}

describe('the redact command', () => {
  it('says so when the line has no message id', async () => {
    const after = await session(
      (ws) => ws.send(JSON.stringify({ type: 'redact', messageId: untagged })),
      'error',
    );
    expect(after.at(-1)).toMatchObject({
      kind: 'error',
      text: expect.stringContaining('no message id'),
    });
  });

  it('says so, in the buffer, when nothing can go out', async () => {
    const after = await session(
      (ws) => ws.send(JSON.stringify({ type: 'redact', messageId: tagged, reason: 'oops' })),
      'error',
    );
    expect(after.at(-1)).toMatchObject({
      kind: 'error',
      networkId,
      target: CHANNEL,
      text: expect.stringContaining('not connected'),
    });
  });
});

describe('a deletion', () => {
  it('reaches the user as a message-redacted frame', async () => {
    const time = new Date().toISOString();
    const after = await session(
      () =>
        ircManager.emit('event', {
          type: 'message-redacted',
          userId,
          networkId,
          bufferId,
          target: CHANNEL,
          messageId: tagged,
          by: 'opal',
          reason: 'spam',
          self: true,
          time,
        }),
      'message-redacted',
    );
    expect(after.at(-1)).toEqual({
      kind: 'message-redacted',
      networkId,
      bufferId,
      target: CHANNEL,
      messageId: tagged,
      by: 'opal',
      reason: 'spam',
      self: true,
      time,
    });
  });

  it('rides the reactions sync, for a socket that was away', async () => {
    const time = '2026-11-05T00:00:00.000Z';
    expect(redactMessage({ networkId, bufferId, msgid: 'm1', by: 'me', time })).toMatchObject({
      id: tagged,
    });
    const after = await session(
      (ws) => ws.send(JSON.stringify({ type: 'sync-reactions', messageIds: [tagged, untagged] })),
      'reactions-sync',
    );
    expect(after.at(-1)).toMatchObject({
      kind: 'reactions-sync',
      messageIds: [tagged, untagged],
      redactions: { [String(tagged)]: { by: 'me', time } },
    });
  });
});
