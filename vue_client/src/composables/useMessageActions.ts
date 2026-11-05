// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import {
  BanIcon,
  BookmarkCheckIcon,
  BookmarkIcon,
  CopyIcon,
  CopyPlusIcon,
  FaceSlightlySmilingPlusIcon,
  LinkIcon,
  MessageSquareQuoteIcon,
  MessageSquareReplyIcon,
  TrashIcon,
} from '@lucide/vue';
import type { LucideIcon } from '@lucide/vue';
import type { ContextMenuItem } from './useContextMenu.js';
import { useBookmarksStore } from '../stores/bookmarks.js';
import { useReactionsStore } from '../stores/reactions.js';
import { useRedactionsStore } from '../stores/redactions.js';
import { socketSend } from './useSocket.js';
import type { Redaction } from '../../../shared/redaction.js';
import { tagSupport, useNetworksStore } from '../stores/networks.js';
import { isChannelTarget, isDccChatTarget } from '../../../shared/channels.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useContextMenu } from './useContextMenu.js';
import { copyQuoteFor } from '../utils/replyText.js';

export interface MessageLike {
  id?: number | null;
  nick?: string;
  text?: string;
  self?: boolean;
  userhost?: string;
  // Null on the app-scoped system buffer, which has no owning network — see the
  // bookmark gate in buildActions.
  networkId?: number | null;
  network_id?: number | null;
  // The buffer the line belongs to. Present on every real message row; the
  // fallback for resolving the buffer id "Copy link" addresses.
  target?: string;
  // buffers(id), as it rides on the server's message events — the direct
  // answer, when the row came from the server rather than being minted here.
  bufferId?: number;
  // The server's IRCv3 msgid — what a reaction replies to. Absent on networks
  // without message-tags and on lines sent before echo-message stamped them.
  msgid?: string;
  // An end-to-end encrypted line; reactions are cleartext tags, so none here.
  e2e?: boolean;
  // message / action / notice / … — only the first two can be reacted to.
  type?: string;
  // The line was deleted (#1013): nothing to copy, quote, answer or react to.
  // The row's own field; the live overlay is asked too (useRedactionsStore).
  redaction?: Redaction;
}

// Whether the Reply action can make a real reply of this line: it needs the
// msgid the reply names, and a channel or DM to send it in. Not an E2E line —
// the server sends no reply tags on an encrypted channel — and not the
// :server: console or a =nick DCC chat, which aren't IRC targets. The server
// re-checks all of it (replySendMsgid); this only decides what the action does.
export function replyable(m: MessageLike): boolean {
  return (
    m.id != null &&
    !!m.msgid &&
    !m.e2e &&
    (m.type === 'message' || m.type === 'action' || m.type === 'notice') &&
    !!m.target &&
    !m.target.startsWith(':') &&
    !isDccChatTarget(m.target)
  );
}

// A DM or a DCC chat: the line goes to the one other person anyway, so a Reply
// there puts no `nick: ` in the draft (#1015; halloy skips it in queries too).
// Like Reply to yourself, it's then only offered where a real reply goes out.
export function privateTarget(target: string | null | undefined): boolean {
  return !!target && !isChannelTarget(target) && !target.startsWith(':');
}

// Whether the network is up and can carry reply tags right now (canReply,
// #1101). Independent of reactions: irc.so takes a reply tag but not
// +draft/unreact, and a network without echo-message takes replies but no
// reactions at all.
export function replyTagsGoOut(networkId: number | null | undefined): boolean {
  if (networkId == null) return false;
  return tagSupport(useNetworksStore().states[networkId]).reply;
}

// Whether the network is up and can carry a reaction right now (canReact).
export function reactionsGoOut(networkId: number | null | undefined): boolean {
  if (networkId == null) return false;
  return tagSupport(useNetworksStore().states[networkId]).react;
}

export function redactionsGoOut(networkId: number | null | undefined): boolean {
  if (networkId == null) return false;
  return tagSupport(useNetworksStore().states[networkId]).redact;
}

