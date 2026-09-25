// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The reactions table's own rules: what rides a message row, what dies with
// it, and which lines a user may send a reaction to. The IRC side (parsing,
// routing, the echo) is ircReactions.test.ts.

// MUST be first: redirects DATABASE_PATH before anything opens the db.
import '../test-utils/isolateDb.js';
import { describe, it, expect, beforeAll } from 'vitest';
import db from './index.js';
import { createUser } from './users.js';
import { createNetwork } from './networks.js';
import type { Network } from './networks.js';
import { insertMessage, listMessages } from './messages.js';
import { addReaction, reactionSendTarget, removeReaction } from './reactions.js';

let userId: number;
let otherId: number;
let net: Network;
let seq = 0;

beforeAll(() => {
  userId = createUser('reactions-db').id;
  otherId = createUser('reactions-db-other').id;
  net = createNetwork(userId, { name: 'rdb', host: 'h', port: 6697, tls: true, nick: 'me' })!;
});

function line(fields: Partial<Parameters<typeof insertMessage>[0]> = {}): number {
  return Number(
    insertMessage({
      networkId: net.id,
      target: '#rdb',
      time: new Date().toISOString(),
      type: 'message',
      nick: 'bob',
      text: `line ${++seq}`,
      msgid: `db${seq}`,
      ...fields,
    }).id,
  );
}

function react(messageId: number, nick: string, value: string, self = false): boolean {
  return addReaction({
    messageId,
    networkId: net.id,
    nick,
    value,
    self,
    toSelf: false,
    time: new Date().toISOString(),
  });
}

const rowById = (id: number, target = '#rdb') =>
  listMessages(net.id, target).find((m) => m.id === id);

describe('reactions on message rows', () => {
  it('ride the row oldest first, and are absent — not [] — when there are none', () => {
    const bare = line();
    const busy = line();
    react(busy, 'carol', '🎉');
    react(busy, 'me', '👍', true);
    expect(rowById(bare)!.reactions).toBeUndefined();
    expect('reactions' in rowById(bare)!).toBe(false);
    expect(rowById(busy)!.reactions).toEqual([
      { nick: 'carol', value: '🎉', self: false },
      { nick: 'me', value: '👍', self: true },
    ]);
  });

  it('come only from the table, never from a line’s stored extras', () => {
    // `extra` is built from what a network sent; a `reactions` key in it must
    // not surface as reactions nobody gave.
    const forged = line({ extra: { reactions: [{ nick: 'x', value: 'forged', self: true }] } });
    expect(rowById(forged)!.reactions).toBeUndefined();
    react(forged, 'dave', 'real');
    expect(rowById(forged)!.reactions).toEqual([{ nick: 'dave', value: 'real', self: false }]);
  });

  it('say whether anything changed, so repeats publish nothing', () => {
    const id = line();
    expect(react(id, 'bob', '👍')).toBe(true);
    expect(react(id, 'BOB', '👍')).toBe(false);
    expect(removeReaction(id, 'erin', '👍')).toBe(false);
    expect(removeReaction(id, 'Bob', '👍')).toBe(true);
    expect(removeReaction(id, 'bob', '👍')).toBe(false);
  });

  it('are deleted with their line', () => {
    const id = line();
    react(id, 'bob', '👍');
    db.prepare('DELETE FROM messages WHERE id = ?').run(id);
    const left = db
      .prepare('SELECT COUNT(*) AS n FROM message_reactions WHERE message_id = ?')
      .get(id) as { n: number };
    expect(left.n).toBe(0);
  });
});

describe('reactionSendTarget', () => {
  it('answers with the network, the buffer’s name and the line’s msgid', () => {
    const id = line({ msgid: 'send-me' });
    expect(reactionSendTarget(userId, id)).toEqual({
      networkId: net.id,
      target: '#rdb',
      msgid: 'send-me',
    });
  });

  it('refuses another user’s line', () => {
    expect(reactionSendTarget(otherId, line())).toBeNull();
  });

  it('refuses a line with no msgid, a non-chat line, and an encrypted one', () => {
    expect(reactionSendTarget(userId, line({ msgid: undefined }))).toBeNull();
    expect(reactionSendTarget(userId, line({ type: 'join', text: null }))).toBeNull();
    // A cleartext reaction on an E2E line would say what the line was about.
    expect(reactionSendTarget(userId, line({ extra: { e2e: true } }))).toBeNull();
  });
});
