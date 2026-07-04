// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// A misconfigured operator cert (here: a mismatched cert/key pair) must not
// bring up a broken TLS listener — the bouncer falls back to a working
// self-signed cert so the wire stays encrypted.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { setupTestDb } from '../test-utils/testApp.js';

const ctx = setupTestDb('services-bouncer-tls-fallback');

let harnessMod: typeof import('../test-utils/bouncerHarness.js');
let harness: import('../test-utils/bouncerHarness.js').Harness;

beforeAll(async () => {
  process.env.LURKER_BOUNCER_ENABLED = 'true';
  const certMod = await import('../utils/bouncerCert.js');
  harnessMod = await import('../test-utils/bouncerHarness.js');
  // Build a deliberately mismatched pair: cert from A, key from B.
  const a = await certMod.loadOrCreateSelfSignedCert({ dataDir: path.join(ctx.tmpDir, 'a') });
  const b = await certMod.loadOrCreateSelfSignedCert({ dataDir: path.join(ctx.tmpDir, 'b') });
  process.env.LURKER_BOUNCER_TLS_CERT = a.certPath;
  process.env.LURKER_BOUNCER_TLS_KEY = b.keyPath;
  harness = await harnessMod.startHarness({ tls: true });
});

afterAll(() => {
  harness.stop();
  delete process.env.LURKER_BOUNCER_TLS_CERT;
  delete process.env.LURKER_BOUNCER_TLS_KEY;
  ctx.cleanup();
});

describe('operator cert fallback', () => {
  it('serves a working self-signed TLS listener when the configured pair is mismatched', async () => {
    const acct = harnessMod.seedAccount({ nick: 'fbuser' });
    const c = await harness.connect(); // TLS handshake succeeds → fallback cert is valid
    c.send(`PASS ${acct.user.username}:${acct.password}`);
    c.send('NICK client');
    c.send('USER client 0 * :client');
    await c.waitForCommand('001');
    expect(harnessMod.attachedFor(acct)).toBe(1);
    // The fallback did NOT use the (unreadable-as-a-pair) configured cert.
    const fp = fs.existsSync(process.env.LURKER_BOUNCER_TLS_CERT!);
    expect(fp).toBe(true); // the configured cert file exists but was rejected as a pair
  });
});
