// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { registerVerb } from '../verbRegistry.js';
import ircManager from '../ircManager.js';

interface VerbContext {
  userId: number;
  scope: string;
}

registerVerb({
  name: 'disconnect_network',
  description:
    'Disconnect a network (sends QUIT with the optional `reason` and tears down the connection). ' +
    'The network stays configured — reconnect later with connect_network. Always returns ' +
    '{ ok: true }; disconnecting an already-offline network is a no-op.',
  scope: 'read-write',
  input: {
    type: 'object',
    properties: {
      networkId: { type: 'integer' },
      reason: { type: 'string', description: 'Optional QUIT message.' },
    },
    required: ['networkId'],
    additionalProperties: false,
  },
  handler(ctx: VerbContext, input: Record<string, unknown>) {
    const networkId = Number(input.networkId);
    const reason =
      typeof input.reason === 'string' && input.reason.trim() ? input.reason.trim() : undefined;
    ircManager.stopNetwork(ctx.userId, networkId, reason);
    return { ok: true };
  },
});
