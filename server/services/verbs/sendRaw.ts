// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { registerVerb } from '../verbRegistry.js';
import ircManager from '../ircManager.js';

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
    '"TOPIC #chan :new topic", "WHOIS bob", "INVITE bob #chan", "OPER user pass"). The line is ' +
    'sent verbatim with no parsing; do NOT include a trailing CRLF. Powerful and unguarded — it ' +
    'runs as you, so it can do anything your IRC session can. Server replies (WHOIS, LIST, etc.) ' +
    'arrive asynchronously; read them afterward with recent_messages on the relevant buffer ' +
    '(often the server buffer). Returns { ok: false, error: "not-connected" } when the network ' +
    'is offline.',
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
    const conn = ircManager.getConnection(ctx.userId, networkId);
    if (!conn) return { ok: false, error: 'not-connected' };
    conn.raw(line);
    return { ok: true };
  },
});
