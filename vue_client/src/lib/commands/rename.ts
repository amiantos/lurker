// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// `/rename`: rename a channel (IRCv3 draft/channel-rename, #858). Pure so it
// unit-tests outside the Vue SFC, like the other command helpers.

import { isChannelTarget } from '../../../../shared/channels.js';

export const RENAME_USAGE = 'usage: /rename [#chan] <#newname> [reason]';

export type RenameCommand = { line: string } | { error: string };

/**
 * The RENAME line for the words after `/rename`, typed in the buffer `target`.
 *
 *   /rename #new [reason]          rename the channel this was typed in
 *   /rename #old #new [reason]     rename another one, from anywhere
 *
 * It is the second form only when the first word is a channel the user has a
 * buffer for (`hasBuffer`) and the second is a channel name. The second word
 * is also where a reason starts, and `+1 clearer` or `!!! cleanup` begin with
 * a channel sigil: read as a name, the line would rename some other channel
 * to `+1`. A channel one can rename is one they are in, so asking for the
 * buffer costs nothing. A channel is any of the four sigils (shared/channels).
 */
export function parseRename(
  rest: readonly string[],
  target: string,
  hasBuffer: (name: string) => boolean,
): RenameCommand {
  let from: string;
  let to: string | undefined;
  let reason: string;
  if (isChannelTarget(rest[0]) && isChannelTarget(rest[1]) && hasBuffer(rest[0])) {
    from = rest[0];
    to = rest[1];
    reason = rest.slice(2).join(' ');
  } else {
    from = target;
    to = rest[0];
    reason = rest.slice(1).join(' ');
  }
  if (!to) return { error: RENAME_USAGE };
  if (!isChannelTarget(to)) {
    return { error: `${RENAME_USAGE} — ${to} is not a channel name` };
  }
  if (!isChannelTarget(from)) {
    return { error: `${RENAME_USAGE} — name the channel, or run it inside one` };
  }
  // A comma would make the name a list on the wire.
  if (to.includes(',') || from.includes(',')) {
    return { error: `${RENAME_USAGE} — a channel name cannot hold a comma` };
  }
  return { line: `RENAME ${from} ${to}${reason ? ` :${reason}` : ''}` };
}
