// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { registerVerb } from '../verbRegistry.js';
import ircManager from '../ircManager.js';
import { fanOutToUser } from '../wsHub.js';

/** Authenticated caller context passed to every verb handler. */
interface VerbContext {
  userId: number;
  scope: string;
}

registerVerb({
  name: 'set_relay_bot',
  description:
    'Mark or unmark a nick as a relay/bridge bot on a network (#277). When marked, the client re-attributes the bot\'s messages to the speaker embedded in its envelope (e.g. "[Discord] <alice> hi" is shown as alice). Set marked=false to clear the mark. An optional pattern overrides the built-in formats with a custom template using {source}, {nick}, and {message} placeholders.',
  scope: 'read-write',
  input: {
    type: 'object',
    properties: {
      networkId: { type: 'integer' },
      nick: { type: 'string' },
      marked: { type: 'boolean', description: 'true to mark as a relay bot, false to clear.' },
      pattern: {
        type: 'string',
        description:
          'Optional custom envelope template. Empty string uses the built-in defaults. Must contain {nick} and {message}; {source} is optional.',
        maxLength: 512,
      },
    },
    required: ['networkId', 'nick', 'marked'],
    additionalProperties: false,
  },
  handler(ctx: VerbContext, input: Record<string, unknown>) {
    const networkId = Number(input.networkId);
    const nick = typeof input.nick === 'string' ? input.nick.trim() : '';
    if (!nick) {
      throw Object.assign(new Error('nick is empty or whitespace'), { code: 'invalid_input' });
    }
    const marked = input.marked === true;
    const rawPattern = typeof input.pattern === 'string' ? input.pattern : '';
    const pattern = rawPattern.length > 512 ? rawPattern.slice(0, 512) : rawPattern;
    const saved = ircManager.setRelayBot(ctx.userId, networkId, nick, marked, pattern);
    const result = {
      networkId,
      // Echo the canonical stored casing when marked: the row may predate this
      // call under a different case (the NOCASE primary key keeps the
      // first-inserted casing), so this keeps the WS echo and /relay list in
      // agreement with snapshot seeding. Falls back to the input nick when
      // clearing — there's no row to read, and casing is moot once removed.
      nick: saved ? saved.nick : nick,
      marked: !!saved,
      pattern: saved ? saved.pattern : '',
    };
    // Fan out to every open WS tab of this user so the mark stays in sync across
    // devices, mirroring nick-note / contact updates.
    fanOutToUser(ctx.userId, { kind: 'relay-bot-updated', ...result });
    return result;
  },
});
