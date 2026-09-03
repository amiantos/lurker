// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// CertFP cert handling (#459). The generated pair is checked against a REAL TLS
// handshake rather than against its own PEM: the whole feature rests on a server
// seeing the fingerprint we told the user to register, so the assertion that
// matters is that an ircd's `getPeerCertificate()` agrees with
// describeClientCert() — down to the format services want it pasted in.

import { describe, it, expect } from 'vitest';
import net from 'node:net';
import tls from 'node:tls';
import { once } from 'node:events';
import { generate as generateSelfSigned } from 'selfsigned';
import {
  generateClientCert,
  describeClientCert,
  validateClientCertPair,
  isClientCertProblem,
  clientCertBundle,
} from './clientCert.js';

describe('generateClientCert', () => {
  it('mints a usable pair whose fingerprint is what the peer sees', async () => {
    const pair = await generateClientCert('alice');
    const info = describeClientCert(pair.cert);

    const server = await startCertRequestingServer();
    try {
      const seen = await presentCert(server.port, pair);
      // Node hands both sides the same digest in different dress: colon-hex
      // uppercase from the socket, bare lowercase from describeClientCert —
      // which is the form `/msg NickServ CERT ADD` takes.
      expect(seen.replace(/:/g, '').toLowerCase()).toBe(info.sha256);
    } finally {
      server.close();
    }
  });

  it('describes the cert in the form services want pasted', async () => {
    const info = describeClientCert((await generateClientCert('alice')).cert);
    expect(info.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(info.sha1).toMatch(/^[0-9a-f]{40}$/);
    // 128 characters, which is what Libera checks for by length before it will
    // even look at the value.
    expect(info.sha512).toMatch(/^[0-9a-f]{128}$/);
    expect(info.subject).toContain('alice');
  });

  it('outlives any registration the user makes at NickServ', async () => {
    const info = describeClientCert((await generateClientCert('alice')).cert);
    const years = (Date.parse(info.validTo) - Date.parse(info.validFrom)) / (365.25 * 864e5);
    expect(years).toBeGreaterThan(9);
  });

  it('falls back to a name when the network has no nick to borrow', async () => {
    expect(describeClientCert((await generateClientCert('')).cert).subject).toContain('lurker');
  });

  // A nick is free-form and reaches this as the CN. The DN grammar treats `,`
  // and `=` as structure, so an unescaped one either rewrites the name into
  // extra RDNs or throws out of the encoder — which surfaces as a 500 on a nick
  // the network itself was happy with.
  it('does not let a nick rewrite the distinguished name', async () => {
    const info = describeClientCert((await generateClientCert('O=evil,CN=admin')).cert);
    expect(info.subject).toBe('CN=O evil CN admin');
  });

  it('generates rather than throwing for a nick the DN encoder chokes on', async () => {
    // `a,b=c` throws "Cannot get OID for name type" straight out of the encoder.
    const info = describeClientCert((await generateClientCert('a,b=c')).cert);
    expect(info.subject).toBe('CN=a b c');
  });

  it('falls back when a nick is nothing but separators', async () => {
    expect(describeClientCert((await generateClientCert(',,==')).cert).subject).toContain('lurker');
  });

  // The DN parser reads a leading '#' as "hex-encoded DER follows", so a
  // channel-shaped nick threw out of the encoder rather than naming anything.
  it('survives a nick that starts like a channel', async () => {
    expect(describeClientCert((await generateClientCert('#chat')).cert).subject).toBe('CN=chat');
    expect(describeClientCert((await generateClientCert('#')).cert).subject).toBe('CN=lurker');
  });

  it('keeps a # that is not leading', async () => {
    expect(describeClientCert((await generateClientCert('a#b')).cert).subject).toBe('CN=a#b');
  });

  it('mints a distinct key each time', async () => {
    const [a, b] = await Promise.all([generateClientCert('a'), generateClientCert('b')]);
    expect(describeClientCert(a.cert).sha256).not.toBe(describeClientCert(b.cert).sha256);
  });
});

describe('validateClientCertPair', () => {
  it('accepts a matching pair and trims the surrounding whitespace a paste carries', async () => {
    const pair = await generateClientCert('alice');
    const result = validateClientCertPair(`\n  ${pair.cert}\n\n`, `\n${pair.key}  \n`);
    expect(isClientCertProblem(result)).toBe(false);
    expect((result as typeof pair).cert).toBe(pair.cert.trim());
  });

  it('rejects a key that belongs to another certificate', async () => {
    const [mine, theirs] = await Promise.all([
      generateClientCert('alice'),
      generateClientCert('mallory'),
    ]);
    const result = validateClientCertPair(mine.cert, theirs.key);
    expect(isClientCertProblem(result) && result.error).toMatch(/doesn't match/);
  });

  it('names the mistake when the two fields are swapped', async () => {
    const pair = await generateClientCert('alice');
    const result = validateClientCertPair(pair.key, pair.key);
    expect(isClientCertProblem(result) && result.error).toMatch(/looks like a private key/);
  });

  it('tells a passphrase-protected key apart from a broken one', () => {
    const result = validateClientCertPair(
      '-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----',
      '-----BEGIN ENCRYPTED PRIVATE KEY-----\nx\n-----END ENCRYPTED PRIVATE KEY-----',
    );
    expect(isClientCertProblem(result) && result.error).toMatch(/openssl rsa/);
  });

  // The file HexChat and WeeChat keep on disk, and the file this module exports.
  // Pasted whole into the certificate box, it is not really a mistake.
  it('accepts a combined client.pem in the certificate field alone', async () => {
    const pair = await generateClientCert('alice');
    const result = validateClientCertPair(clientCertBundle(pair), '');
    expect(isClientCertProblem(result)).toBe(false);
    expect(describeClientCert((result as typeof pair).cert).sha256).toBe(
      describeClientCert(pair.cert).sha256,
    );
    // And the key that came out of it really is the matching half.
    expect(
      isClientCertProblem(
        validateClientCertPair((result as typeof pair).cert, (result as typeof pair).key),
      ),
    ).toBe(false);
  });

  it('still asks for the certificate when only a key was pasted', async () => {
    const pair = await generateClientCert('alice');
    const result = validateClientCertPair(pair.key, '');
    expect(isClientCertProblem(result) && result.error).toMatch(/no certificate in it/);
  });

  it('rejects an empty, absent, or non-string field', async () => {
    const pair = await generateClientCert('alice');
    for (const bad of ['', '   ', undefined, null, 42, { cert: 'x' }]) {
      expect(isClientCertProblem(validateClientCertPair(bad, pair.key))).toBe(true);
      expect(isClientCertProblem(validateClientCertPair(pair.cert, bad))).toBe(true);
    }
  });

  it('rejects PEM-shaped garbage without throwing', async () => {
    const pair = await generateClientCert('alice');
    const result = validateClientCertPair(
      '-----BEGIN CERTIFICATE-----\nnot base64 at all\n-----END CERTIFICATE-----',
      pair.key,
    );
    expect(isClientCertProblem(result) && result.error).toMatch(/could not be parsed/);
  });
});

describe('clientCertBundle', () => {
  it('emits the key-then-cert single file other clients keep on disk', async () => {
    const pair = await generateClientCert('alice');
    const bundle = clientCertBundle(pair);
    expect(bundle.indexOf('BEGIN PRIVATE KEY')).toBeLessThan(bundle.indexOf('BEGIN CERTIFICATE'));
    expect(bundle.endsWith('\n')).toBe(true);
    // Round-trips: a bundle split back apart is still a valid pair.
    const [key, cert] = bundle.split(/(?=-----BEGIN CERTIFICATE-----)/);
    expect(isClientCertProblem(validateClientCertPair(cert, key))).toBe(false);
  });
});

// A TLS server that asks for a client cert but accepts anything, which is what
// an ircd doing CertFP does: it hashes what you present rather than verifying a
// chain.
async function startCertRequestingServer(): Promise<{ port: number; close: () => void }> {
  const pems = await generateSelfSigned([{ name: 'commonName', value: 'localhost' }], {
    keySize: 2048,
    algorithm: 'sha256',
  });
  const server = tls.createServer(
    { key: pems.private, cert: pems.cert, requestCert: true, rejectUnauthorized: false },
    (socket) => {
      const peer = socket.getPeerCertificate();
      socket.end(`${peer?.fingerprint256 ?? ''}\n`);
    },
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    port: (server.address() as net.AddressInfo).port,
    close: () => server.close(),
  };
}

async function presentCert(port: number, pair: { cert: string; key: string }): Promise<string> {
  const socket = tls.connect({
    port,
    host: '127.0.0.1',
    rejectUnauthorized: false,
    cert: pair.cert,
    key: pair.key,
  });
  let out = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => (out += chunk));
  await once(socket, 'close');
  return out.trim();
}
