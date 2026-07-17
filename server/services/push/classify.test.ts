// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Error classification for all three transports (#490 phase 3).
//
// This is the fiddly part of adding a provider and the part that needs no real
// credentials to test: each provider has its own vocabulary for "this device is
// gone" vs "try again later", and all of it has to land on the same three
// outcomes pushService acts on. Getting it wrong is quiet and expensive — a
// permanent misread as a strike keeps a dead device for five more pushes; a
// transient misread as permanent deletes a live device during a rate limit.

import { describe, it, expect } from 'vitest';
import { webpushSender } from './webpushSender.js';
import { apnsSender, ApnsError } from './apnsSender.js';
import { fcmSender, FcmError } from './fcmSender.js';

describe('webpush classify', () => {
  const c = (statusCode?: number) => webpushSender.classify({ statusCode });

  it('drops an endpoint the push service says is gone', () => {
    expect(c(404)).toBe('permanent');
    expect(c(410)).toBe('permanent');
  });

  it('keeps the subscription through a bad moment', () => {
    expect(c(429)).toBe('transient');
    expect(c(500)).toBe('transient');
    expect(c(503)).toBe('transient');
    // No statusCode at all: a DNS/connect blip or timeout, not a dead endpoint.
    expect(c(undefined)).toBe('transient');
    expect(webpushSender.classify(new Error('socket hang up'))).toBe('transient');
  });

  it('strikes a concrete 4xx', () => {
    expect(c(400)).toBe('strike');
    expect(c(403)).toBe('strike');
    expect(c(413)).toBe('strike');
  });
});

describe('apns classify', () => {
  const c = (status: number | null, reason: string | null = null) =>
    apnsSender.classify(new ApnsError(status, reason, 'test'));

  it('drops a device Apple says is gone', () => {
    expect(c(410, 'Unregistered')).toBe('permanent');
    expect(c(400, 'BadDeviceToken')).toBe('permanent');
    // The classic environment mix-up: a sandbox token sent to production. No
    // amount of retrying fixes it, and it is not our credentials' fault.
    expect(c(400, 'DeviceTokenNotForTopic')).toBe('permanent');
    expect(c(410, null)).toBe('permanent');
  });

  it('never strikes a device for OUR broken credentials', () => {
    // The distinction native has and Web Push didn't. A bad .p8 fails
    // identically for EVERY device, so striking would march the user's whole
    // fleet to disabled after five pushes and force each to re-register once the
    // operator fixed the key.
    expect(c(403, 'InvalidProviderToken')).toBe('transient');
    expect(c(403, 'ExpiredProviderToken')).toBe('transient');
    expect(c(403, 'MissingProviderToken')).toBe('transient');
    expect(c(403, null)).toBe('transient');
  });

  it('keeps the device through Apple throttling or an outage', () => {
    expect(c(429, 'TooManyRequests')).toBe('transient');
    expect(c(500, 'InternalServerError')).toBe('transient');
    expect(c(503, 'ServiceUnavailable')).toBe('transient');
    // A timeout: no status, no reason.
    expect(c(null, null)).toBe('transient');
  });

  it('strikes a rejection that is specific to this request', () => {
    expect(c(400, 'PayloadTooLarge')).toBe('strike');
    expect(c(400, 'BadTopic')).toBe('strike');
  });
});

describe('fcm classify', () => {
  const c = (status: number | null, reason: string | null = null) =>
    fcmSender.classify(new FcmError(status, reason, 'test'));

  it('drops a device Google says is gone', () => {
    expect(c(404, 'UNREGISTERED')).toBe('permanent');
    expect(c(404, 'NOT_FOUND')).toBe('permanent');
    expect(c(404, null)).toBe('permanent');
  });

  it('drops a token that can never work for this project', () => {
    // SENDER_ID_MISMATCH is the token/Firebase-project binding: a token minted
    // against a different project is not ours to push to, ever. It's also the
    // exact failure a self-hoster would hit trying to push to our build, which
    // is why self-hosted native push isn't a goal (see #490).
    expect(c(403, 'SENDER_ID_MISMATCH')).toBe('permanent');
    expect(c(400, 'INVALID_ARGUMENT')).toBe('permanent');
  });

  it('never strikes a device for OUR broken service account', () => {
    expect(c(401, null)).toBe('transient');
    expect(c(403, null)).toBe('transient');
    expect(c(400, 'OAUTH_FAILED')).toBe('transient');
  });

  it('keeps the device through Google throttling or an outage', () => {
    expect(c(429, 'QUOTA_EXCEEDED')).toBe('transient');
    expect(c(500, 'INTERNAL')).toBe('transient');
    expect(c(503, 'UNAVAILABLE')).toBe('transient');
    expect(c(null, null)).toBe('transient');
  });

  it('strikes an otherwise-unexplained 4xx', () => {
    expect(c(413, 'PAYLOAD_TOO_LARGE')).toBe('strike');
  });
});

describe('classification ordering', () => {
  it('reads SENDER_ID_MISMATCH as permanent even though it arrives as a 403', () => {
    // 403 is also the "our credentials are broken" signal, so the reason has to
    // be consulted BEFORE the status. If the status check ran first this would
    // come back transient and a token that can never work would be retried on
    // every push, forever.
    expect(fcmSender.classify(new FcmError(403, 'SENDER_ID_MISMATCH', 't'))).toBe('permanent');
  });

  it('reads BadDeviceToken as permanent even though it arrives as a 400', () => {
    expect(apnsSender.classify(new ApnsError(400, 'BadDeviceToken', 't'))).toBe('permanent');
  });
});
