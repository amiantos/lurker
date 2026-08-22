// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { registerVerb } from '../verbRegistry.js';
import ircManager from '../ircManager.js';

interface VerbContext {
  userId: number;
  scope: string;
}

registerVerb({
  name: 'list_members',
  description:
    'List the members currently in a channel on a network, with their prefix modes (o=op, ' +
    'h=halfop, v=voice, …) and away state. Live membership from the active connection — the ' +
    'channel must be joined. Returns { ok: false, error: "not-in-channel" } if you are not in it, ' +
    'or "not-connected" when the network is offline.',
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
    const members = [...ch.members.values()].map((m) => ({
      nick: m.nick,
      modes: m.modes,
      away: m.away,
    }));
    members.sort((a, b) => a.nick.localeCompare(b.nick));
    return { ok: true, channel: ch.name, count: members.length, members };
  },
});
