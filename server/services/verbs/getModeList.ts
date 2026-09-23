// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { registerVerb } from '../verbRegistry.js';
import { isChannelTarget } from '../../../shared/channels.js';
import { writableConnection } from './liveConn.js';
import { channelArg } from './args.js';

interface VerbContext {
  userId: number;
  scope: string;
}

registerVerb({
  name: 'get_mode_list',
  description:
    "Fetch one of a channel's list modes fresh from the server: bans (b), ban exceptions (e), " +
    'invite exceptions (I), or quiets (q, where the network has a quiet list). Waits for the ' +
    'reply and returns { ok: true, channel, letter, entries: [{ mask, setBy, setAt }] }. ' +
    'Refusals come back as { ok: false, error: "refused", numeric, text } — e.g. 482 when only ' +
    'operators may see that list. Other errors: "not-a-list-mode", "unsupported-list-mode", ' +
    '"no-reply" (nothing came back in time), "not-connected".',
  scope: 'read-write',
  input: {
    type: 'object',
    properties: {
      networkId: { type: 'integer' },
      channel: { type: 'string', description: 'Channel name, e.g. "#foo".' },
      letter: { type: 'string', description: 'The list mode letter: b, e, I or q.' },
    },
    required: ['networkId', 'channel', 'letter'],
    additionalProperties: false,
  },
  async handler(ctx: VerbContext, input: Record<string, unknown>) {
    const networkId = Number(input.networkId);
    const channel = channelArg(input.channel);
    if ('error' in channel) return { ok: false, error: channel.error };
    // A nick here would make it a user-mode MODE line (see fetchModeList too).
    if (!isChannelTarget(channel.value)) return { ok: false, error: 'not-a-channel' };
    const letter = typeof input.letter === 'string' ? input.letter : '';
    if (!/^[A-Za-z]$/.test(letter)) return { ok: false, error: 'letter-must-be-one-mode-letter' };
    const conn = writableConnection(ctx.userId, networkId);
    if (!conn) return { ok: false, error: 'not-connected' };
    const result = await conn.fetchModeList(channel.value, letter);
    if (!result.ok) return result;
    const name = conn.channelState(channel.value)?.name ?? channel.value;
    return { ok: true, channel: name, letter, entries: result.entries };
  },
});
