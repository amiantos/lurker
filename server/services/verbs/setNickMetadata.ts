// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { registerVerb } from '../verbRegistry.js';
import ircManager from '../ircManager.js';
import { fanOutToUser } from '../wsHub.js';
import { vetNickMetadata } from '../ircMetadata.js';
import { NICK_METADATA_KEYS, isNickMetadataKey } from '../../../shared/nickMetadata.js';

/** Authenticated caller context passed to every verb handler. */
interface VerbContext {
  userId: number;
  scope: string;
}

registerVerb({
  name: 'set_nick_metadata',
  description:
    'Set metadata on somebody else, seen only by the caller (#1449): a display name, a nick ' +
    'colour (a slot of the nick palette, e.g. "3"), a time zone (IANA, e.g. "Europe/Berlin"). ' +
    'On a network with IRCv3 metadata it stands in front of what that person set. A null ' +
    'value hides theirs (display-name and avatar only); `reset: true` goes back to theirs.',
  scope: 'read-write',
  input: {
    type: 'object',
    properties: {
      networkId: { type: 'integer' },
      nick: { type: 'string' },
      key: { type: 'string', enum: [...NICK_METADATA_KEYS] },
      value: { type: ['string', 'null'], maxLength: 512 },
      reset: { type: 'boolean' },
    },
    required: ['networkId', 'nick', 'key'],
    additionalProperties: false,
  },
  handler(ctx: VerbContext, input: Record<string, unknown>) {
    const networkId = Number(input.networkId);
    const nick = typeof input.nick === 'string' ? input.nick.trim() : '';
    if (!nick) {
      throw Object.assign(new Error('nick is empty or whitespace'), { code: 'invalid_input' });
    }
    const key = input.key;
    if (!isNickMetadataKey(key)) {
      throw Object.assign(new Error('not a key that can be set on someone'), {
        code: 'invalid_input',
      });
    }
    let values;
    if (input.reset === true) {
      values = ircManager.resetNickMetadata(ctx.userId, networkId, nick, key);
    } else {
      // A missing value is not a statement; only an explicit null hides.
      if (input.value !== null && typeof input.value !== 'string') {
        throw Object.assign(new Error('value is missing: a string, null to hide, or reset'), {
          code: 'invalid_input',
        });
      }
      const vetted = vetNickMetadata(key, input.value);
      if (!vetted) {
        throw Object.assign(new Error(`not a value ${key} can take`), { code: 'invalid_input' });
      }
      values = ircManager.setNickMetadata(ctx.userId, networkId, nick, key, vetted.value);
    }
    const result = { networkId, nick, values };
    // Every open session of this user, as for a nick note: the change shows
    // the same whether it came from this tab, another device or an agent.
    fanOutToUser(ctx.userId, { kind: 'nick-metadata-updated', ...result });
    return result;
  },
});
