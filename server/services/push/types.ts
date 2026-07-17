// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The transport seam (#490 phase 3).
//
// Web Push, APNs and FCM differ in more than payload: each has its own
// credential model (VAPID keypair / .p8 signing key / service-account JSON), its
// own wire format, and — the fiddly part — its own vocabulary for "this device is
// gone" versus "try again later". What they have in common is the shape below,
// which is the only thing pushService needs to fan out.
//
// The seam is deliberately narrow. Everything upstream of it (the maybePush gate
// chain) is transport-neutral already, and everything downstream is per-provider.

import type { PushSubscription, PushTransport } from '../../db/pushSubscriptions.js';
import type { NotificationContent, PushPayload } from '../notificationContent.js';

/**
 * What a failure MEANS for the subscription that produced it. This vocabulary is
 * the pre-existing Web Push behavior generalized, and pushService applies it
 * identically to every transport:
 *
 * - `permanent` — the provider says this device is gone for good (Web Push
 *   404/410, APNs 410 Unregistered, FCM 404 UNREGISTERED). Delete the row.
 * - `transient` — the network or the provider is having a bad moment (429, 5xx,
 *   a connect blip with no status). The subscription is fine, we just didn't
 *   deliver. Never counts toward the disable threshold: a short outage during a
 *   burst would otherwise disable perfectly healthy devices.
 * - `strike` — the provider rejected THIS subscription specifically with a
 *   concrete 4xx. Enough consecutive strikes disables it, so a broken endpoint
 *   stops erroring on every push (#441); any success resets the streak.
 *
 * The distinction that matters for native and didn't exist for Web Push: a
 * CREDENTIAL failure (a bad .p8, an expired service account — APNs 403, FCM
 * 401/403) must classify as `transient`, never `strike`. It isn't the device's
 * fault, and it fails identically for every device the fleet owns, so striking
 * would march the user's entire set of phones to disabled after five pushes and
 * require each to re-register once the operator fixed the key.
 */
export type FailureClass = 'permanent' | 'transient' | 'strike';

export interface PushSender {
  readonly transport: PushTransport;

  /**
   * Whether this transport has usable credentials. Unconfigured transports are
   * skipped rather than attempted — a self-hosted server has no APNs key and
   * that is normal operation, not an error.
   */
  isConfigured(): boolean;

  /** Human-readable reason a transport is unconfigured, for a one-time log. */
  configHint(): string;

  /** Deliver, or throw. Throwing is what feeds classify(). */
  send(sub: PushSubscription, payload: PushPayload, content: NotificationContent): Promise<void>;

  /**
   * Read-only verdict on a failure. Pure: callers may classify the same error
   * more than once (to log it and to act on it), and must get the same answer
   * with no side effects. Anything a failure should CHANGE belongs in
   * onFailure() below.
   */
  classify(err: unknown): FailureClass;

  /**
   * React to a failure — invalidate a cached credential, drop a poisoned
   * connection. Called once per failed delivery, after classify(). Optional:
   * Web Push has nothing to react to.
   *
   * Separate from classify() because a predicate that mutates module state is a
   * trap: the reset was invisible to anyone reading the seam, fired once per
   * failing device instead of once per failure, and vanished entirely in any
   * test that stubbed the sender (review of #490).
   */
  onFailure?(err: unknown, verdict: FailureClass): void;

  /** One-line diagnostic for the disable/failure logs. */
  describe(err: unknown): string;
}
