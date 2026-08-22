// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { registerVerb } from '../verbRegistry.js';
import ircManager from '../ircManager.js';

interface VerbContext {
  userId: number;
  scope: string;
}

registerVerb({
  name: 'set_topic',
  description:
    "Set (or clear) a channel's topic. Pass `topic` text to set it, or omit / empty to clear it. " +
    'Requires the appropriate channel privileges (usually +o or a -t channel); the server may ' +
    'reject it — watch the channel/server buffer. Returns { ok: false, error: "not-connected" } ' +
    'when the network is offline.',
  scope: 'read-write',
  input: {
    type: 'object',
    properties: {
      networkId: { type: 'integer' },
      channel: { type: 'string', description: 'Channel name, e.g. "#foo".' },
      topic: { type: 'string', description: 'New topic. Empty or omitted clears it.' },
    },
    required: ['networkId', 'channel'],
    additionalProperties: false,
  },
  handler(ctx: VerbContext, input: Record<string, unknown>) {
    const networkId = Number(input.networkId);
    const channel = typeof input.channel === 'string' ? input.channel.trim() : '';
    const topic = typeof input.topic === 'string' ? input.topic : '';
    if (!channel) return { ok: false, error: 'empty-channel' };
    if (/[\r\n]/.test(topic)) return { ok: false, error: 'topic-must-be-single-line' };
    const conn = ircManager.getConnection(ctx.userId, networkId);
    if (!conn) return { ok: false, error: 'not-connected' };
    conn.raw(`TOPIC ${channel} :${topic}`);
    return { ok: true };
  },
});
