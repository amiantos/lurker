// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { registerVerb } from '../verbRegistry.js';
import { e2eManager } from '../e2e/manager.js';
import { contextKey, isChannelContext } from '../e2e/context.js';
import { writableConnection } from './liveConn.js';

/** Authenticated caller context passed to every verb handler. */
interface VerbContext {
  userId: number;
  scope: string;
}

/**
 * The targets a raw line would deliver cleartext to, or none if it isn't that kind of line.
 *
 * ⚠ Read the way ircConnection's noteRawMembership reads a raw JOIN/PART, not as "the first
 * two words" (#1116): a leading IRCv3 tag block and a client-written `:prefix` both move the
 * verb along the line, and a server strips both and delivers the PRIVMSG all the same. The
 * verbs are the three ircManager refuses in the clear on an E2E channel — PRIVMSG, NOTICE
 * (no encrypted form) and TAGMSG (a reaction) — and a comma list names every channel in it,
 * so one E2E channel anywhere in the list is a leak.
 */
function cleartextTargets(line: string): string[] {
  const parsed = /^\s*(?:@\S+\s+)?(?::\S+\s+)?(?:PRIVMSG|NOTICE|TAGMSG)\s+(\S+)/i.exec(line);
  if (!parsed) return [];
  return parsed[1].split(',').filter((t) => t !== '');
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
    'transmits cleartext. Prefer the dedicated verb wherever one exists (send_message, ' +
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
    const leak = cleartextTargets(line).find(
      (target) =>
        isChannelContext(target) &&
        e2eManager.isChannelEnabled(ctx.userId, networkId, contextKey(target, '')),
    );
    if (leak !== undefined) return { ok: false, error: 'e2e-channel-use-send-message' };
    conn.raw(line);
    return { ok: true, serverBuffer: conn.serverTarget() };
  },
});
