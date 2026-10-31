// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { registerVerb } from '../verbRegistry.js';
import ircManager from '../ircManager.js';
import { getNetwork } from '../../db/networks.js';
import { isNetworkHostAllowed } from '../networkPolicy.js';

interface VerbContext {
  userId: number;
  scope: string;
}

registerVerb({
  name: 'connect_network',
  description:
    'Connect (or reconnect) a configured network. Idempotent: a no-op if already connected unless ' +
    '`force` is true, which tears down the existing connection and dials fresh. Connection is ' +
    'asynchronous — watch the server buffer for registration. Returns { ok: false, error: ' +
    '"locked-down" } when this instance or this account is not allowed the network\'s host, or ' +
    '{ ok: false, error: "failed" } if the connection could not be started (e.g. the account is ' +
    'paused).',
  scope: 'read-write',
  input: {
    type: 'object',
    properties: {
      networkId: { type: 'integer' },
      force: {
        type: 'boolean',
        description: 'Reconnect from scratch even if already connected.',
      },
    },
    required: ['networkId'],
    additionalProperties: false,
  },
  handler(ctx: VerbContext, input: Record<string, unknown>) {
    const networkId = Number(input.networkId);
    // Check the host allowlist BEFORE force reaches restartNetwork. That call
    // disposes the live connection and only then re-dials through the gate, so
    // on a locked-down host it would destroy a working connection and be unable
    // to rebuild it — leaving the caller worse off than before, with nothing but
    // "failed" to explain it. The REST routes pre-check for the same reason
    // (routes/networks.ts); startNetwork still enforces it, but silently.
    const network = getNetwork(networkId, ctx.userId);
    if (!network) return { ok: false, error: 'unknown-network' };
    if (!isNetworkHostAllowed(network.host, ctx.userId)) return { ok: false, error: 'locked-down' };
    const conn =
      input.force === true
        ? ircManager.restartNetwork(ctx.userId, networkId)
        : ircManager.startNetwork(ctx.userId, networkId);
    return conn ? { ok: true } : { ok: false, error: 'failed' };
  },
});