// Whether Delete is offered on this line (#1013): a line a REDACT could name
// (replyable: a msgid, in a channel or DM), on a network that negotiated the
// cap, and one of ours — or anyone's in a channel where we hold a prefix mode,
// which is who ergo lets delete. The network has the last word (a FAIL); this
// only keeps the action off lines where it could do nothing.
export function deletable(m: MessageLike): boolean {
  if (!replyable(m) || m.redaction) return false;
  const networkId = m.networkId ?? m.network_id;
  if (!redactionsGoOut(networkId)) return false;
  if (m.self) return true;
  if (!m.target || !isChannelTarget(m.target) || networkId == null) return false;
  const networks = useNetworksStore();
  const own = networks.states[networkId]?.nick;
  if (!own) return false;
  const members = useBuffersStore().findByTarget(networkId, m.target)?.members ?? [];
  const me = members.find((x) => x.nick.toLowerCase() === own.toLowerCase());
  return !!me && me.modes.length > 0;
}

export interface MessageContext {
  networkId: number;
  onReply(message: MessageLike): void;
  onQuote(message: MessageLike): void;
  onIgnore(message: MessageLike): void;
}

export type MessageActionKey =
  | 'reply'
  | 'quote'
  | 'react'
  | 'copy'
  | 'copyQuote'
  | 'link'
  | 'save'
  | 'delete'
  | 'ignore';

export interface MessageAction {
  key: MessageActionKey;
  // Tooltip + accessible label for the icon button.
  label: string;
  // Lucide icon component for the button glyph.
  icon: LucideIcon;
  // Toggles the "lit" treatment — currently only the bookmark when saved.
  active?: boolean;
}

export interface MessageActionsAPI {
  buildActions(message: MessageLike | null | undefined): MessageAction[];
  run(key: MessageActionKey, message: MessageLike, ctx: MessageContext): void;
  // The same actions rendered as ContextMenuItem[] for the right-click / tap
  // menu (#392). Derived from buildActions so the bar and the menu can't drift.
  buildItems(
    message: MessageLike | null | undefined,
    ctx: MessageContext,
    opts?: MessageActionOptions,
  ): ContextMenuItem[];
  // Open the shared context menu at a viewport point for this message.
  openMenu(
    message: MessageLike | null | undefined,
    ctx: MessageContext,
    x: number,
    y: number,
    triggerEl?: Element | null,
    opts?: MessageActionOptions,
  ): void;
}

export interface MessageActionOptions {
  // Actions a surface doesn't offer — the thread panel leaves Quote out, since
  // a send from there already carries a reply tag (#1225). By key, so the bar
  // and the menu drop the same thing however it's labelled.
  exclude?: readonly MessageActionKey[];
}

