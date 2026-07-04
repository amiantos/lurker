// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { loadOrCreateSelfSignedCert, certFingerprint, keyMatchesCert } from './bouncerCert.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-bnccert-'));
afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('loadOrCreateSelfSignedCert', () => {
  it('generates and persists a usable cert on first call, reuses it after', async () => {
    const dataDir = path.join(tmpDir, 'a');
    const first = await loadOrCreateSelfSignedCert({ dataDir });
    expect(first.created).toBe(true);
    expect(fs.existsSync(first.certPath)).toBe(true);
    expect(fs.existsSync(first.keyPath)).toBe(true);

    // The PEM parses as a real X.509 cert with a >5-year validity.
    const cert = new crypto.X509Certificate(fs.readFileSync(first.certPath));
    const years =
      (new Date(cert.validTo).getTime() - new Date(cert.validFrom).getTime()) /
      (365 * 24 * 3600 * 1000);
    expect(years).toBeGreaterThan(5);

    // A second call reuses the persisted pair (same paths, not regenerated).
    const second = await loadOrCreateSelfSignedCert({ dataDir });
    expect(second.created).toBe(false);
    expect(second.certPath).toBe(first.certPath);
    expect(fs.readFileSync(first.certPath, 'utf8')).toBe(fs.readFileSync(second.certPath, 'utf8'));
  });

  it('writes the private key with owner-only permissions', async () => {
    const dataDir = path.join(tmpDir, 'b');
    const { keyPath } = await loadOrCreateSelfSignedCert({ dataDir });
    // 0600 — group/other bits must be clear.
    expect(fs.statSync(keyPath).mode & 0o077).toBe(0);
  });
});

describe('keyMatchesCert', () => {
  it('accepts a matching pair and rejects a mismatched one', async () => {
    const a = await loadOrCreateSelfSignedCert({ dataDir: path.join(tmpDir, 'm1') });
    const b = await loadOrCreateSelfSignedCert({ dataDir: path.join(tmpDir, 'm2') });
    const certA = fs.readFileSync(a.certPath);
    const keyA = fs.readFileSync(a.keyPath);
    const keyB = fs.readFileSync(b.keyPath);
    expect(keyMatchesCert(certA, keyA)).toBe(true);
    expect(keyMatchesCert(certA, keyB)).toBe(false); // A's cert, B's key
    expect(keyMatchesCert(certA, 'not a key')).toBe(false); // garbage → false, no throw
  });

  it('regenerates a persisted pair that has become mismatched', async () => {
    const dataDir = path.join(tmpDir, 'heal');
    const first = await loadOrCreateSelfSignedCert({ dataDir });
    // Corrupt the on-disk pair (drop in a foreign key), then reload.
    const foreign = await loadOrCreateSelfSignedCert({ dataDir: path.join(tmpDir, 'foreign') });
    fs.copyFileSync(foreign.keyPath, first.keyPath);
    const healed = await loadOrCreateSelfSignedCert({ dataDir });
    expect(healed.created).toBe(true); // detected the mismatch and regenerated
    expect(keyMatchesCert(fs.readFileSync(healed.certPath), fs.readFileSync(healed.keyPath))).toBe(
      true,
    );
  });
});

describe('certFingerprint', () => {
  it('returns the SHA-256 fingerprint as uppercase colon-hex', async () => {
    const { certPath } = await loadOrCreateSelfSignedCert({ dataDir: path.join(tmpDir, 'c') });
    const fp = certFingerprint(fs.readFileSync(certPath));
    expect(fp).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  });
});
