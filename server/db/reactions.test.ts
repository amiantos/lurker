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
import {
  addReaction,
  listReactionsToUser,
  reactionSendTarget,
  reactionsForMessages,
  removeReaction,
} from './reactions.js';
import { refoldNetworkBuffers } from './refoldBuffers.js';

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

  // Not IRC targets, or not ours to answer in public — see reactionSendTarget.
  it('refuses a notice, a server-console line, and a DCC chat line', () => {
    expect(reactionSendTarget(userId, line({ type: 'notice' }))).toBeNull();
    expect(reactionSendTarget(userId, line({ target: `:server:${net.id}` }))).toBeNull();
    expect(reactionSendTarget(userId, line({ target: '=bob' }))).toBeNull();
    // …while a /me in a DM is fine.
    expect(reactionSendTarget(userId, line({ type: 'action', target: 'bob' }))).not.toBeNull();
  });

  it('refuses a line with no msgid, a non-chat line, and an encrypted one', () => {
    expect(reactionSendTarget(userId, line({ msgid: undefined }))).toBeNull();
    expect(reactionSendTarget(userId, line({ type: 'join', text: null }))).toBeNull();
    // A cleartext reaction on an E2E line would say what the line was about.
    expect(reactionSendTarget(userId, line({ extra: { e2e: true } }))).toBeNull();
  });
});

describe('listReactionsToUser', () => {
  // `in:` folds per network, like the highlights tab: on rfc1459, `{` is `[`.
  it('matches in: through the network’s casemapping', () => {
    const rfc = createNetwork(userId, {
      name: 'rfc',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'me',
    })!;
    refoldNetworkBuffers(userId, rfc.id, 'rfc1459');
    const mine = Number(
      insertMessage({
        networkId: rfc.id,
        target: '#Chat[Dev]',
        time: new Date().toISOString(),
        type: 'message',
        nick: 'me',
        text: 'mine',
        self: true,
        msgid: 'rfc1',
      }).id,
    );
    addReaction({
      messageId: mine,
      networkId: rfc.id,
      nick: 'bob',
      value: '👍',
      self: false,
      toSelf: true,
      time: new Date().toISOString(),
    });
    expect(listReactionsToUser(userId, { target: '#chat{dev}' }).map((r) => r.id)).toEqual([mine]);
    expect(listReactionsToUser(userId, { target: '#elsewhere' })).toEqual([]);
  });
});

describe('reactionsForMessages', () => {
  // A resumed client re-reads the reactions on lines it holds: every id it has
  // gets its current list, and nothing from anyone else's account comes back.
  it('returns what stands on the user’s lines, and nothing on another user’s', () => {
    const a = line();
    const b = line();
    const bare = line();
    react(a, 'bob', '👍');
    react(a, 'carol', 'lol');
    react(b, 'dave', '🎉');

    const other = createNetwork(otherId, {
      name: 'o',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'o',
    })!;
    const theirs = Number(
      insertMessage({
        networkId: other.id,
        target: '#o',
        time: new Date().toISOString(),
        type: 'message',
        nick: 'x',
        text: 'theirs',
        msgid: 'o1',
      }).id,
    );
    addReaction({
      messageId: theirs,
      networkId: other.id,
      nick: 'x',
      value: '🙈',
      self: false,
      toSelf: false,
      time: new Date().toISOString(),
    });

    const found = reactionsForMessages(userId, [a, b, bare, theirs]);
    expect(found.get(a)).toEqual([
      { nick: 'bob', value: '👍', self: false },
      { nick: 'carol', value: 'lol', self: false },
    ]);
    expect(found.get(b)).toEqual([{ nick: 'dave', value: '🎉', self: false }]);
    expect(found.has(bare)).toBe(false);
    expect(found.has(theirs)).toBe(false);
  });
});
