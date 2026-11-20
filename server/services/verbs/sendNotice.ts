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
  name: 'send_notice',
  description:
    'Send a NOTICE to a channel or peer on a network. Like send_message but uses NOTICE semantics (no auto-reply expected). Returns { ok: false, error: "not-connected" } when the network is offline.',
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
    },
    required: ['networkId', 'target', 'text'],
    additionalProperties: false,
  },
  handler(ctx: VerbContext, input: Record<string, unknown>) {
    const networkId = Number(input.networkId);
    const target = typeof input.target === 'string' ? input.target : '';
    const text = typeof input.text === 'string' ? input.text : '';
    if (!target || !text) return { ok: false, error: 'empty-target-or-text' };
    const ok = ircManager.notice(ctx.userId, networkId, target, text);
    return ok ? { ok: true } : { ok: false, error: 'not-connected' };
  },
});
