// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { registerVerb } from '../verbRegistry.js';
import ircManager from '../ircManager.js';

interface VerbContext {
  userId: number;
  scope: string;
}

registerVerb({
  name: 'connect_network',
  description:
    'Connect (or reconnect) a configured network. Idempotent: a no-op if already connected unless ' +
    '`force` is true, which tears down the existing connection and dials fresh. Connection is ' +
    'asynchronous — watch the server buffer for registration. Returns { ok: false, error: ' +
    '"failed" } if the connection could not be started (e.g. the account is paused).',
  scope: 'read-write',
  input: {
    type: 'object',
    properties: {
      networkId: { type: 'integer' },
      force: {
        type: 'boolean',
        description: 'Reconnect from scratch even if already connected.',
      },
    },
    required: ['networkId'],
    additionalProperties: false,
  },
  handler(ctx: VerbContext, input: Record<string, unknown>) {
    const networkId = Number(input.networkId);
    const conn =
      input.force === true
        ? ircManager.restartNetwork(ctx.userId, networkId)
        : ircManager.startNetwork(ctx.userId, networkId);
    return conn ? { ok: true } : { ok: false, error: 'failed' };
  },
});
