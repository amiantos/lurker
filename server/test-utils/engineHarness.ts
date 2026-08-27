// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The rig an engine-restore test runs on: a fake ircd, an engine holding
// sockets to it, and this process switched into engine mode against that
// engine. Importers must load '../test-utils/isolateDb.js' first, as with any
// test that touches ircManager.

import { EngineServer } from '../engine/server.js';
import { EngineLink, engineConfigured } from '../services/engineLink.js';
import ircManager from '../services/ircManager.js';
import { FakeIrcd } from './fakeIrcd.js';

export interface EngineHarness {
  ircd: FakeIrcd;
  engine: EngineServer;
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
  return {
    ircd,
    engine,
    async stop() {
      ircManager.shutdown();
      EngineLink.resetForTests();
      await engine.shutdown('tests done', 500);
      await ircd.close();
      for (const k of Object.keys(env)) delete process.env[k];
    },
  };
}
