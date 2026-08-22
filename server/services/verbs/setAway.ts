// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { registerVerb } from '../verbRegistry.js';
import ircManager from '../ircManager.js';

interface VerbContext {
  userId: number;
  scope: string;
}

registerVerb({
  name: 'set_away',
  description:
    'Set or clear your away status across every connected network (user-wide, like /away). ' +
    'Provide `message` to mark yourself away with that reason; omit it or pass an empty string ' +
    'to come back. Returns { ok: true, away } reflecting the new state.',
  scope: 'read-write',
  input: {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description: 'Away reason. Empty or omitted clears away (marks you back).',
      },
    },
    required: [],
    additionalProperties: false,
  },
  handler(ctx: VerbContext, input: Record<string, unknown>) {
    const message = typeof input.message === 'string' ? input.message.trim() : '';
    if (message) ircManager.setAwayAll(ctx.userId, message, { autoSet: false });
    else ircManager.clearAwayAll(ctx.userId, { autoSet: false });
    return { ok: true, away: !!message };
  },
});
