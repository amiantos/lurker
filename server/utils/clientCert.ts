// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// CertFP (#459): the TLS client certificate a network presents on its handshake,
// which services then recognise by fingerprint — either passively (NickServ
// CertFP identifies you the moment you connect) or through SASL EXTERNAL.
//
// Certs are self-signed by design. Nothing verifies a chain here: the ircd hashes
// the certificate you present and compares that hash against the list on your
// services account, so the only thing that matters is that the same key comes
// back every time. That is also why generated certs last a decade — there is no
// renewal story for a fingerprint someone has registered by hand, and an expiry
// would silently log them out. Same reasoning as utils/bouncerCert.ts, which
// this module deliberately mirrors rather than merges with: that one is a SERVER
// cert for Lurker's own bouncer listener, with different extensions and its own
// on-disk lifecycle.

import crypto from 'crypto';
import { generate as generateSelfSigned } from 'selfsigned';

/** A cert and the private key that completes its handshake. Never separated. */
export interface ClientCertPair {
  cert: string;
  key: string;
}

/** What the client is told about an attached cert. The private key is not part
 *  of it, and never leaves the server outside the explicit export route. */
export interface ClientCertInfo {
  /** Lowercase hex, no colons — the form you paste into NickServ. */
  sha256: string;
  /** Same, SHA-1. Older ratbox-family networks (Rizon) still hash that way. */
  sha1: string;
  subject: string;
  validFrom: string;
  validTo: string;
}

const TEN_YEARS_MS = 3650 * 24 * 60 * 60 * 1000;

// A distinguished name is a comma-separated list of `type=value` pairs, and the
// generator hands ours to the X.509 encoder verbatim: an unescaped separator in
// a nick doesn't produce a cert with a funny name, it produces a DIFFERENT DN
// ("O=evil,CN=admin" becomes two RDNs) or an outright throw ("a,b=c" → "Cannot
// get OID for name type"), which reaches the user as an unexplained 500 on a
// nick the network itself accepted. Nothing downstream depends on the CN — the
// fingerprint is the identity — so the separators are dropped rather than
// escaped, and a name left with nothing to say falls back to the default.
const DN_SEPARATORS = ',+="<>;\\/';

function safeCommonName(raw: string): string {
  const cleaned = [...(raw || '')]
    .map((ch) => (DN_SEPARATORS.includes(ch) || ch.codePointAt(0)! < 0x20 ? ' ' : ch))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 64);
  return cleaned || 'lurker';
}

/** Mint a self-signed client cert. `commonName` is cosmetic — services key on
 *  the fingerprint — but it is what shows up in the cert list of whatever other
 *  client the user exports this into, so it carries the nick. */
export async function generateClientCert(commonName: string): Promise<ClientCertPair> {
  const notBeforeDate = new Date();
  const notAfterDate = new Date(notBeforeDate.getTime() + TEN_YEARS_MS);
  const pems = await generateSelfSigned(
    [{ name: 'commonName', value: safeCommonName(commonName) }],
    {
      notBeforeDate,
      notAfterDate,
      keySize: 2048,
      algorithm: 'sha256',
      extensions: [
        { name: 'basicConstraints', cA: false },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
        { name: 'extKeyUsage', clientAuth: true },
      ],
    },
  );
  return { cert: pems.cert, key: pems.private };
}

/** Digests and validity for an attached cert. Throws on an unparseable PEM —
 *  callers hold pairs that went through validateClientCertPair. */
export function describeClientCert(certPem: string): ClientCertInfo {
  const x509 = new crypto.X509Certificate(certPem);
  return {
    sha256: bare(x509.fingerprint256),
    sha1: bare(x509.fingerprint),
    subject: x509.subject.replace(/\n/g, ', '),
    validFrom: new Date(x509.validFrom).toISOString(),
    validTo: new Date(x509.validTo).toISOString(),
  };
}

// Node prints fingerprints as uppercase colon-hex ("AB:CD:…"); every services
// package wants them bare and lowercase ("abcd…"), which is also what
// `/msg NickServ CERT LIST` echoes back.
function bare(fingerprint: string): string {
  return fingerprint.replace(/:/g, '').toLowerCase();
}

/** A rejected pair, with a message meant for the person who pasted it. */
export interface ClientCertProblem {
  error: string;
}

/** Parse and pair-check a PEM cert + key. The failure messages matter more than
 *  usual here: the raw OpenSSL errors underneath ("error:1E08010C:DECODER
 *  routines::unsupported") tell a user nothing about which of the two fields
 *  they pasted wrong. */
export function validateClientCertPair(
  certPem: unknown,
  keyPem: unknown,
): ClientCertPair | ClientCertProblem {
  const cert = typeof certPem === 'string' ? certPem.trim() : '';
  const key = typeof keyPem === 'string' ? keyPem.trim() : '';
  if (!cert || !key) {
    return { error: 'a certificate and its private key are both required' };
  }
  // A combined client.pem (cert and key in one file, the HexChat/WeeChat shape)
  // pasted into the cert box alone is the single likeliest mistake, so name it
  // instead of failing on "no key".
  if (!/-----BEGIN CERTIFICATE-----/.test(cert)) {
    return {
      error: /PRIVATE KEY-----/.test(cert)
        ? 'that looks like a private key, not a certificate — the certificate is the -----BEGIN CERTIFICATE----- block'
        : 'the certificate must be PEM, starting with -----BEGIN CERTIFICATE-----',
    };
  }
  if (/ENCRYPTED PRIVATE KEY-----/.test(key)) {
    return {
      error:
        'passphrase-protected keys are not supported — decrypt it first with: openssl rsa -in key.pem -out key-decrypted.pem',
    };
  }
  let x509: crypto.X509Certificate;
  try {
    x509 = new crypto.X509Certificate(cert);
  } catch {
    return { error: 'the certificate could not be parsed as PEM' };
  }
  let privateKey: crypto.KeyObject;
  try {
    privateKey = crypto.createPrivateKey(key);
  } catch {
    return { error: 'the private key could not be parsed as PEM' };
  }
  if (!x509.checkPrivateKey(privateKey)) {
    return { error: "that private key doesn't match that certificate" };
  }
  return { cert, key };
}

export function isClientCertProblem(
  result: ClientCertPair | ClientCertProblem,
): result is ClientCertProblem {
  return 'error' in result;
}

/** The single-file form other clients want on disk (HexChat's `client.pem`,
 *  WeeChat's `ssl.crt`): key first, then cert. */
export function clientCertBundle(pair: ClientCertPair): string {
  return `${pair.key.trimEnd()}\n${pair.cert.trimEnd()}\n`;
}