// Single source of truth for the per-message actions rendered as the hover
// action bar in MessageList (issue #117 — replaced the kebab + context menu).
//
// buildActions() returns plain descriptors (no per-row handler closures) so
// the bar — re-evaluated for up to MAX_PER_BUFFER rows on every render — stays
// allocation-light; clicks are dispatched through run() with a context the
// caller builds once. The caller owns the component-local UI for the ignore
// confirmation (mirrors useMemberActions) and the reply hand-off to the
// composer, supplying both via that context.
//
// `message` shape: { id, nick, text, self, userhost, network_id|networkId, ... }
// `context` shape: { networkId, onReply(message), onQuote(message), onIgnore(message) }
export function useMessageActions(): MessageActionsAPI {
  const bookmarks = useBookmarksStore();
  const reactions = useReactionsStore();
  const buffers = useBuffersStore();
  const menu = useContextMenu();

  // Absolute permalink to one message, or null when the line can't have one.
  // The buffer route addresses by server id (#744), so this needs the message's
  // id AND its buffer's — and it deliberately refuses the two kinds of line a
  // link couldn't actually land on:
  //
  //   - app-scoped system lines (networkId null), which have no buffer route
  //     that a per-message jump accepts
  //   - `:server:` consoles, which useJumpToMessage rejects outright ("Cannot
  //     jump in server buffer") — a link there would open the buffer and then
  //     toast at the user instead of scrolling
  //
  // Prefers the id the row already carries — server message events ship
  // `bufferId` and the store keeps the event object whole, so the usual case
  // needs no lookup at all. That matters because buildActions runs for EVERY
  // rendered row (up to MAX_PER_BUFFER of them) on every re-render, and
  // findByTarget's exact-key fast path degrades to an O(buffers) folded scan
  // whenever the message's server-cased target differs from the buffer key —
  // the #327 case — which would make it O(rows x buffers) per render.
  // findByTarget stays as the fallback for rows minted locally.
  //
  // Split in two — linkBufferId answers "can this line link, and to which
  // buffer", messageLink formats the URL — so buildActions' per-row
  // eligibility test stays allocation-free: building the string just to test
  // truthiness was waste at that call frequency.
  function linkBufferId(message: MessageLike): number | null {
    const networkId = message.networkId ?? message.network_id;
    if (message.id == null || networkId == null) return null;
    if (!message.target || message.target.startsWith(':server:')) return null;
    const bufferId =
      typeof message.bufferId === 'number'
        ? message.bufferId
        : buffers.findByTarget(networkId, message.target)?.id;
    return bufferId ?? null;
  }

  function messageLink(message: MessageLike): string | null {
    const bufferId = linkBufferId(message);
    if (bufferId == null) return null;
    return `${window.location.origin}/buffer/${bufferId}?msg=${message.id}`;
  }

  // What Copy quote copies: the line as Quote would put it above the draft,
  // without the `> ` — a /me reads `* bob waves`, a spoiler stays `||…||`.
  function copyQuoteText(message: MessageLike): string {
    return copyQuoteFor({
      nick: message.nick ?? '',
      type: message.type,
      text: message.text ?? '',
    });
  }

  function buildActions(message: MessageLike | null | undefined): MessageAction[] {
    if (!message) return [];
    const actions: MessageAction[] = [];
    // A deleted line (#1013) has no words: nothing to react to, answer, quote
    // or copy. Its link and bookmark still point at the placeholder.
    const redaction = useRedactionsStore().get(message);
    if (redaction && !message.redaction) message = { ...message, redaction, text: '' };

    // A reaction replies to the line's msgid, so it needs a line a reply could
    // name, on a network that can carry it (canReact — see the server's
    // canSendReactions). Not a notice — the server's reactionSendTarget says
    // why. It re-checks all of this; the gate just keeps a button off lines
    // where it could only do nothing. First in the bar and the menu, where
    // Discord and Slack put it: the action people reach for most.
    if (
      replyable(message) &&
      !message.redaction &&
      message.type !== 'notice' &&
      reactionsGoOut(message.networkId ?? message.network_id)
    ) {
      actions.push({ key: 'react', label: 'React', icon: FaceSlightlySmilingPlusIcon });
    }

    // Ignore addresses another user: pointless on your own line, and the server
    // uses the hostmask for delivery, not ignore filtering.
    const addressable = !message.self && !!message.nick;

    const tagsGoOut = replyTagsGoOut(message.networkId ?? message.network_id);

    // Reply to someone else in a channel always does something — at the least it
    // addresses them, and the address is what a line without its reply tag still
    // says. On your own line (#997, "to clarify what I said above") or in a DM
    // (privateTarget) there's no address, so the reply tag is all it is, and it's
    // offered only where one would go out.
    const unaddressed = !!message.self || privateTarget(message.target);
    if (message.redaction) {
      // No reply to a deleted line: addressing its author with nothing to
      // answer is the one thing Reply would still do.
    } else if (addressable && !unaddressed) {
      actions.push({
        key: 'reply',
        label: `Reply to ${message.nick}`,
        icon: MessageSquareReplyIcon,
      });
    } else if (unaddressed && message.nick && replyable(message) && tagsGoOut) {
      const label = message.self ? 'Reply to yourself' : `Reply to ${message.nick}`;
      actions.push({ key: 'reply', label, icon: MessageSquareReplyIcon });
    }

    // Quote (#1119) is Reply's plain-text sibling: `> <nick> text` above the
    // draft, for the people on clients that never see a reply tag. It needs no
    // network and no msgid — only words to quote — so it's offered on your own
    // lines and in DMs too, and on a line a Reply can't take.
    //
    // MessageList hands over the row as displayed, so a relayed line already
    // names the person inside its envelope. Unwrapping it again would misread a
    // bridge's reply whose address was stripped to leave `<bob> hi`.
    if (message.nick && message.text) {
      actions.push({
        key: 'quote',
        label: `Quote ${message.nick}`,
        icon: MessageSquareQuoteIcon,
      });
    }

    if (message.text) {
      actions.push({ key: 'copy', label: 'Copy text', icon: CopyIcon });
    }

    // Copy quote (#1218): the same text with its author in front, `<bob> hi`,
    // for quoting by hand or pasting somewhere else.
    if (message.nick && message.text) {
      actions.push({ key: 'copyQuote', label: 'Copy quote', icon: CopyPlusIcon });
    }

    // Sits with the two copies because it's the other "take this away with you"
    // action: a permalink to bookmark, or to open in a new window.
    if (linkBufferId(message) != null) {
      actions.push({ key: 'link', label: 'Copy link to message', icon: LinkIcon });
    }

    // Bookmarks need a stable server id AND an owning network.
    //
    // The network gate is not cosmetic. Bookmarking is ownership-checked by
    // joining the message to its network (db/bookmarks.ts), so a system-buffer
    // line — `networkId: null`, app-scoped — can never be saved: the insert
    // writes nothing and the server sends no echo back. Offering "Save message"
    // there was a button that did nothing, forever, with no feedback.
    //
    // It also closes a mislabel. System lines come from their own table with
    // their own id sequence (`systemLineToEvent`), so system line #42 and
    // message #42 coexist; asking `isSaved(42)` for the former would light up
    // "Remove bookmark" on a line nobody ever saved.
    const networkId = message.networkId ?? message.network_id;
    if (message.id != null && networkId != null) {
      const saved = bookmarks.isSaved(message.id);
      actions.push({
        key: 'save',
        label: saved ? 'Remove bookmark' : 'Save message',
        icon: saved ? BookmarkCheckIcon : BookmarkIcon,
        active: saved,
      });
    }

    // Delete (#1013): a REDACT to the network, which answers with the
    // deletion or a refusal. Last among the line's own actions, before the
    // one that addresses its author.
    if (deletable(message)) {
      actions.push({ key: 'delete', label: 'Delete message', icon: TrashIcon });
    }

    if (addressable) {
      actions.push({ key: 'ignore', label: `Ignore ${message.nick}…`, icon: BanIcon });
    }

    return actions;
  }

  function run(key: MessageActionKey, message: MessageLike, ctx: MessageContext): void {
    switch (key) {
      case 'reply':
        ctx.onReply(message);
        break;
      case 'quote':
        ctx.onQuote(message);
        break;
      case 'react':
        reactions.openPicker({
          id: message.id,
          networkId: message.networkId ?? message.network_id ?? null,
          nick: message.nick,
          text: message.text,
        });
        break;
      case 'copy':
        if (navigator.clipboard) {
          navigator.clipboard.writeText(String(message.text || '')).catch(() => {});
        }
        break;
      case 'copyQuote':
        if (navigator.clipboard) {
          navigator.clipboard.writeText(copyQuoteText(message)).catch(() => {});
        }
        break;
      case 'link': {
        // Fire-and-forget with no tick, matching its neighbour above — the
        // action bar renders stateless descriptors, and useCopyFeedback calls
        // out the copy-message action as deliberately not that shape.
        const url = messageLink(message);
        if (url && navigator.clipboard) navigator.clipboard.writeText(url).catch(() => {});
        break;
      }
      case 'save':
        bookmarks.toggle(message);
        break;
      case 'delete':
        // Not undoable, so one confirm. Nothing changes here: the line blanks
        // when the network's REDACT comes back (a `message-redacted` frame),
        // and a refusal lands in the buffer as an error line.
        if (message.id == null) break;
        if (!window.confirm("Delete this message? This can't be undone.")) break;
        socketSend({ type: 'redact', messageId: Number(message.id) });
        break;
      case 'ignore':
        ctx.onIgnore(message);
        break;
    }
  }

  // Map the descriptor list to context-menu items. Each item dispatches back
  // through run() with the caller's context, so the menu shares the bar's exact
  // side effects (reply hand-off, clipboard, bookmark toggle, ignore modal).
  function buildItems(
    message: MessageLike | null | undefined,
    ctx: MessageContext,
    opts: MessageActionOptions = {},
  ): ContextMenuItem[] {
    if (!message) return [];
    const excluded = opts.exclude ?? [];
    return buildActions(message)
      .filter((a) => !excluded.includes(a.key))
      .map((a) => ({
        label: a.label,
        icon: a.icon,
        // The menu stays open while state moves on, so Save/Remove does what its
        // label said, not the opposite of whatever is true at the tap (#1136).
        onClick:
          a.key === 'save'
            ? () => bookmarks.setSaved(message, !a.active)
            : () => run(a.key, message, ctx),
      }));
  }

  function openMenu(
    message: MessageLike | null | undefined,
    ctx: MessageContext,
    x: number,
    y: number,
    triggerEl: Element | null = null,
    opts: MessageActionOptions = {},
  ): void {
    if (!message) return;
    const items = buildItems(message, ctx, opts);
    if (items.length === 0) return;
    menu.open(items, x, y, triggerEl);
  }

  return { buildActions, run, buildItems, openMenu };
}
