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
    'Drop the chat messages you sent on a network (messages, notices, /me, XDCC requests) ' +
    'that are still waiting in its send queue: flood protection spaces a long paste or a ' +
    'burst out. Each dropped message is marked not sent in its buffer. Everything else is ' +
    'kept: raw lines and CTCP requests you sent, a message whose first lines have already ' +
    'gone, and the lines Lurker sends on its own (joins, mode and WHO queries). Returns ' +
    '{ ok: true, dropped } with how many messages were dropped; 0 when nothing was waiting ' +
    'or the network is offline.',
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
