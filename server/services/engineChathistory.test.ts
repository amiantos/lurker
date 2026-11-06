// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The history gap-fill (#1283) with the engine holding the socket. Two holes
// the engine's own buffer does not cover: the network dropped the socket and
// the engine redialed (a fresh registration, a rejoin, the ordinary fill), and
// the app was away longer than the buffer holds (a `gap` in the backlog, the
// fill anchored before the attach and bounded by the drop).

import '../test-utils/isolateDb.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import db from '../db/index.js';
import { createUser } from '../db/users.js';
import { createNetwork } from '../db/networks.js';
import type { Network } from '../db/networks.js';
import ircManager from './ircManager.js';
import { startEngineHarness } from '../test-utils/engineHarness.js';
import type { EngineHarness } from '../test-utils/engineHarness.js';
import { until } from '../test-utils/until.js';
import { engineConnectionId } from './engineLink.js';

let harness: EngineHarness;
let network: Network;
let userId: number;

const texts = (target: string): string[] =>
  (
    db
      .prepare(
        `SELECT m.text FROM messages m JOIN buffers b ON b.id = m.buffer_id
         WHERE b.network_id = ? AND b.target_folded = ? AND m.type = 'message' ORDER BY m.id`,
      )
      .all(network.id, target.toLowerCase()) as Array<{ text: string }>
  ).map((r) => r.text);

const asked = () =>
  (harness.ircd.client('lurk')?.sent ?? []).filter((l) => l.startsWith('CHATHISTORY '));

const tick = () => new Promise((r) => setTimeout(r, 5));

beforeAll(async () => {
  harness = await startEngineHarness({
    secret: 'chathistory-engine',
    ircd: { chathistory: { limit: 100 } },
    // A backlog of a few dozen short lines, so a detach can overflow it.
    bufferBytes: 2048,
    env: { LURKER_RECONNECT_BASE_MS: '50', LURKER_RECONNECT_JITTER_MS: '1' },
  });
  const user = createUser('chathistory-engine');
  userId = user.id;
  network = createNetwork(userId, {
    name: 'chathistory-engine',
    host: '127.0.0.1',
    port: harness.ircd.port,
    tls: 0,
    nick: 'lurk',
    autoconnect: 0,
  })!;
});

afterAll(async () => {
  await harness.stop();
});

describe('the gap-fill through the engine', () => {
  it('after the network drops the socket, the redial’s rejoin fills what was missed', async () => {
    const { ircd } = harness;
    const conn = ircManager.startNetwork(userId, network.id)!;
    await until(() => conn.state === 'connected', 8000, 'connected through the engine');
    ircManager.joinChannel(userId, network.id, '#e');
    await until(() => conn.isChannelJoined('#e'), 5000, 'joined');
    ircd.say('peer', '#e', 'before');
    await until(() => texts('#e').length === 1, 5000, 'stored');

    await tick();
    const registrations = ircd.registrations.length;
    ircd.drop('lurk');
    await until(() => !conn.isChannelJoined('#e'), 8000, 'the drop reached the app');
    ircd.say('peer', '#e', 'while the engine redialed');
    await tick();
    await until(
      () => ircd.registrations.length > registrations && conn.isChannelJoined('#e'),
      20000,
      'registered again and rejoined',
    );
    await until(
      () => texts('#e').length === 2,
      8000,
      'the gap filled',
      () => JSON.stringify({ texts: texts('#e'), asked: asked() }),
    );
    await new Promise((r) => setTimeout(r, 200));
    expect(texts('#e')).toEqual(['before', 'while the engine redialed']);
    expect(asked().filter((l) => l.includes(' #e ')).length).toBeGreaterThanOrEqual(1);
  }, 40000);

  it('a hole in the engine’s backlog is filled from before the attach, and the kept tail is not doubled', async () => {
    const { ircd, engine } = harness;
    const conn = ircManager.getConnection(userId, network.id)!;
    expect(conn.state).toBe('connected');
    const engineId = engineConnectionId(userId, network.id);
    const askedBefore = asked().length;
    ircManager.shutdown();
    await until(() => engine.held().includes(engineId), 5000, 'the engine holds the socket');
    // More than the buffer holds: the oldest go, and the engine records it.
    const lines = Array.from({ length: 80 }, (_, i) => `away line ${String(i).padStart(2, '0')}`);
    for (const text of lines) ircd.say('peer', '#e', text);
    await harness.until(
      () => harness.wire.some((w) => w.dir === '<' && w.line.includes('away line 79')),
      5000,
      'the last line on the wire',
    );
    await until(
      () => (engine.info(engineId)?.bufferedLines ?? 0) < lines.length,
      5000,
      'the backlog shed its oldest',
    );
    await new Promise((r) => setTimeout(r, 100));
    const kept = engine.info(engineId)?.bufferedLines ?? 0;
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(lines.length);

    const again = ircManager.startNetwork(userId, network.id)!;
    await until(() => again.state === 'connected', 8000, 'reattached');
    await until(() => !again.catchingUp, 8000, 'live');
    // The engine said so, and the app wrote it down.
    const gapNotice = db
      .prepare(
        `SELECT 1 FROM messages WHERE network_id = ? AND type = 'notice' AND text LIKE '%could not be kept%' LIMIT 1`,
      )
      .get(network.id);
    expect(gapNotice).toBeTruthy();
    await until(
      () => texts('#e').length === 2 + lines.length,
      10000,
      'the hole filled',
      () => JSON.stringify({ have: texts('#e').length, asked: asked().slice(askedBefore) }),
    );
    await new Promise((r) => setTimeout(r, 300));
    // Every line once. By id the kept tail sits before the hole's lines: the
    // backlog stored it during the catch-up, the fill came after (the order
    // the plan accepts; a client sorts by id, the bouncer serves by time).
    const have = texts('#e');
    expect(have).toHaveLength(2 + lines.length);
    expect([...have].sort()).toEqual(['before', 'while the engine redialed', ...lines].sort());
    expect(have.slice(0, 2)).toEqual(['before', 'while the engine redialed']);
    const gapAsks = asked().slice(askedBefore);
    expect(gapAsks.length).toBeGreaterThanOrEqual(1);
    expect(gapAsks[0]).toMatch(/^CHATHISTORY BETWEEN #e timestamp=\S+ timestamp=\S+ 100$/);
  }, 40000);
});
