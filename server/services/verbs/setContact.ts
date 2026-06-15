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
  name: 'set_contact',
  description:
    'Create or update a friend/contact and its per-network watch list. Omit contactId to create; pass it to edit. targets are the (networkId, nick) pairs to watch for this person across networks. notifyOnline toggles a toast when they come online.',
  scope: 'read-write',
  input: {
    type: 'object',
    properties: {
      contactId: { type: 'integer', description: 'Omit to create a new contact; provide to edit.' },
      displayName: { type: 'string', maxLength: 128 },
      notifyOnline: { type: 'boolean' },
      targets: {
        type: 'array',
        description:
          'Watch targets. Each is one (networkId, nick); multiple nicks per network are allowed. ' +
          'Mark exactly one isPrimary — the DM that opens when the friend is clicked (defaults to the first).',
        items: {
          type: 'object',
          properties: {
            networkId: { type: 'integer' },
            nick: { type: 'string' },
            isPrimary: { type: 'boolean' },
          },
          required: ['networkId', 'nick'],
          additionalProperties: false,
        },
      },
    },
    required: ['displayName', 'targets'],
    additionalProperties: false,
  },
  handler(ctx: VerbContext, input: Record<string, unknown>) {
    const displayName = typeof input.displayName === 'string' ? input.displayName.trim() : '';
    if (!displayName) {
      throw Object.assign(new Error('displayName is empty or whitespace'), {
        code: 'invalid_input',
      });
    }
    const contactId = input.contactId != null ? Number(input.contactId) : null;
    const notifyOnline = !!input.notifyOnline;
    const targets = Array.isArray(input.targets)
      ? (input.targets as Array<Record<string, unknown>>).map((t) => ({
          networkId: Number(t.networkId),
          nick: typeof t.nick === 'string' ? t.nick : '',
          isPrimary: !!t.isPrimary,
        }))
      : [];
    const saved = ircManager.setContact(ctx.userId, {
      contactId,
      displayName,
      notifyOnline,
      targets,
    });
    if (!saved) {
      throw Object.assign(new Error('contact not found'), { code: 'not_found' });
    }
    // Fan out to every open WS tab so the Friends store reacts identically
    // whether the edit came from the browser or an agent.
    fanOutToUser(ctx.userId, { kind: 'contact-updated', contact: saved });
    return saved;
  },
});
