// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Self-signed TLS certificate for the built-in IRC bouncer. When an operator
// hasn't supplied their own cert (LURKER_BOUNCER_TLS_CERT/KEY), the bouncer
// still speaks TLS by default using a self-signed cert generated on first boot
// and persisted alongside the SQLite DB — the same zero-config, survives-a-
// rebuild pattern as resolveSessionSecret. This is the ZNC convention: the wire
// is encrypted out of the box; for MITM protection the user pins the cert's
// fingerprint (printed at startup) in their IRC client.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { generate as generateSelfSigned } from 'selfsigned';

const CERT_FILE = 'bouncer-cert.pem';
const KEY_FILE = 'bouncer-key.pem';

function defaultDataDir(): string {
  if (process.env.DATABASE_PATH) return path.dirname(process.env.DATABASE_PATH);
  return path.join(import.meta.dirname, '../../data');
}

export interface BouncerCertFiles {
  certPath: string;
  keyPath: string;
  created: boolean;
}

// Load the persisted self-signed bouncer cert, generating + persisting one on
// first use. 10-year validity: self-signed certs aren't renewed — clients pin
// the fingerprint rather than trust a chain, so a long life avoids a surprise
// expiry. Returns the file paths (the caller reads + watches them, sharing the
// hot-reload path with operator-supplied certs).
export async function loadOrCreateSelfSignedCert({
  dataDir = defaultDataDir(),
}: { dataDir?: string } = {}): Promise<BouncerCertFiles> {
  fs.mkdirSync(dataDir, { recursive: true });
  const certPath = path.join(dataDir, CERT_FILE);
  const keyPath = path.join(dataDir, KEY_FILE);
  // Reuse an existing pair only if it's internally consistent — a hand-edited
  // file or an interleaved concurrent first-boot could leave a cert that doesn't
  // match the key, which would fail every handshake; regenerate a fresh pair.
  if (
    fs.existsSync(certPath) &&
    fs.existsSync(keyPath) &&
    keyMatchesCert(fs.readFileSync(certPath), fs.readFileSync(keyPath))
  ) {
    return { certPath, keyPath, created: false };
  }
  const notBeforeDate = new Date();
  const notAfterDate = new Date(notBeforeDate.getTime() + 3650 * 24 * 60 * 60 * 1000);
  const pems = await generateSelfSigned([{ name: 'commonName', value: 'Lurker IRC Bouncer' }], {
    notBeforeDate,
    notAfterDate,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      {
        name: 'subjectAltName',
        altNames: [
          { type: 2, value: 'localhost' },
          { type: 7, ip: '127.0.0.1' },
          { type: 7, ip: '::1' },
        ],
      },
    ],
  });
  // Key first (0600) and cert (0644) — never leave a half-written pair readable.
  fs.writeFileSync(keyPath, pems.private, { mode: 0o600 });
  fs.writeFileSync(certPath, pems.cert, { mode: 0o644 });
  return { certPath, keyPath, created: true };
}

// SHA-256 fingerprint of a PEM cert as uppercase colon-hex ("AB:CD:…") — the
// exact form IRC clients show for pinning/verification.
export function certFingerprint(certPem: string | Buffer): string {
  return new crypto.X509Certificate(certPem).fingerprint256;
}

// Does this private key correspond to this certificate? Node's setSecureContext
// does NOT check, so a mismatched {cert, key} (e.g. a renewal that wrote the
// cert file a moment before the key) would install silently and break every
// handshake — callers verify with this before installing.
export function keyMatchesCert(certPem: string | Buffer, keyPem: string | Buffer): boolean {
  try {
    return new crypto.X509Certificate(certPem).checkPrivateKey(crypto.createPrivateKey(keyPem));
  } catch {
    return false;
  }
}
