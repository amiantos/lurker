// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import type { PushTransport } from '../../db/pushSubscriptions.js';
import type { PushSender } from './types.js';
import { webpushSender } from './webpushSender.js';
import { apnsSender } from './apnsSender.js';
import { fcmSender } from './fcmSender.js';

export type { FailureClass, PushSender } from './types.js';

const SENDERS: Record<PushTransport, PushSender> = {
  webpush: webpushSender,
  apns: apnsSender,
  fcm: fcmSender,
};

export function senderFor(transport: PushTransport): PushSender {
  return SENDERS[transport];
}

// Transports whose credentials are missing are logged once, not once per push:
// a self-hosted server holds no APNs key and that is normal operation, so the
// line is a one-time explanation rather than a recurring error.
const warned = new Set<PushTransport>();

export function warnUnconfiguredOnce(sender: PushSender): void {
  if (warned.has(sender.transport)) return;
  warned.add(sender.transport);
  console.warn(
    `[push] ${sender.transport} device registered but the transport is not configured — ` +
      `${sender.configHint()}`,
  );
}
