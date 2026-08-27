// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The rig an engine-mode test runs on: a fake ircd, an engine holding sockets
// to it, this process switched into engine mode against that engine, and a
// log of the wire between them. Importers must load '../test-utils/isolateDb.js'
// first, as with any test that touches ircManager.

import { EngineServer } from '../engine/server.js';
import { EngineLink, engineConfigured } from '../services/engineLink.js';
import ircManager from '../services/ircManager.js';
import type { IrcConnection } from '../services/ircConnection.js';
import { FakeIrcd } from './fakeIrcd.js';
import { until } from './until.js';

// One line on the wire, tagged with the connection's nick. '<' is stamped as
// the fake ircd sends it — before the relay hop, so a reply is always logged
// ahead of the request it releases — and '>' as the Client writes it, the
// same synchronous chain that arms a restore step's deadline, so timing
// assertions read one clock. (Recording both at the Client would log them the
// other way round: Lurker's own 'raw' handler runs first and writes the next
// request inside it.)
export interface WireLine {
  t: number;
  dir: '>' | '<';
  nick: string;
  line: string;
}

export interface EngineHarness {
  ircd: FakeIrcd;
  engine: EngineServer;
  // Every line the ircd wrote, from the start, plus every line a tapped
  // connection's Client wrote. A test that only cares about its second
  // session clears it (`wire.length = 0`) once the first has let go.
  wire: WireLine[];
  // Record what this connection's Client writes, as `nick`.
  tap(conn: IrcConnection, nick: string): void;
  wireTail(): string;
  // until() with the wire tail as the timeout's detail.
  until(pred: () => boolean, ms: number, what: string): Promise<void>;
  // Detach every connection, stop the engine and the ircd, and delete every
  // env var start set — so a knob one test file sets cannot leak into the
  // next file of a full-suite run.
  stop(): Promise<void>;
}

export async function startEngineHarness(opts: {
  secret: string;
  // Per-test knobs (LURKER_RESTORE_*, …), set alongside the engine ones.
  env?: Record<string, string>;
}): Promise<EngineHarness> {
  const ircd = await FakeIrcd.start();
  const wire: WireLine[] = [];
  ircd.on('sent', (line: string, c: { nick: string | null }) =>
    wire.push({ t: Date.now(), dir: '<', nick: c.nick ?? '?', line }),
  );
  const engine = new EngineServer({
    secret: opts.secret,
    bufferBytes: 64 * 1024,
    bufferTotalBytes: 1024 * 1024,
    version: 'test',
    log: () => {},
  });
  const { port } = await engine.listen(0, '127.0.0.1');
  const env: Record<string, string> = {
    LURKER_ENGINE_URL: `tcp://127.0.0.1:${port}`,
    LURKER_ENGINE_SECRET: opts.secret,
    LURKER_ENGINE_RETRY_BASE_MS: '100',
    // A full-suite CI run starves the event loop; keep the link's heartbeat
    // well clear of the run so it can't drop a healthy idle link mid-test.
    LURKER_ENGINE_HEARTBEAT_MS: '600000',
    ...opts.env,
  };
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  EngineLink.resetForTests();
  if (!engineConfigured()) throw new Error('engine mode did not switch on');
  const wireTail = () =>
    'last wire lines:\n' +
    wire
      .slice(-60)
      .map((w) => `${w.dir} [${w.nick}] ${w.line}`)
      .join('\n');
  return {
    ircd,
    engine,
    wire,
    tap(conn, nick) {
      conn.client.on('raw', (ev: { line: string; from_server: boolean }) => {
        if (!ev.from_server) wire.push({ t: Date.now(), dir: '>', nick, line: ev.line });
      });
    },
    wireTail,
    until: (pred, ms, what) => until(pred, ms, what, wireTail),
    async stop() {
      ircManager.shutdown();
      EngineLink.resetForTests();
      await engine.shutdown('tests done', 500);
      await ircd.close();
      for (const k of Object.keys(env)) delete process.env[k];
    },
  };
}
