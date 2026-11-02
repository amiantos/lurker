// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Would this raw line put cleartext on an E2E channel?
//
// Two doors hand a line the user wrote straight to IrcConnection.raw(): the MCP
// send_raw verb and the web client's `/quote` (wsHub 'raw'). Nothing on that path
// encrypts and nothing echoes, so a PRIVMSG to an encrypted channel leaks silently
// at both ends. Both doors ask here, so the answer is one answer.
//
// ⚠ The line is read the way the SERVER will read it, not as "the first two words"
// (#1116): past a tag block and a client-written `:prefix` (a server strips both),
// with the control characters raw() strips already gone, every target of a comma
// list, a STATUSMSG prefix (`@#chan` reaches the channel's ops) peeled off, and the
// channel matched by the network's case folding. Each of those was a way through.

import { parseLine } from '../bouncerClientFilter.js';
import { isChannelTarget } from '../../../shared/channels.js';
import { e2eManager } from './manager.js';

/** The verbs ircManager refuses in the clear on an E2E channel: a message, a notice
 *  (no encrypted form) and a TAGMSG (a reaction or typing). */
const CLEARTEXT_VERBS = new Set(['PRIVMSG', 'NOTICE', 'TAGMSG']);

/** STATUSMSG prefixes a server may take in front of a channel name. `+` and `&` are also
 *  channel sigils, so every reading of the leading run is tried (shared/channels.ts does the
 *  same for a DCC target). */
const STATUSMSG_PREFIXES = '~&@%+';

export interface CleartextLeak {
  /** The verb as the server will read it, upper-cased. */
  command: string;
  /** The E2E channel, spelled the way its config spells it. */
  channel: string;
}

/**
 * The E2E channel a raw `line` would deliver cleartext to, or null when it would not.
 * Never throws: a line that doesn't parse is not a PRIVMSG.
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
  for (const target of (msg.params[0] ?? '').split(',')) {
    for (let t = target; t; t = t.slice(1)) {
      if (isChannelTarget(t)) {
        const channel = e2eManager.enabledChannelMatching(userId, networkId, t);
        if (channel !== null) return { command: msg.command, channel };
      }
      if (!STATUSMSG_PREFIXES.includes(t[0])) break;
    }
  }
  return null;
}
