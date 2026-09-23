// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { registerVerb } from '../verbRegistry.js';
import { writableConnection } from './liveConn.js';
import { channelArg } from './args.js';
import { getBuffer } from '../../db/buffers.js';
import { batchModeLines, modeTakesParam } from '../../../shared/channelModes.js';
import type { OutgoingModeChange } from '../../../shared/channelModes.js';

interface VerbContext {
  userId: number;
  scope: string;
}

// One change as the caller hands it. Checked against the network's modeSpec:
// the letter must be one the network advertises, and a param must be present
// exactly when the mode takes one in that direction.
function checkChange(
  raw: unknown,
  known: (letter: string) => boolean,
  takesParam: (letter: string, sign: '+' | '-') => boolean,
): OutgoingModeChange | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'change-must-be-an-object' };
  const { sign, letter, param } = raw as Record<string, unknown>;
  if (sign !== '+' && sign !== '-') return { error: 'sign-must-be-plus-or-minus' };
  if (typeof letter !== 'string' || !/^[A-Za-z]$/.test(letter)) {
    return { error: 'letter-must-be-one-mode-letter' };
  }
  if (!known(letter)) return { error: `unknown-mode:${letter}` };
  const needs = takesParam(letter, sign);
  if (param == null || param === '') {
    // `-k` needs a param the caller rarely has; filled in below.
    if (needs && !(sign === '-' && letter === 'k')) return { error: `param-required:${letter}` };
    return { sign, letter };
  }
  if (!needs) return { error: `param-not-taken:${sign}${letter}` };
  // One IRC parameter: no spaces, no CR/LF, and no leading ':' (which would make
  // it the trailing parameter and swallow any after it).
  if (typeof param !== 'string' || /[\s\0]/.test(param) || param.startsWith(':')) {
    return { error: `param-malformed:${letter}` };
  }
  return { sign, letter, param };
}

registerVerb({
  name: 'set_channel_modes',
  description:
    "Change a channel's modes. `changes` is a list of { sign: '+' | '-', letter, param? }; a " +
    'param is required exactly when the mode takes one (a ban mask, a limit, a key) and refused ' +
    "otherwise. Letters are checked against the modes the network advertises. '-k' may omit its " +
    'param: the stored key is used, or `*`. Sent as the fewest MODE lines the network allows. ' +
    'Returns { ok: true, lines } once sent; the server may still refuse (e.g. 482 when you are not ' +
    'an operator), which lands in the channel as an error line. Errors: "not-connected", ' +
    '"no-changes", or a per-change code such as "unknown-mode:x" or "param-required:l".',
  scope: 'read-write',
  input: {
    type: 'object',
    properties: {
      networkId: { type: 'integer' },
      channel: { type: 'string', description: 'Channel name, e.g. "#foo".' },
      changes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            sign: { type: 'string', enum: ['+', '-'] },
            letter: { type: 'string' },
            param: { type: 'string' },
          },
          required: ['sign', 'letter'],
          additionalProperties: false,
        },
      },
    },
    required: ['networkId', 'channel', 'changes'],
    additionalProperties: false,
  },
  handler(ctx: VerbContext, input: Record<string, unknown>) {
    const networkId = Number(input.networkId);
    const channel = channelArg(input.channel);
    if ('error' in channel) return { ok: false, error: channel.error };
    if (!Array.isArray(input.changes)) return { ok: false, error: 'changes-must-be-an-array' };
    if (input.changes.length === 0) return { ok: false, error: 'no-changes' };
    const conn = writableConnection(ctx.userId, networkId);
    if (!conn) return { ok: false, error: 'not-connected' };
    const spec = conn.modeSpec();
    const known = (letter: string) =>
      spec.prefix.some((p) => p.mode === letter) ||
      [spec.list, spec.always, spec.onSet, spec.flags].some((group) => group.includes(letter));
    const name = conn.channelState(channel.value)?.name ?? channel.value;
    const changes: OutgoingModeChange[] = [];
    for (const raw of input.changes) {
      const change = checkChange(raw, known, (letter, sign) => modeTakesParam(spec, letter, sign));
      if ('error' in change) return { ok: false, error: change.error };
      // `-k` with the key we joined with, as irssi's /mode does (modes.c): an
      // ircu-family server refuses `-k` without the right one. `*` is what
      // everyone else accepts.
      if (change.sign === '-' && change.letter === 'k' && !change.param) {
        change.param = getBuffer(ctx.userId, networkId, name)?.key || '*';
      }
      changes.push(change);
    }
    const lines = batchModeLines(name, changes, spec.maxModes);
    for (const line of lines) conn.raw(line);
    return { ok: true, lines: lines.length };
  },
});
