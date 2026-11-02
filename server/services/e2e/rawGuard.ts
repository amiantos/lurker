// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Would this raw line put cleartext on an E2E channel?
//
// Three doors hand a line the user wrote straight to IrcConnection.raw(): the MCP
// send_raw verb, the web client's `/quote` (wsHub 'raw') and a network's connect
// commands. Nothing on that path encrypts and nothing echoes, so a PRIVMSG to an
// encrypted channel leaks silently at both ends. Every door asks here, so the
// answer is one answer.
//
// ⚠ The line is read the way the SERVER will read it, not as "the first two words"
// (#1116): past a tag block and a client-written `:prefix` (a server strips both),
// on ASCII spaces alone, with the control characters raw() strips already gone,
// every target of a comma list, a STATUSMSG prefix (`@#chan` reaches the channel's
// ops) peeled off, and the channel matched by the network's case folding. Each of
// those was a way through.
//
// ⚠ Fails CLOSED: if the keyring can't be read, the line is refused, not sent. The
// encrypting path (e2eManager.checkOutgoing) lets the same error stop the send.

import { parseLine } from '../bouncerClientFilter.js';
import { channelReadings } from '../../../shared/channels.js';
import { foldTargetFor } from '../../db/buffers.js';
import { e2eManager } from './manager.js';

/** The verbs ircManager refuses in the clear on an E2E channel: a message, a notice
 *  (no encrypted form) and a TAGMSG (a reaction or typing). */
const CLEARTEXT_VERBS = new Set(['PRIVMSG', 'NOTICE', 'TAGMSG']);

export interface CleartextLeak {
  /** The verb as the server will read it, upper-cased. */
  command: string;
  /** The E2E channel, spelled the way its config spells it. */
  channel: string;
}

/**
 * The E2E channel a raw `line` would deliver cleartext to, or null when it would not.
 * Never throws: a line that doesn't parse is not a PRIVMSG, and a keyring that can't
 * be read is a refusal.
 */
export function cleartextE2eLeak(
  userId: number,
  networkId: number,
  line: string,
): CleartextLeak | null {
  // What raw() will actually write, so a NUL inside the verb can't hide it.
  // eslint-disable-next-line no-control-regex
  const msg = parseLine(line.replace(/[\u000d\u000a\u0000]/g, '').replace(/^ +/, ''));
  if (!msg || !CLEARTEXT_VERBS.has(msg.command)) return null;
  const targets = (msg.params[0] ?? '').split(',');
  let enabled: Map<string, string>;
  try {
    enabled = e2eManager.enabledChannelsByFold(userId, networkId);
  } catch (err) {
    console.warn(`e2e raw guard: refusing ${msg.command}, keyring unreadable: ${String(err)}`);
    const channel = targets.flatMap(channelReadings)[0] ?? targets[0];
    return { command: msg.command, channel };
  }
  for (const target of targets) {
    for (const reading of channelReadings(target)) {
      const channel = enabled.get(foldTargetFor(networkId, reading));
      if (channel !== undefined) return { command: msg.command, channel };
    }
  }
  return null;
}
