// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Pulling a certificate and its private key out of PEM text (#459).
//
// Shared because both ends need the same answer for different reasons: the
// client splits a file someone picked so they can SEE what will be sent, and
// the server splits what arrives because it cannot trust the client to have
// done it. Text only — no crypto — so it costs the browser nothing; whether the
// pair is actually usable is decided server side by validateClientCertPair.

const CERT_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/;
// The label varies (`PRIVATE KEY`, `RSA PRIVATE KEY`, `EC PRIVATE KEY`), and
// the backreference keeps BEGIN and END agreeing so a truncated file can't
// match across two different blocks.
const KEY_BLOCK = /-----BEGIN ([A-Z ]*)PRIVATE KEY-----[\s\S]*?-----END \1PRIVATE KEY-----/;

/** The first certificate and the first private key in some PEM text, or null
 *  when it doesn't hold both. First of each on purpose: a bundle carrying a
 *  chain presents the leaf, which is the certificate whose fingerprint services
 *  hold. */
export function splitCombinedPem(pem: string): { cert: string; key: string } | null {
  const cert = CERT_BLOCK.exec(pem)?.[0];
  const key = KEY_BLOCK.exec(pem)?.[0];
  return cert && key ? { cert, key } : null;
}

/** Whichever halves are present, for filling in a form. Unlike splitCombinedPem
 *  this answers with what it found rather than all-or-nothing, so a user who
 *  picked only their certificate sees it land in the certificate box and can
 *  add the key themselves, instead of being told the file was no good. */
export function partsFromPem(pem: string): { cert: string; key: string } {
  return { cert: CERT_BLOCK.exec(pem)?.[0] ?? '', key: KEY_BLOCK.exec(pem)?.[0] ?? '' };
}
