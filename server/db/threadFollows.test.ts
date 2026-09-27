// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The followed-thread list the sidebar shows: what it lists, and what it
// forgets. Following itself happens on insert (ircReplies.test.ts).

import { describe, it, expect, beforeAll } from 'vitest';
import { setupTestDb } from '../test-utils/testApp.js';

setupTestDb('thread-follows');

let insertMessage: typeof import('./messages.js').insertMessage;
let tf: typeof import('./threadFollows.js');
let db: typeof import('./index.js').default;
let userId: number;
let networkId: number;
let seq = 0;

beforeAll(async () => {
  ({ insertMessage } = await import('./messages.js'));
  tf = await import('./threadFollows.js');
  ({ default: db } = await import('./index.js'));
  const { createUser } = await import('./users.js');
  const { createNetwork } = await import('./networks.js');
  userId = createUser('follower').id;
  networkId = createNetwork(userId, {
    name: 'n',
    host: 'h',
    port: 6697,
    tls: true,
    nick: 'me',
  })!.id;
});

const DAY = 86_400_000;
const NOW = Date.parse('2026-09-26T12:00:00Z');

/** A thread in its own channel: a first line and one reply `ageDays` old. */
function thread(ageDays: number, fields: { self?: boolean } = {}) {
  const target = `#t${seq++}`;
  const time = new Date(NOW - ageDays * DAY).toISOString();
  const root = `root-${target}`;
  const put = (extra: Record<string, unknown>) =>
    insertMessage({ networkId, target, time, type: 'message', nick: 'alice', text: 'x', ...extra });
  const { bufferId } = put({ msgid: root });
  const reply = put({ replyMsgid: root, replyRootMsgid: root, self: fields.self });
  return { target, bufferId, root, replyId: Number(reply.id) };
}

const listed = () => tf.listFollowedThreads(userId, NOW).map((t) => t.rootMsgid);
const rowCount = (bufferId: number) =>
  db.prepare(`SELECT count(*) FROM thread_follows WHERE buffer_id = ?`).pluck().get(bufferId);

describe('listFollowedThreads', () => {
  it('lists a quiet thread while it has something unread, and forgets it once read', () => {
    const t = thread(10);
    tf.followThread(userId, t.bufferId, t.root, 0);
    expect(listed()).toContain(t.root);

    tf.markThreadRead(userId, t.bufferId, t.root, t.replyId);
    expect(listed()).not.toContain(t.root);
    expect(rowCount(t.bufferId)).toBe(0);
  });

  it('keeps a recent thread with nothing unread', () => {
    const t = thread(1);
    tf.followThread(userId, t.bufferId, t.root, t.replyId);
    expect(tf.listFollowedThreads(userId, NOW).find((x) => x.rootMsgid === t.root)).toMatchObject({
      unread: 0,
      target: t.target,
      root: { nick: 'alice', text: 'x' },
    });
  });

  it('keeps a closed thread’s row while recent — so others talking can’t reopen it — then forgets it', () => {
    const t = thread(1);
    tf.followThread(userId, t.bufferId, t.root, t.replyId);
    tf.closeThread(userId, t.bufferId, t.root);
    expect(listed()).not.toContain(t.root);
    expect(rowCount(t.bufferId)).toBe(1);
    expect(tf.followThreadIfAbsent(userId, t.bufferId, t.root)).toBe(false);

    const quiet = thread(10);
    tf.followThread(userId, quiet.bufferId, quiet.root, quiet.replyId);
    tf.closeThread(userId, quiet.bufferId, quiet.root);
    listed();
    expect(rowCount(quiet.bufferId)).toBe(0);
  });

  it('keeps the row of a thread the user named, though it’s quiet and read', () => {
    const t = thread(10);
    tf.renameThread(userId, t.bufferId, t.root, 'the plan');
    tf.markThreadRead(userId, t.bufferId, t.root, t.replyId);
    expect(listed()).not.toContain(t.root); // quiet: off the list…
    expect(rowCount(t.bufferId)).toBe(1); // …but its name kept for when it's back
  });

  it('forgets a thread retention took', () => {
    const t = thread(1);
    tf.followThread(userId, t.bufferId, t.root, 0);
    db.prepare(`DELETE FROM messages WHERE buffer_id = ?`).run(t.bufferId);
    expect(listed()).not.toContain(t.root);
    expect(rowCount(t.bufferId)).toBe(0);
  });

  it('never quotes a first line from someone ignored when it arrived', () => {
    const target = `#t${seq++}`;
    const time = new Date(NOW - DAY).toISOString();
    const put = (extra: Record<string, unknown>) =>
      insertMessage({
        networkId,
        target,
        time,
        type: 'message',
        nick: 'troll',
        text: 'bait',
        ...extra,
      });
    const { bufferId } = put({ msgid: 'ign-root', fromIgnored: true });
    put({ nick: 'me', self: true, replyMsgid: 'ign-root', replyRootMsgid: 'ign-root' });
    tf.followThread(userId, bufferId, 'ign-root', 0);
    expect(
      tf.listFollowedThreads(userId, NOW).find((t) => t.rootMsgid === 'ign-root')?.root,
    ).toBeNull();
  });

  it('lists a thread in a closed buffer: the client decides what to show', () => {
    const t = thread(1);
    tf.followThread(userId, t.bufferId, t.root, 0);
    db.prepare(`UPDATE buffers SET state = 'closed' WHERE id = ?`).run(t.bufferId);
    expect(listed()).toContain(t.root);
  });
});
