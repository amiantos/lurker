// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Regressions from the #490 review.
//
// A misconfigured native credential is an operator mistake, and the two ways it
// can go wrong pull in opposite directions: it must be LOUD (say what's missing,
// at boot, before anyone relies on push) and it must be CONTAINED (one broken
// transport cannot take down the transports that are fine). The original code
// managed neither — it threw lazily, from inside a filter, on the first push.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import { apnsSender } from './apnsSender.js';
import { fcmSender } from './fcmSender.js';
import { assertPushCredentials, resetCredentialCache } from './credentials.js';

const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const P8_PEM = ec.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

const ENV = [
  'LURKER_APNS_KEY',
  'LURKER_APNS_KEY_ID',
  'LURKER_APNS_TEAM_ID',
  'LURKER_APNS_BUNDLE_ID',
  'LURKER_APNS_SANDBOX',
  'LURKER_FCM_SERVICE_ACCOUNT',
];

function clearEnv(): void {
  for (const k of ENV) delete process.env[k];
  resetCredentialCache();
}

beforeEach(clearEnv);
afterEach(clearEnv);

describe('isConfigured never throws', () => {
  it('reports false for a partially-configured APNs rather than throwing', () => {
    // The bug this replaces: apnsCredentials() throws on a partial config and
    // isConfigured() let it escape. deliver() calls isConfigured() inside a
    // filter, and a throwing predicate aborts Array.filter outright — so the
    // user's healthy Web Push browser was never even attempted. One operator
    // typo silenced push entirely, for every transport.
    process.env.LURKER_APNS_KEY = P8_PEM;
    process.env.LURKER_APNS_KEY_ID = 'KEYID';
    // ...TEAM_ID and BUNDLE_ID missing.
    resetCredentialCache();
    expect(() => apnsSender.isConfigured()).not.toThrow();
    expect(apnsSender.isConfigured()).toBe(false);
  });

  it('reports false for a malformed APNs key rather than throwing', () => {
    process.env.LURKER_APNS_KEY = 'not-a-key';
    process.env.LURKER_APNS_KEY_ID = 'KEYID';
    process.env.LURKER_APNS_TEAM_ID = 'TEAM';
    process.env.LURKER_APNS_BUNDLE_ID = 'chat.lurker.app';
    resetCredentialCache();
    expect(() => apnsSender.isConfigured()).not.toThrow();
    expect(apnsSender.isConfigured()).toBe(false);
  });

  it('reports false for a malformed FCM service account rather than throwing', () => {
    process.env.LURKER_FCM_SERVICE_ACCOUNT = '{not json';
    resetCredentialCache();
    expect(() => fcmSender.isConfigured()).not.toThrow();
    expect(fcmSender.isConfigured()).toBe(false);
  });

  it('reports false when nothing is configured at all', () => {
    expect(apnsSender.isConfigured()).toBe(false);
    expect(fcmSender.isConfigured()).toBe(false);
  });
});

describe('assertPushCredentials', () => {
  it('passes when nothing is configured — self-hosting is not a misconfiguration', () => {
    expect(() => assertPushCredentials()).not.toThrow();
  });

  it('passes on a complete APNs config', () => {
    process.env.LURKER_APNS_KEY = P8_PEM;
    process.env.LURKER_APNS_KEY_ID = 'KEYID';
    process.env.LURKER_APNS_TEAM_ID = 'TEAM';
    process.env.LURKER_APNS_BUNDLE_ID = 'chat.lurker.app';
    resetCredentialCache();
    expect(() => assertPushCredentials()).not.toThrow();
  });

  it('throws at boot naming the missing APNs pieces', () => {
    // This is what makes "fails loud at boot" true. Nothing used to call the
    // credential parsers at boot at all, so the claim in the comments was simply
    // false: a misconfigured server started clean and failed on the first push,
    // where the throw was swallowed as a transient failure and never surfaced.
    process.env.LURKER_APNS_KEY = P8_PEM;
    process.env.LURKER_APNS_KEY_ID = 'KEYID';
    resetCredentialCache();
    expect(() => assertPushCredentials()).toThrow(/LURKER_APNS_TEAM_ID, LURKER_APNS_BUNDLE_ID/);
  });

  it('throws at boot on a malformed FCM service account', () => {
    process.env.LURKER_FCM_SERVICE_ACCOUNT = '{not json';
    resetCredentialCache();
    expect(() => assertPushCredentials()).toThrow(/LURKER_FCM_SERVICE_ACCOUNT/);
  });
});
