// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Reply threads over a real socket: the followed list in the connect burst, the
// `thread` read the thread view opens with, and the two verbs that change the
// list (`thread-read`, `thread-close`) — each answered with the whole list, to
// every tab. What makes a thread followed in the first place is covered where it
// happens, on insert (ircReplies.test.ts).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { WebSocket } from 'ws';
import { setupTestDb } from '../test-utils/testApp.js';

const testDb = setupTestDb('wshub-threads');

const CHANNEL = '#threads';

let server: http.Server;
let userId: number;
let otherUserId: number;
let networkId: number;
let bufferId: number;
let createSession: typeof import('../db/sessions.js').createSession;
let url: string;
const ids: Record<string, number> = {};

beforeAll(async () => {
  const { createUser } = await import('../db/users.js');
  const { createNetwork } = await import('../db/networks.js');
  const { insertMessage } = await import('../db/messages.js');
  const { followThread } = await import('../db/threadFollows.js');
  const buffers = await import('../db/buffers.js');
  ({ createSession } = await import('../db/sessions.js'));
  const { attachWsHub } = await import('./wsHub.js');

  userId = createUser('threaduser').id;
  otherUserId = createUser('someoneelse').id;
  const net = createNetwork(userId, {
    name: 'libera',
    host: 'h',
    port: 6697,
    tls: true,
    nick: 'me',
  });
  networkId = net!.id;
  buffers.ensureExists(userId, networkId, CHANNEL);
  bufferId = buffers.getBuffer(userId, networkId, CHANNEL)!.id;

  const put = (
    key: string,
    nick: string,
    fields: { msgid?: string; reply?: string; root?: string; self?: boolean } = {},
  ) => {
    ids[key] = Number(
      insertMessage({
        networkId,
        target: CHANNEL,
        time: new Date().toISOString(),
        type: 'message',
        nick,
        text: key,
        self: fields.self ?? false,
        msgid: fields.msgid,
        replyMsgid: fields.reply,
        replyRootMsgid: fields.root,
      }).id,
    );
  };
  put('question', 'alice', { msgid: 'q' });
  put('answer', 'me', { msgid: 'a', reply: 'q', root: 'q', self: true });
  put('elsewhere', 'dave');
  put('follow-up', 'bob', { msgid: 'f', reply: 'a', root: 'q' });
  // Read through our own answer: bob's follow-up is unread.
  followThread(userId, bufferId, 'q', ids.answer);

  server = http.createServer();
  attachWsHub(server, 'threads-test-secret');
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

/**
 * Connect as `who`, collect the burst, then send `request` (if any) and resolve
 * with every frame up to the first `until` after it — or the burst's frames
 * when there's no request.
 */
function session(
  request: Frame | null,
  until: string,
  who = () => userId,
): Promise<{ burst: Frame[]; after: Frame[] }> {
  return new Promise((resolve, reject) => {
    const { token } = createSession(who());
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
    const burst: Frame[] = [];
    const after: Frame[] = [];
    let sent = false;
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`no ${until}; after the request: ${after.map((f) => f.kind).join(', ')}`));
    }, 3000);
    const done = () => {
      clearTimeout(timer);
      ws.close();
      resolve({ burst, after });
    };
    ws.on('message', (raw) => {
      const frame = JSON.parse(raw.toString()) as Frame;
      if (!sent) {
        burst.push(frame);
        if (frame.kind !== 'backlog-complete') return;
        if (!request) return done();
        sent = true;
        ws.send(JSON.stringify(request));
        return;
      }
      after.push(frame);
      if (frame.kind === until) done();
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

describe('reply threads over the socket', () => {
  it('the connect burst carries the followed list', async () => {
    const { burst } = await session(null, '');
    const frame = burst.find((f) => f.kind === 'threads-changed');
    expect(frame?.threads).toEqual([
      {
        networkId,
        bufferId,
        target: CHANNEL,
        rootMsgid: 'q',
        name: null,
        root: {
          id: ids.question,
          nick: 'alice',
          type: 'message',
          text: 'question',
          userhost: null,
        },
        unread: 1,
        highlighted: false,
        lastReplyId: ids['follow-up'],
        lastReplyTime: expect.any(String),
      },
    ]);
  });

  it('`thread` answers with the first line and every reply, oldest first', async () => {
    const { after } = await session(
      { type: 'thread', bufferId, rootMsgid: 'q', token: 7 },
      'thread',
    );
    const reply = after.find((f) => f.kind === 'thread') as Frame & {
      root: Frame;
      replies: Frame[];
    };
    expect(reply).toMatchObject({ bufferId, networkId, target: CHANNEL, rootMsgid: 'q', token: 7 });
    expect(reply.root).toMatchObject({ id: ids.question, threadReplies: 2 });
    expect(reply.replies.map((r) => r.text)).toEqual(['answer', 'follow-up']);
    expect(reply.replies[1]).toMatchObject({ replyTo: { msgid: 'a', root: 'q' } });
    expect(reply.truncated).toBe(false);
  });

  it('`thread` for someone else’s buffer is dropped', async () => {
    const { after } = await session(
      { type: 'thread', bufferId, rootMsgid: 'q' },
      'thread',
      () => otherUserId,
    ).catch((err: Error) => ({ after: [], err }));
    expect(after.some((f) => f.kind === 'thread')).toBe(false);
  });

  it('`thread-rename` names a thread for this user; blank names it from its first line', async () => {
    const named = await session(
      { type: 'thread-rename', bufferId, rootMsgid: 'q', name: '  lunch   plans ' },
      'threads-changed',
    );
    expect(named.after.find((f) => f.kind === 'threads-changed')?.threads).toMatchObject([
      { rootMsgid: 'q', name: 'lunch plans' },
    ]);
    const cleared = await session(
      { type: 'thread-rename', bufferId, rootMsgid: 'q', name: ' ' },
      'threads-changed',
    );
    expect(cleared.after.find((f) => f.kind === 'threads-changed')?.threads).toMatchObject([
      { rootMsgid: 'q', name: null },
    ]);
  });

  it('`thread-read` sends the new list; `thread-close` takes the thread off it', async () => {
    const read = await session(
      { type: 'thread-read', bufferId, rootMsgid: 'q', messageId: ids['follow-up'] },
      'threads-changed',
    );
    expect(read.after.find((f) => f.kind === 'threads-changed')?.threads).toMatchObject([
      { rootMsgid: 'q', unread: 0 },
    ]);

    const closed = await session(
      { type: 'thread-close', bufferId, rootMsgid: 'q' },
      'threads-changed',
    );
    expect(closed.after.find((f) => f.kind === 'threads-changed')?.threads).toEqual([]);
  });
});
