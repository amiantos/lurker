// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { registerVerb } from '../verbRegistry.js';
import { cleartextE2eLeak } from '../e2e/rawGuard.js';
import { writableConnection } from './liveConn.js';

/** Authenticated caller context passed to every verb handler. */
interface VerbContext {
  userId: number;
  scope: string;
}

registerVerb({
  name: 'send_raw',
  description:
    'Send a raw IRC protocol line on a network, exactly as typed — the escape hatch for any ' +
    'IRC command without a dedicated verb (e.g. "MODE #chan +o nick", "KICK #chan bob :spam", ' +
    '"INVITE bob #chan", "OPER user pass"). The line is sent verbatim with no parsing; do NOT ' +
    'include a trailing CRLF. Powerful and unguarded — it runs as you, so it can do anything ' +
    'your IRC session can. Do NOT use it for PRIVMSG: send_message applies end-to-end ' +
    'encryption on channels that have it enabled, and a raw PRIVMSG bypasses that and ' +
    'transmits cleartext — so a raw PRIVMSG naming an E2E channel is refused (error ' +
    '"e2e-channel-use-send-message"), however the line is written, as is a raw NOTICE or ' +
    'TAGMSG there ("e2e-channel-no-cleartext": those have no encrypted form at all). ' +
    'Prefer the dedicated verb wherever one exists (send_message, ' +
    'send_notice, send_action, join_channel, part_channel, set_nick, set_topic, whois). ' +
    "Server replies (WHOIS, LIST, …) arrive asynchronously in the network's server buffer, " +
    'whose target is the literal ":server:<networkId>" — that buffer is not listed by ' +
    'list_buffers, so read it by passing the returned `serverBuffer` string to ' +
    'recent_messages. Returns { ok: false, error: "not-connected" } when the network is offline.',
  scope: 'read-write',
  input: {
    type: 'object',
    properties: {
      networkId: { type: 'integer' },
      line: {
        type: 'string',
        description: 'The raw IRC line without a trailing CRLF, e.g. "MODE #chan +o alice".',
      },
    },
    required: ['networkId', 'line'],
    additionalProperties: false,
  },
  handler(ctx: VerbContext, input: Record<string, unknown>) {
    const networkId = Number(input.networkId);
    const line = typeof input.line === 'string' ? input.line.replace(/[\r\n]+$/, '').trim() : '';
    if (!line) return { ok: false, error: 'empty-line' };
    // Guard against embedded CRLF (command injection into extra IRC lines).
    if (/[\r\n]/.test(line)) return { ok: false, error: 'line-must-be-single-line' };
    const conn = writableConnection(ctx.userId, networkId);
    if (!conn) return { ok: false, error: 'not-connected' };
    // A prose "don't PRIVMSG with this" in the description is not an
    // enforcement mechanism for a confidentiality property. ircManager.send
    // encrypts on an E2E channel and refuses to fall through on failure; this
    // path has neither, and the sender gets no local echo either, so a leak
    // would be silent at both ends. Refuse and name the verb that does it right.
    const leak = cleartextE2eLeak(ctx.userId, networkId, line);
    if (leak) {
      // A notice or a reaction has no encrypted form, so no verb "does it right"
      // — a code that sent the agent to send_message would turn a notice into
      // a message.
      return {
        ok: false,
        error:
          leak.command === 'PRIVMSG' ? 'e2e-channel-use-send-message' : 'e2e-channel-no-cleartext',
      };
    }
    conn.raw(line);
    return { ok: true, serverBuffer: conn.serverTarget() };
  },
});
