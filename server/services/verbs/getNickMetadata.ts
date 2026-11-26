// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { registerVerb } from '../verbRegistry.js';
import { getNickMetadata } from '../../db/nickMetadata.js';

/** Authenticated caller context passed to every verb handler. */
interface VerbContext {
  userId: number;
  scope: string;
}

registerVerb({
  name: 'get_nick_metadata',
  description:
    'Read the metadata the caller set on a nick (#1449). `values` maps a key to its value, or ' +
    "to null where the caller hid the other person's; a key not there was left alone.",
  scope: 'read',
  input: {
    type: 'object',
    properties: {
      networkId: { type: 'integer' },
      nick: { type: 'string' },
    },
    required: ['networkId', 'nick'],
    additionalProperties: false,
  },
  handler(ctx: VerbContext, input: Record<string, unknown>) {
    const networkId = Number(input.networkId);
    const nick = typeof input.nick === 'string' ? input.nick.trim() : '';
    if (!nick) {
      throw Object.assign(new Error('nick is empty or whitespace'), { code: 'invalid_input' });
    }
    return { networkId, nick, values: getNickMetadata({ userId: ctx.userId, networkId, nick }) };
  },
});
