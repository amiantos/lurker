// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { registerVerb } from '../verbRegistry.js';
import ircManager from '../ircManager.js';
import { channelArg, singleToken } from './args.js';
import { writableConnection } from './liveConn.js';

interface VerbContext {
  userId: number;
  scope: string;
}

registerVerb({
  name: 'join_channel',
  description:
    'Join a channel on a network. Supply `key` for a +k (password-protected) channel; without ' +
    "one, the channel's stored key is sent if Lurker has one. Returns " +
    '{ ok: false, error: "not-connected" } when the network is offline. The join and its member ' +
    'list arrive asynchronously — the channel buffer appears once the server confirms.',
  scope: 'read-write',
  input: {
    type: 'object',
    properties: {
      networkId: { type: 'integer' },
      channel: { type: 'string', description: 'Channel name, e.g. "#foo".' },
      key: { type: 'string', description: 'Optional channel key (password) for +k channels.' },
    },
    required: ['networkId', 'channel'],
    additionalProperties: false,
  },
  handler(ctx: VerbContext, input: Record<string, unknown>) {
    const networkId = Number(input.networkId);
    const channel = channelArg(input.channel);
    if ('error' in channel) return { ok: false, error: channel.error };
    // A channel key is one IRC parameter, and unlike the values that go through
    // IrcConnection.raw() it reaches irc-framework's client.join(), which
    // serialises and writes the line verbatim — no CR/LF stripping. So an
    // unchecked key really can inject a second command.
    let key: string | undefined;
    if (input.key != null && String(input.key) !== '') {
      const parsed = singleToken(input.key, {
        empty: 'empty-key',
        malformed: 'key-must-be-single-token',
      });
      if ('error' in parsed) return { ok: false, error: parsed.error };
      key = parsed.value;
    }
    if (!writableConnection(ctx.userId, networkId)) return { ok: false, error: 'not-connected' };
    const ok = ircManager.joinChannel(ctx.userId, networkId, channel.value, key);
    return ok ? { ok: true } : { ok: false, error: 'not-connected' };
  },
});
