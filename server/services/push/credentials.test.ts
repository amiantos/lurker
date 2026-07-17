// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import { apnsCredentials, fcmCredentials, resetCredentialCache } from './credentials.js';

const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const P8_PEM = ec.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

const APNS_ENV = [
  'LURKER_APNS_KEY',
  'LURKER_APNS_KEY_ID',
  'LURKER_APNS_TEAM_ID',
  'LURKER_APNS_BUNDLE_ID',
  'LURKER_APNS_SANDBOX',
  'LURKER_FCM_SERVICE_ACCOUNT',
];

function clearEnv(): void {
  for (const k of APNS_ENV) delete process.env[k];
  resetCredentialCache();
}

beforeEach(clearEnv);
afterEach(clearEnv);

function setApns(over: Record<string, string> = {}): void {
  process.env.LURKER_APNS_KEY = P8_PEM;
  process.env.LURKER_APNS_KEY_ID = 'KEYID123';
  process.env.LURKER_APNS_TEAM_ID = 'TEAM456';
  process.env.LURKER_APNS_BUNDLE_ID = 'chat.lurker.app';
  Object.assign(process.env, over);
  resetCredentialCache();
}

const serviceAccount = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    type: 'service_account',
    project_id: 'lurker-prod',
    client_email: 'push@lurker-prod.iam.gserviceaccount.com',
    private_key: '-----BEGIN PRIVATE KEY-----\\nMIIkey\\n-----END PRIVATE KEY-----\\n',
    ...over,
  });

describe('apnsCredentials', () => {
  it('is null when nothing is set — a self-hosted server holds no Apple key', () => {
    // Unset is normal operation, not an error. Web Push still works.
    expect(apnsCredentials()).toBeNull();
  });

  it('reads a raw PEM', () => {
    setApns();
    expect(apnsCredentials()).toMatchObject({
      keyPem: P8_PEM.trim(),
      keyId: 'KEYID123',
      teamId: 'TEAM456',
      bundleId: 'chat.lurker.app',
      sandbox: false,
    });
  });

  it('reads a base64-encoded PEM', () => {
    // The form an env var can actually carry: `docker run -e` will not preserve
    // a multi-line PEM.
    setApns({ LURKER_APNS_KEY: Buffer.from(P8_PEM).toString('base64') });
    expect(apnsCredentials()?.keyPem).toBe(P8_PEM.trim());
  });

  it('trims stray whitespace around the ids', () => {
    setApns({ LURKER_APNS_KEY_ID: '  KEYID123\n' });
    expect(apnsCredentials()?.keyId).toBe('KEYID123');
  });

  it('opts into the sandbox gateway explicitly', () => {
    for (const v of ['1', 'true', 'yes', 'sandbox', 'TRUE']) {
      setApns({ LURKER_APNS_SANDBOX: v });
      expect(apnsCredentials()?.sandbox).toBe(true);
    }
    for (const v of ['0', 'false', '', 'no']) {
      setApns({ LURKER_APNS_SANDBOX: v });
      expect(apnsCredentials()?.sandbox).toBe(false);
    }
  });

  it('names the missing piece when only partly configured', () => {
    // Partially set is a mistake, not a choice. Silently disabling push for
    // every iOS device would be the wrong read of it.
    setApns();
    delete process.env.LURKER_APNS_TEAM_ID;
    delete process.env.LURKER_APNS_BUNDLE_ID;
    resetCredentialCache();
    expect(() => apnsCredentials()).toThrow(/LURKER_APNS_TEAM_ID, LURKER_APNS_BUNDLE_ID/);
  });

  it('rejects a key that is neither a PEM nor base64 of one', () => {
    // Fails loud at boot rather than as a mystery 403 on the first push six
    // hours later.
    setApns({ LURKER_APNS_KEY: 'not-a-key' });
    expect(() => apnsCredentials()).toThrow(/LURKER_APNS_KEY/);
  });

  it('caches, so a later env change is not picked up mid-process', () => {
    setApns();
    expect(apnsCredentials()?.keyId).toBe('KEYID123');
    process.env.LURKER_APNS_KEY_ID = 'CHANGED';
    expect(apnsCredentials()?.keyId).toBe('KEYID123');
  });
});

describe('fcmCredentials', () => {
  it('is null when unset', () => {
    expect(fcmCredentials()).toBeNull();
  });

  it('reads a raw service-account JSON', () => {
    process.env.LURKER_FCM_SERVICE_ACCOUNT = serviceAccount();
    resetCredentialCache();
    expect(fcmCredentials()).toMatchObject({
      projectId: 'lurker-prod',
      clientEmail: 'push@lurker-prod.iam.gserviceaccount.com',
    });
  });

  it('reads a base64-encoded service-account JSON', () => {
    process.env.LURKER_FCM_SERVICE_ACCOUNT = Buffer.from(serviceAccount()).toString('base64');
    resetCredentialCache();
    expect(fcmCredentials()?.projectId).toBe('lurker-prod');
  });

  it('unescapes the literal \\n Google ships in private_key', () => {
    // Google's JSON carries the PEM with escaped newlines, and anything that has
    // round-tripped through an env var or YAML may too. Hand that to crypto
    // as-is and it rejects the key as malformed.
    process.env.LURKER_FCM_SERVICE_ACCOUNT = serviceAccount();
    resetCredentialCache();
    const pem = fcmCredentials()!.privateKeyPem;
    expect(pem).toContain('\n');
    expect(pem).not.toContain('\\n');
    expect(pem.startsWith('-----BEGIN PRIVATE KEY-----\n')).toBe(true);
  });

  it('rejects JSON that is not a service account', () => {
    process.env.LURKER_FCM_SERVICE_ACCOUNT = JSON.stringify({ hello: 'world' });
    resetCredentialCache();
    expect(() => fcmCredentials()).toThrow(/project_id, client_email and private_key/);
  });

  it('rejects a service account missing only the private key', () => {
    process.env.LURKER_FCM_SERVICE_ACCOUNT = serviceAccount({ private_key: undefined });
    resetCredentialCache();
    expect(() => fcmCredentials()).toThrow(/project_id, client_email and private_key/);
  });

  it('rejects malformed JSON, quoting the parse error', () => {
    process.env.LURKER_FCM_SERVICE_ACCOUNT = '{not json';
    resetCredentialCache();
    expect(() => fcmCredentials()).toThrow(/LURKER_FCM_SERVICE_ACCOUNT/);
  });
});
