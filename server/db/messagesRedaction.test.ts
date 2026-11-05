// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Message redaction at the store (#1013): what one REDACT does to the row, its
// mirror, its reactions and the readers that copy its words.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let createUser: typeof import('./users.js').createUser;
let createNetwork: typeof import('./networks.js').createNetwork;
let messages: typeof import('./messages.js');
let reactions: typeof import('./reactions.js');

beforeAll(async () => {
  ({ createUser } = await import('./users.js'));
  ({ createNetwork } = await import('./networks.js'));
  messages = await import('./messages.js');
  reactions = await import('./reactions.js');
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const T = '2026-11-05T00:00:00.000Z';
let seq = 0;

function seed() {
  seq += 1;
  const user = createUser(`redact-db-${seq}`);
  const network = createNetwork(user.id, {
    name: `n${seq}`,
    host: 'h',
    port: 6697,
    tls: true,
    nick: 'me',
  })!;
  return { user, network };
}

function say(
  networkId: number,
  target: string,
  nick: string,
  text: string,
  extra: Record<string, unknown> = {},
) {
  const res = messages.insertMessage({
    networkId,
    target,
    time: T,
    type: 'message',
    nick,
    text,
    self: nick === 'me',
    msgid: `m${++seq}`,
    ...extra,
  } as Parameters<typeof messages.insertMessage>[0]);
  return { id: Number(res.id), bufferId: res.bufferId!, msgid: `m${seq}` };
}

function row(networkId: number, target: string, id: number) {
  return messages.listMessages(networkId, target, { limit: 100 }).find((m) => m.id === id)!;
}

describe('redactMessage', () => {
  it('blanks the server-buffer mirror of a notice to a closed DM along with the line', () => {
    const { network } = seed();
    // The home row (a notice from bob, with its msgid) and the mirror the
    // closed-buffer path stores in the server buffer: same words, nick and
    // time, no msgid, mirrored.
    const home = messages.insertMessage({
      networkId: network.id,
      target: 'bob',
      time: T,
      type: 'notice',
      nick: 'bob',
      text: 'psst',
      self: false,
      msgid: 'n1',
    });
    const mirror = messages.insertMessage({
      networkId: network.id,
      target: `:server:${network.id}`,
      time: T,
      type: 'notice',
      nick: 'bob',
      text: 'psst',
      self: false,
      mirrored: true,
    });
    const out = messages.redactMessage({
      networkId: network.id,
      bufferId: home.bufferId!,
      msgid: 'n1',
      by: 'bob',
      time: T,
    });
    expect(out).toMatchObject({ id: Number(home.id), mirrors: [{ id: Number(mirror.id) }] });
    expect(row(network.id, 'bob', Number(home.id)).text).toBeNull();
    const mirrored = row(network.id, `:server:${network.id}`, Number(mirror.id));
    expect(mirrored.text).toBeNull();
    expect(mirrored.redaction).toEqual({ by: 'bob', time: T });
  });

  it('lists the deletions among a set of the user’s lines, and nobody else’s', () => {
    const { user, network } = seed();
    const other = seed();
    const a = say(network.id, '#c', 'bob', 'gone');
    const b = say(network.id, '#c', 'bob', 'stays');
    const theirs = say(other.network.id, '#c', 'bob', 'theirs');
    messages.redactMessage({
      networkId: network.id,
      bufferId: a.bufferId,
      msgid: a.msgid,
      by: 'opal',
      reason: 'why',
      time: T,
    });
    messages.redactMessage({
      networkId: other.network.id,
      bufferId: theirs.bufferId,
      msgid: theirs.msgid,
      by: 'bob',
      time: T,
    });
    const found = messages.redactionsForMessages(user.id, [a.id, b.id, theirs.id]);
    expect([...found.entries()]).toEqual([[a.id, { by: 'opal', reason: 'why', time: T }]]);
  });

  it('takes a deleted line out of reach of reactions, in and out', () => {
    const { user, network } = seed();
    const line = say(network.id, '#c', 'bob', 'react to me');
    expect(reactions.findReactionParent(network.id, line.bufferId, line.msgid)).toMatchObject({
      id: line.id,
    });
    expect(reactions.reactionSendTarget(user.id, line.id)).toMatchObject({ msgid: line.msgid });
    messages.redactMessage({
      networkId: network.id,
      bufferId: line.bufferId,
      msgid: line.msgid,
      by: 'bob',
      time: T,
    });
    expect(reactions.findReactionParent(network.id, line.bufferId, line.msgid)).toBeNull();
    expect(reactions.reactionSendTarget(user.id, line.id)).toBeNull();
  });

  it('marks a deleted thread root as deleted in the buffer’s thread list', () => {
    const { network } = seed();
    const root = say(network.id, '#c', 'bob', 'thread starts here');
    // The connection roots a reply before insert (replyRootFor); here by hand.
    say(network.id, '#c', 'carol', 'bob: and continues', {
      replyMsgid: root.msgid,
      replyRootMsgid: root.msgid,
    });
    expect(messages.listBufferThreads(root.bufferId)[0]?.root).toMatchObject({
      text: 'thread starts here',
    });
    messages.redactMessage({
      networkId: network.id,
      bufferId: root.bufferId,
      msgid: root.msgid,
      by: 'bob',
      time: T,
    });
    expect(messages.listBufferThreads(root.bufferId)[0]?.root).toMatchObject({
      text: '',
      redacted: true,
    });
  });
});
