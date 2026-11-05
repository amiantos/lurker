// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { useIgnoresStore } from '../stores/ignores.js';
import { useRelayBotsStore } from '../stores/relayBots.js';
import { useNetworksStore } from '../stores/networks.js';
import { useRedactionsStore } from '../stores/redactions.js';
import { stripReplyAddress } from '../utils/replyText.js';
import type { QuotedLine, ReplyContext } from '../../../shared/replies.js';

// How a reply reads — its quote (ReplyQuote) and its own text — shared by the
// timeline (MessageList) and the out-of-buffer rows: search, activity,
// bookmarks (HistoryMessageRow, #998). One rule, so a reply reads the same
// wherever it turns up.
export function useReplyQuote() {
  const ignores = useIgnoresStore();
  const relayBots = useRelayBotsStore();
  const networks = useNetworksStore();
  const redactions = useRedactionsStore();

  // `line` is the reply as it displays (a relayed line already unwrapped).
  // `parent`: the answered line as the quote shows it — null for "unavailable",
  // which also covers a line from someone ignored since it arrived (the server
  // only screens out who was ignored at the time), judged as the line it was,
  // in the reply's buffer. `text`: the reply's own text, without the `alice: `
  // it opens with when the quote names her — how halloy and goguma send one,
  // so clients without replies still see who it's for. Only then: with the
  // quote unavailable, that address is the only sign of who it's to.
  //
  // A quoted line from a marked relay bot (#996) shows the person inside its
  // envelope — `<alice> hi`, not `<bridgebot> <alice> hi` — as the timeline shows
  // that line. The address may name either: our Reply addresses her, a client
  // that knows nothing of relay marks (halloy, goguma) the bot. The ignore check
  // comes first and judges the line as the bot's, again as the timeline judges
  // it, so a quote never hides a line its row would show, or shows one it would
  // hide.
  //
  // ⚠ Known gap: the parent's text is the server's excerpt (REPLY_EXCERPT_MAX).
  // A custom template with literal text AFTER `{message}` can't match a line
  // cut short, so a long line from such a bot is quoted as the bot's.
  function shownReply(
    replyTo: ReplyContext,
    line: { type?: string; text?: string | null },
    networkId: number | null | undefined,
    target: string,
  ): { parent: QuotedLine | null; text: string } {
    let parent: QuotedLine | null = replyTo.parent;
    if (
      parent &&
      !parent.self &&
      networkId != null &&
      ignores.isMessageHidden(networkId, { ...parent, target })
    ) {
      parent = null;
    }
    // The answered line deleted while this reply was on screen (#1013): the
    // quote copied its words into this row; the store knows they're gone.
    if (parent && !parent.redacted && redactions.get({ id: parent.id })) {
      parent = { ...parent, text: '', redacted: true };
    }
    const relayed = parent ? relayBots.unwrap(networkId, parent) : null;
    if (parent && relayed) {
      parent = {
        ...parent,
        nick: relayed.nick,
        text: relayed.text,
        // The stored `self` is the bot's line; the person is you when they
        // carry your nick on the line's network (a bridge echoing you back).
        self: networks.isOwnNick(networkId, relayed.nick),
        relayBot: parent.nick,
        relaySource: relayed.source,
      };
    }
    let text = line.text ?? '';
    if (parent && line.type === 'message') {
      const stripped = stripReplyAddress(text, parent.nick);
      text =
        stripped === text && parent.relayBot ? stripReplyAddress(text, parent.relayBot) : stripped;
    }
    return { parent, text };
  }

  return { shownReply };
}
