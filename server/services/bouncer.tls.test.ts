// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// TLS behaviour of the bouncer: the self-signed default speaks TLS end-to-end,
// and reloadBouncerTls() hot-swaps a renewed cert without a restart.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import tls from 'tls';
import fs from 'fs';
import path from 'path';
import { setupTestDb } from '../test-utils/testApp.js';

const ctx = setupTestDb('services-bouncer-tls');

let harnessMod: typeof import('../test-utils/bouncerHarness.js');
let bouncerMod: typeof import('./bouncer.js');
let certMod: typeof import('../utils/bouncerCert.js');
let harness: import('../test-utils/bouncerHarness.js').Harness;

beforeAll(async () => {
  process.env.LURKER_BOUNCER_ENABLED = 'true';
  harnessMod = await import('../test-utils/bouncerHarness.js');
  bouncerMod = await import('./bouncer.js');
  certMod = await import('../utils/bouncerCert.js');
  harness = await harnessMod.startHarness({ tls: true });
});

afterAll(() => {
  harness.stop();
  delete process.env.LURKER_BOUNCER_TLS;
  ctx.cleanup();
});

describe('self-signed TLS default', () => {
  it('accepts a PASS login over a TLS handshake', async () => {
    const acct = harnessMod.seedAccount({ nick: 'tlsuser' });
    const c = await harness.connect();
    // The handshake already completed (harness awaited secureConnect) against a
    // self-signed cert — the presence of a peer cert proves TLS is live.
    const cert = (c.socket as tls.TLSSocket).getPeerCertificate();
    expect(cert.fingerprint256).toBeTruthy();
    c.send(`PASS ${acct.user.username}:${acct.password}`);
    c.send('NICK client');
    c.send('USER client 0 * :client');
    await c.waitForCommand('001');
    expect(harnessMod.attachedFor(acct)).toBe(1);
  });
});

describe('reloadBouncerTls', () => {
  it('is a no-op when the cert file is unchanged', () => {
    expect(bouncerMod.reloadBouncerTls()).toBe('unchanged');
  });

  it('hot-swaps a renewed cert so new connections get it', async () => {
    const before = (await handshakeFingerprint(harness.port)).toString();

    // Mint a fresh self-signed cert and drop it over the live files (an LE
    // renewal / wildcard rotation looks the same on disk).
    const fresh = await certMod.loadOrCreateSelfSignedCert({
      dataDir: path.join(ctx.tmpDir, 'renewed'),
    });
    const dataDir = path.dirname(ctx.dbPath);
    fs.copyFileSync(fresh.certPath, path.join(dataDir, 'bouncer-cert.pem'));
    fs.copyFileSync(fresh.keyPath, path.join(dataDir, 'bouncer-key.pem'));

    expect(bouncerMod.reloadBouncerTls()).toBe('reloaded');

    const after = (await handshakeFingerprint(harness.port)).toString();
    expect(after).not.toBe(before); // the new connection presents the renewed cert
  });

  it('does NOT install a cert whose key has not landed yet (partial renewal)', async () => {
    const before = await handshakeFingerprint(harness.port);
    const dataDir = path.dirname(ctx.dbPath);
    // Mint a fresh pair but copy ONLY the cert over — the on-disk key still
    // belongs to the current cert, so the pair is momentarily mismatched.
    const fresh = await certMod.loadOrCreateSelfSignedCert({
      dataDir: path.join(ctx.tmpDir, 'partial'),
    });
    fs.copyFileSync(fresh.certPath, path.join(dataDir, 'bouncer-cert.pem'));
    expect(bouncerMod.reloadBouncerTls()).toBe('error');
    expect(await handshakeFingerprint(harness.port)).toBe(before); // kept the working cert

    // Once the matching key lands, the next poll swaps cleanly.
    fs.copyFileSync(fresh.keyPath, path.join(dataDir, 'bouncer-key.pem'));
    expect(bouncerMod.reloadBouncerTls()).toBe('reloaded');
  });
});

// Open a bare TLS connection and return the server cert's SHA-256 fingerprint.
function handshakeFingerprint(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ port, host: '127.0.0.1', rejectUnauthorized: false }, () => {
      const fp = socket.getPeerCertificate().fingerprint256;
      socket.destroy();
      resolve(fp);
    });
    socket.on('error', reject);
  });
}
