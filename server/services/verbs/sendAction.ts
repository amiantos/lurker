// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { registerVerb } from '../verbRegistry.js';
import ircManager from '../ircManager.js';

/** Authenticated caller context passed to every verb handler. */
interface VerbContext {
  userId: number;
  scope: string;
}

registerVerb({
  name: 'send_action',
  description:
    'Send a CTCP ACTION ("/me ...") to a channel or peer on a network. Returns { ok: false, error: "not-connected" } when the network is offline.',
  scope: 'read-write',
  input: {
    type: 'object',
    properties: {
      networkId: { type: 'integer' },
      target: {
        type: 'string',
        description: 'A channel name like "#foo" or a peer nick.',
      },
      text: { type: 'string' },
      replyTo: {
        type: 'integer',
        description:
          'Optional. The id of a message in the same buffer (from recent_messages) that this answers, sent as an IRCv3 reply. Ignored where the network or the message cannot carry one; the text is sent either way.',
      },
    },
    required: ['networkId', 'target', 'text'],
    additionalProperties: false,
  },
  handler(ctx: VerbContext, input: Record<string, unknown>) {
    const networkId = Number(input.networkId);
    const target = typeof input.target === 'string' ? input.target : '';
    const text = typeof input.text === 'string' ? input.text : '';
    if (!target || !text) return { ok: false, error: 'empty-target-or-text' };
    const replyTo = Number.isInteger(input.replyTo) ? (input.replyTo as number) : undefined;
    const ok = ircManager.action(ctx.userId, networkId, target, text, { replyTo });
    return ok ? { ok: true } : { ok: false, error: 'not-connected' };
  },
});
