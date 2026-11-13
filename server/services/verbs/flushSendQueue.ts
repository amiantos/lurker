// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { registerVerb } from '../verbRegistry.js';
import ircManager from '../ircManager.js';

interface VerbContext {
  userId: number;
  scope: string;
}

registerVerb({
  name: 'flush_send_queue',
  description:
    'Drop the messages you sent on a network that are still waiting in its send queue ' +
    '(flood protection spaces a long paste or a burst out). Each dropped message is marked ' +
    'not sent in its buffer. Lines Lurker sends on its own (joins, mode and WHO queries) are ' +
    'kept. Returns { ok: true, dropped } with how many messages were dropped; 0 when nothing ' +
    'was waiting or the network is offline.',
  scope: 'read-write',
  input: {
    type: 'object',
    properties: {
      networkId: { type: 'integer' },
    },
    required: ['networkId'],
    additionalProperties: false,
  },
  handler(ctx: VerbContext, input: Record<string, unknown>) {
    // callVerb has already refused a networkId the user doesn't own.
    return { ok: true, dropped: ircManager.flushSendQueue(ctx.userId, Number(input.networkId)) };
  },
});
