// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { registerVerb } from '../verbRegistry.js';
import ircManager from '../ircManager.js';

interface VerbContext {
  userId: number;
  scope: string;
}

registerVerb({
  name: 'set_nick',
  description:
    'Change your nickname on a network. The change is asynchronous and may be rejected by the ' +
    'server (nick in use, invalid, or banned) — watch the server buffer for the outcome. Returns ' +
    '{ ok: false, error: "not-connected" } when the network is offline.',
  scope: 'read-write',
  input: {
    type: 'object',
    properties: {
      networkId: { type: 'integer' },
      nick: { type: 'string', description: 'The new nickname (no spaces).' },
    },
    required: ['networkId', 'nick'],
    additionalProperties: false,
  },
  handler(ctx: VerbContext, input: Record<string, unknown>) {
    const networkId = Number(input.networkId);
    const nick = typeof input.nick === 'string' ? input.nick.trim() : '';
    if (!nick) return { ok: false, error: 'empty-nick' };
    if (/[\s\r\n]/.test(nick)) return { ok: false, error: 'nick-must-be-single-token' };
    const conn = ircManager.getConnection(ctx.userId, networkId);
    if (!conn) return { ok: false, error: 'not-connected' };
    conn.raw(`NICK ${nick}`);
    return { ok: true };
  },
});
