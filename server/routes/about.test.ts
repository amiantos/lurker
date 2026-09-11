// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// GET /api/about — what Settings → About says about the IRC engine. Everything
// but "there is none" is read off the live link, so these run against a real
// engine on an ephemeral port rather than a stubbed link.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { Express } from 'express';
import {
  setupTestDb,
  createTestApp,
  createAuthedAgent,
  createAnonAgent,
} from '../test-utils/testApp.js';
import type { LurkerTestAgent } from '../test-utils/testApp.js';
import { setEnv, setEnvAll } from '../test-utils/env.js';
import { until } from '../test-utils/until.js';

const ctx = setupTestDb('routes-about');

const SECRET = 'about-engine-secret';

let app: Express;
let agent: LurkerTestAgent;
let EngineLink: typeof import('../services/engineLink.js').EngineLink;
let EngineServer: typeof import('../engine/server.js').EngineServer;

// Undone after each test, last first: the link stops before the env it read is
// put back, and before the engine it was talking to goes away.
const undo: Array<() => unknown> = [];

beforeAll(async () => {
  const { createUser } = await import('../db/users.js');
  ({ EngineLink } = await import('../services/engineLink.js'));
  ({ EngineServer } = await import('../engine/server.js'));
  const router = (await import('./about.js')).default;
  app = createTestApp({ '/api/about': router });
  agent = await createAuthedAgent(app, createUser('about-alice').id);
});

afterEach(async () => {
  for (let fn = undo.pop(); fn; fn = undo.pop()) await fn();
});

afterAll(() => ctx.cleanup());

async function startEngine(version: string) {
  const engine = new EngineServer({
    secret: SECRET,
    bufferBytes: 64 * 1024,
    bufferTotalBytes: 1024 * 1024,
    version,
    log: () => {},
  });
  const { port } = await engine.listen(0, '127.0.0.1');
  undo.push(() => engine.shutdown('test done', 500));
  return { engine, port };
}

// Switch this process into engine mode against `port` and start the link, as
// server.ts does at boot.
async function linkTo(port: number, secret = SECRET) {
  undo.push(
    setEnvAll({
      LURKER_ENGINE_URL: `tcp://127.0.0.1:${port}`,
      LURKER_ENGINE_SECRET: secret,
      LURKER_ENGINE_RETRY_BASE_MS: '100',
      LURKER_ENGINE_HEARTBEAT_MS: '600000',
    }),
  );
  await EngineLink.resetForTests();
  undo.push(() => EngineLink.resetForTests());
  const link = EngineLink.shared();
  link.start();
  return link;
}

async function about() {
  const res = await agent.get('/api/about');
  expect(res.status).toBe(200);
  return res.body as { engine: { connected: boolean; version: string | null } | null };
}

describe('GET /api/about', () => {
  it('requires a session', async () => {
    expect((await createAnonAgent(app).get('/api/about')).status).toBe(401);
  });

  it('reports no engine when this process dials IRC itself', async () => {
    undo.push(setEnv('LURKER_ENGINE_URL', ''));
    expect(await about()).toEqual({ engine: null });
  });

  it("reports the engine's own version once it has said hello", async () => {
    const { port } = await startEngine('1.2.3');
    const link = await linkTo(port);
    await until(() => link.state === 'ready', 3000, 'link ready');
    expect(await about()).toEqual({ engine: { connected: true, version: '1.2.3' } });
  });

  // The version outlives the link — it is what the last hello said — so
  // `connected` has to come from the link's state, not from having a version.
  it('reports the engine not connected once the link drops', async () => {
    const { engine, port } = await startEngine('1.2.3');
    const link = await linkTo(port);
    await until(() => link.state === 'ready', 3000, 'link ready');
    await engine.shutdown('going away', 500);
    await until(() => link.state !== 'ready', 3000, 'link dropped');
    expect(await about()).toEqual({ engine: { connected: false, version: '1.2.3' } });
  });

  // A refusal turns engine mode off for the run and the app dials IRC itself,
  // so no engine is in use, whatever LURKER_ENGINE_URL says.
  it('reports no engine when the engine refused this app', async () => {
    const { port } = await startEngine('1.2.3');
    const link = await linkTo(port, 'the-wrong-secret');
    await until(() => link.state === 'refused', 3000, 'link refused');
    expect(await about()).toEqual({ engine: null });
  });
});
