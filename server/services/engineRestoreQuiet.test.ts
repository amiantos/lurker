// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// After an engine re-attach, the replies to the restore's own requests stay out
// of the server buffer, and the user's own a moment later don't. The restore
// marks each channel quiet (isRestoreQuiet) for replies to the previous
// process's requests, and its own replies are what retire the mark.

// MUST be first: redirects DATABASE_PATH before anything opens the db.
import '../test-utils/isolateDb.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createUser } from '../db/users.js';
import { createNetwork } from '../db/networks.js';
import ircManager from './ircManager.js';
import { EngineLink } from './engineLink.js';
import { startEngineHarness } from '../test-utils/engineHarness.js';
import type { EngineHarness } from '../test-utils/engineHarness.js';

let harness: EngineHarness;

beforeAll(async () => {
  harness = await startEngineHarness({ secret: 'restore-quiet-secret' });
});

afterAll(async () => {
  await harness.stop();
});

describe("the restore's quiet window", () => {
  it("keeps the restore's TOPIC reply out of the server buffer, but not the user's", async () => {
    const { ircd, until } = harness;
    const user = createUser('restore-quiet');
    const network = createNetwork(user.id, {
      name: 'quiet',
      host: '127.0.0.1',
      port: ircd.port,
      tls: 0,
      nick: 'quiet',
      autoconnect: 0,
    })!;
    const events: Array<Record<string, unknown>> = [];
    const listener = (event: Record<string, unknown>) => {
      if (event.networkId === network.id) events.push(event);
    };
    ircManager.on('event', listener);
    try {
      const conn = ircManager.startNetwork(user.id, network.id)!;
      await until(() => conn.state === 'connected', 5000, 'connected');
      conn.join('#q');
      await until(() => !conn.membersPending('#q'), 5000, 'names heard');

      // What the fake ircd sent this connection, from here on.
      const sent = () =>
        harness.wire.filter((w) => w.dir === '<' && w.nick === 'quiet').map((w) => w.line);
      const before = sent().length;
      EngineLink.shared().simulateLoss();
      await until(
        () =>
          sent()
            .slice(before)
            .some((l) => / 331 quiet #q /.test(l)),
        10000,
        "the restore's TOPIC reply",
      );
      await until(() => conn.state === 'connected' && !conn.catchingUp, 10000, 'live again');

      // Inside the quiet window, the user asks for the topic.
      conn.raw('TOPIC #q');
      const lines = (inChannel: boolean) =>
        events
          .filter((e) => e.type === 'motd' && (e.target === '#q') === inChannel)
          .map((e) => String(e.text))
          .filter((text) => text.includes('#q'));
      const rows = () => lines(false);
      await until(
        () => rows().some((text) => text.includes('No topic')),
        5000,
        "the user's TOPIC reply in the server buffer",
      );
      // That row, and none for the restore's own reply before it.
      expect(rows()).toHaveLength(1);
      // And said once in the channel it was asked about (#1270): the user's
      // reply, never the restore's.
      expect(lines(true)).toEqual(['No topic is set for #q.']);
    } finally {
      ircManager.off('event', listener);
    }
  }, 30000);
});
