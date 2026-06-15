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
  name: 'delete_contact',
  description: 'Remove a friend/contact and stop watching all of its nicks.',
  scope: 'read-write',
  input: {
    type: 'object',
    properties: {
      contactId: { type: 'integer' },
    },
    required: ['contactId'],
    additionalProperties: false,
  },
  handler(ctx: VerbContext, input: Record<string, unknown>) {
    const contactId = Number(input.contactId);
    const ok = ircManager.deleteContact(ctx.userId, contactId);
    if (!ok) {
      throw Object.assign(new Error('contact not found'), { code: 'not_found' });
    }
    fanOutToUser(ctx.userId, { kind: 'contact-deleted', contactId });
    return { contactId, deleted: true };
  },
});
