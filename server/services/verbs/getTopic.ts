// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { registerVerb } from '../verbRegistry.js';
import ircManager from '../ircManager.js';

interface VerbContext {
  userId: number;
  scope: string;
}

registerVerb({
  name: 'get_topic',
  description:
    "Read a joined channel's current topic from the live connection. Returns { ok: true, topic } " +
    '(topic is null when unset), or "not-in-channel" if you are not in it / "not-connected" when ' +
    'the network is offline.',
  scope: 'read',
  input: {
    type: 'object',
    properties: {
      networkId: { type: 'integer' },
      channel: { type: 'string', description: 'Channel name, e.g. "#foo".' },
    },
    required: ['networkId', 'channel'],
    additionalProperties: false,
  },
  handler(ctx: VerbContext, input: Record<string, unknown>) {
    const networkId = Number(input.networkId);
    const channel = typeof input.channel === 'string' ? input.channel.trim() : '';
    if (!channel) return { ok: false, error: 'empty-channel' };
    const conn = ircManager.getConnection(ctx.userId, networkId);
    if (!conn) return { ok: false, error: 'not-connected' };
    const ch = conn.channels.get(channel.toLowerCase());
    if (!ch) return { ok: false, error: 'not-in-channel' };
    return { ok: true, channel: ch.name, topic: ch.topic ?? null };
  },
});
