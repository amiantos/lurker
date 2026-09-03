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
  /** Same, SHA-512 — 128 characters. Libera refuses anything else
   *  ("Fingerprints on this network must be SHA2-512 digests"), and it is not
   *  derivable from the others, so all three are carried rather than picking a
   *  favourite: which one a network wants is the network's business. */
  sha512: string;
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
    // A leading '#' means "what follows is hex-encoded DER" to the DN parser,
    // so a nick like `#chat` throws ("not HEX encoded") instead of naming
    // anything — the same unexplained 500, by a different route.
    .replace(/^#+/, '')
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
  // Imported here rather than at module scope so the IRC engine — which imports
  // this module only to check that a pair it was handed is dialable — doesn't
  // pull a certificate generator (and its crypto dependency tree) into a
  // process whose whole job is holding sockets.
  const { generate: generateSelfSigned } = await import('selfsigned');
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
    sha512: bare(x509.fingerprint512),
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

// One PEM blob holding both halves → the two of them; null when it isn't that.
// Takes the FIRST block of each kind deliberately: a bundle carrying a chain
// presents the leaf, which is the certificate whose fingerprint services hold.
function splitCombinedPem(pem: string): { cert: string; key: string } | null {
  const cert = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/.exec(pem)?.[0];
  const key = /-----BEGIN ([A-Z ]*)PRIVATE KEY-----[\s\S]*?-----END \1PRIVATE KEY-----/.exec(
    pem,
  )?.[0];
  return cert && key ? { cert, key } : null;
}

/** Will tls.connect accept this pair? Structural only — no opinion on whether
 *  any network knows the fingerprint. Crypto-only (no certificate generator in
 *  the import graph) so the IRC engine can ask the same question of a pair that
 *  arrived over its wire before handing it to tls.connect, where a bad key
 *  throws synchronously. */
export function isDialableCertPair(certPem: string, keyPem: string): boolean {
  try {
    return new crypto.X509Certificate(certPem).checkPrivateKey(crypto.createPrivateKey(keyPem));
  } catch {
    return false;
  }
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
  let cert = typeof certPem === 'string' ? certPem.trim() : '';
  let key = typeof keyPem === 'string' ? keyPem.trim() : '';
  // A combined client.pem — cert and key in one file — pasted into the
  // certificate box with the key box left empty. It is the likeliest mistake
  // (HexChat and WeeChat both keep the pair that way) and it is barely a
  // mistake at all: that file is also exactly what clientCertBundle() below
  // exports, so someone moving a certificate between two Lurker networks lands
  // here. Split it rather than making them do it by hand.
  if (!key && cert) {
    const split = splitCombinedPem(cert);
    if (split) ({ cert, key } = split);
  }
  if (!cert || !key) {
    // Only reached with genuinely nothing usable in hand, so name whichever
    // half IS there rather than asking again for both.
    if (cert && /PRIVATE KEY-----/.test(cert)) {
      return {
        error:
          'that is a private key with no certificate in it — paste the certificate too, or both halves of your client.pem',
      };
    }
    return { error: 'a certificate and its private key are both required' };
  }
  if (!/-----BEGIN CERTIFICATE-----/.test(cert)) {
    return {
      error: /PRIVATE KEY-----/.test(cert)
        ? 'that looks like a private key, not a certificate — the certificate is the -----BEGIN CERTIFICATE----- block'
        : 'the certificate must be PEM, starting with -----BEGIN CERTIFICATE-----',
    };
  }
  // Two spellings: PKCS#8 says so in the label, while the traditional PKCS#1
  // form (what `openssl genrsa -aes256` writes, and what sits in a lot of
  // existing HexChat/WeeChat setups) keeps its ordinary label and announces the
  // encryption in a header. Without the second test that key falls through to
  // "could not be parsed as PEM" — the exact misdiagnosis this branch exists to
  // prevent.
  if (/ENCRYPTED PRIVATE KEY-----/.test(key) || /Proc-Type:\s*4,\s*ENCRYPTED/.test(key)) {
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
