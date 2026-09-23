// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import type { ContextMenuItem } from './useContextMenu.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useFavoritesStore } from '../stores/favorites.js';
import { useNickNotesStore } from '../stores/nickNotes.js';
import { useWhoisStore } from '../stores/whois.js';
import { useContextMenu } from './useContextMenu.js';
import { socketSend } from './useSocket.js';
import { historyCountBy } from '../lib/historyPaging.js';
import { addressNick } from './useComposerOverlay.js';
import { isChannelTarget } from '../../../shared/channels.js';
import { DEFAULT_PREFIX, hasRankAtLeast } from '../../../shared/channelModes.js';
import { useNetworksStore } from '../stores/networks.js';

export interface MemberLike {
  nick: string;
  modes?: string[];
  away?: boolean;
  user?: string | null;
  host?: string | null;
}

export interface MemberContext {
  networkId: number;
  isSelf(member: MemberLike | string): boolean;
  onIgnore(member: MemberLike | string): void;
  // Channel-operator wiring. When `channel` is a channel target and the
  // current user holds an op-ish mode in it (`selfModes`), buildItems appends
  // kick/ban/op/voice actions. Both optional so non-channel callers (or any
  // future caller that doesn't supply them) simply get the base menu.
  channel?: string | null;
  selfModes?: string[];
}

export interface MemberActionsAPI {
  buildItems(
    member: MemberLike | string | null | undefined,
    ctx: MemberContext | null | undefined,
  ): ContextMenuItem[];
  openMenuFor(
    member: MemberLike | string | null | undefined,
    ctx: MemberContext | null | undefined,
    x: number,
    y: number,
    triggerEl?: Element | null,
  ): void;
  openMenuFromButton(
    member: MemberLike | string | null | undefined,
    ctx: MemberContext | null | undefined,
    buttonEl: Element | null,
  ): void;
}

function nickOf(m: MemberLike | string): string {
  return typeof m === 'string' ? m : m.nick;
}

function modesOf(m: MemberLike | string): string[] {
  return typeof m === 'string' || !Array.isArray(m.modes) ? [] : m.modes;
}

// Host ban by default (*!*@host). Falls back to a nick mask only when the
// host isn't known yet — channel members normally have it backfilled from the
// WHO issued on join, the same source the Ignore modal relies on.
function maskFor(member: MemberLike | string): string {
  const host = typeof member === 'string' ? null : member.host;
  return host ? `*!*@${host}` : `${nickOf(member)}!*@*`;
}

// Optional kick reason. null = the operator cancelled (abort the action);
// '' = no reason (send a bare KICK).
function promptKickReason(): string | null {
  const r = window.prompt('Kick reason (optional):', '');
  return r === null ? null : r.trim();
}

function kickLine(channel: string, nick: string, reason: string): string {
  return reason ? `KICK ${channel} ${nick} :${reason}` : `KICK ${channel} ${nick}`;
}

// Shared menu items for a member of a channel. Exposed as a composable so
// right-click, row-tap (mobile), and the hover three-dots (desktop) all
// surface the same actions. The caller owns side-effect state that needs
// component-local UI (like the ignore modal) and passes those callbacks in.
//
// `member` is the raw member object (or string) from buffer.members.
// `context` shape:
//   { networkId, isSelf(member), onIgnore(member) }
export function useMemberActions(): MemberActionsAPI {
  const buffers = useBuffersStore();
  const favorites = useFavoritesStore();
  const nickNotes = useNickNotesStore();
  const whois = useWhoisStore();
  const menu = useContextMenu();

  function buildItems(
    member: MemberLike | string | null | undefined,
    ctx: MemberContext | null | undefined,
  ): ContextMenuItem[] {
    if (!member || !ctx) return [];
    const nick = nickOf(member);
    const isSelf = ctx.isSelf(member);
    const hasNote = nickNotes.hasNote(ctx.networkId, nick);
    // Self gets a trimmed menu: you can view your own profile and note yourself,
    // but Reply, Send DM, Ignore, and the moderation actions are all meaningless
    // or nonsensical aimed at yourself, so they're left off below.
    const items: ContextMenuItem[] = [];
    // Reply addresses the speaker in the active composer — the same composer
    // hand-off as the message action bar's Reply.
    if (!isSelf) {
      items.push({
        label: `Reply to ${nick}`,
        icon: 'fa-solid fa-reply',
        onClick: () => addressNick(nick),
      });
    }
    items.push({
      label: 'Copy Nickname',
      icon: 'fa-regular fa-copy',
      // Best-effort: writeText rejects without clipboard permission or in an
      // insecure context, and the API can be absent on older browsers.
      onClick: () => {
        navigator.clipboard?.writeText(nick).catch(() => {});
      },
    });
    items.push({ divider: true });
    items.push({
      label: 'View Profile…',
      icon: 'fa-solid fa-id-card',
      onClick: () => whois.openViewer(ctx.networkId, nick),
    });
    if (!isSelf) {
      items.push({
        label: 'Send DM',
        icon: 'fa-solid fa-envelope',
        onClick: () => buffers.activate(ctx.networkId, nick),
      });
    }
    items.push({
      label: hasNote ? 'Edit Note…' : 'Add Note…',
      icon: 'fa-solid fa-note-sticky',
      onClick: () => nickNotes.openEditor(ctx.networkId, nick),
    });
    if (!isSelf) {
      const isFriend = favorites.isFavorite(ctx.networkId, nick);
      items.push(
        isFriend
          ? {
              label: 'Remove from Friends',
              icon: 'fa-solid fa-user-minus',
              onClick: () => favorites.unfavorite(ctx.networkId, nick),
            }
          : {
              label: 'Add to Friends',
              icon: 'fa-solid fa-user-group',
              // Favoriting requires an OPEN buffer (a closed one is refused —
              // the stale-tab orphan guard), and this member may have no DM
              // yet. open-buffer mints/reopens the row without stealing focus,
              // and the same socket delivers it before the favorite, so the
              // favorite always lands. No client-side ordering to get wrong.
              onClick: () => {
                // countBy matches the store's openBuffer seam — without it
                // the server sizes the first backlog slice in 'event' units
                // even for users paging by renderable lines.
                socketSend({
                  type: 'open-buffer',
                  networkId: ctx.networkId,
                  target: nick,
                  countBy: historyCountBy(),
                });
                favorites.favorite(ctx.networkId, nick);
              },
            },
      );
      items.push({
        label: 'Ignore…',
        icon: 'fa-solid fa-ban',
        onClick: () => ctx.onIgnore(member),
      });
    }

    // Channel-operator actions, gated on the current user's own modes in this
    // channel. Each sends a raw IRC line and lets the server's MODE/KICK echo
    // update state — the same path the /kick and /mode slash commands use, so
    // no optimistic mutation here. Never offered against yourself.
    // ⚠ `typeof` first, not a cast. `isChannelTarget` deliberately returns a plain boolean rather
    // than a `target is string` predicate (see shared/channels.ts), so it cannot narrow
    // `string | null | undefined` on its own — and casting to satisfy that would let a non-string
    // through unchecked. This is the guard the pre-#724 code already had; keep it.
    const channel =
      typeof ctx.channel === 'string' && isChannelTarget(ctx.channel) ? ctx.channel : null;
    const selfModes = Array.isArray(ctx.selfModes) ? ctx.selfModes : [];
    // Ranked by the network's own PREFIX, so an owner, an admin, or a rank
    // with a letter we've never heard of all pass on standing, not spelling.
    const prefix = useNetworksStore().states[ctx.networkId]?.modeSpec?.prefix ?? DEFAULT_PREFIX;
    // Halfop and up moderate (kick/ban/voice); on a network without halfops
    // that rounds up to op.
    if (!isSelf && channel && hasRankAtLeast(selfModes, prefix, 'h')) {
      const networkId = ctx.networkId;
      const targetModes = modesOf(member);
      const send = (l: string) => socketSend({ type: 'raw', networkId, line: l });
      const ch = channel;

      items.push({ divider: true });

      // Plain halfops usually can't op, so op management starts at op — keeps
      // the action off the menu rather than letting the server bounce it.
      const hasMode = (letter: string) => prefix.some((p) => p.mode === letter);
      if (hasMode('o') && hasRankAtLeast(selfModes, prefix, 'o')) {
        const opped = targetModes.includes('o');
        items.push({
          label: opped ? 'Take Op' : 'Give Op',
          icon: 'fa-solid fa-shield-halved',
          onClick: () => send(`MODE ${ch} ${opped ? '-' : '+'}o ${nick}`),
        });
      }

      const voiced = targetModes.includes('v');
      if (hasMode('v')) {
        items.push({
          label: voiced ? 'Remove Voice' : 'Give Voice',
          icon: voiced ? 'fa-solid fa-microphone-slash' : 'fa-solid fa-microphone',
          onClick: () => send(`MODE ${ch} ${voiced ? '-' : '+'}v ${nick}`),
        });
      }

      items.push({
        label: 'Kick…',
        icon: 'fa-solid fa-user-slash',
        onClick: () => {
          const reason = promptKickReason();
          if (reason === null) return;
          send(kickLine(ch, nick, reason));
        },
      });

      items.push({
        label: 'Ban',
        icon: 'fa-solid fa-gavel',
        onClick: () => send(`MODE ${ch} +b ${maskFor(member)}`),
      });

      items.push({
        label: 'Kick + Ban…',
        icon: 'fa-solid fa-user-lock',
        onClick: () => {
          const reason = promptKickReason();
          if (reason === null) return;
          // Ban before kick so the target can't rejoin in the gap.
          send(`MODE ${ch} +b ${maskFor(member)}`);
          send(kickLine(ch, nick, reason));
        },
      });
    }

    return items;
  }

  // Cursor-positioned menu (left-click a name, or right-click). Pass triggerEl
  // for a left-click so re-clicking the same element toggles the menu closed,
  // matching the kebab buttons; omit it for right-click, which repositions.
  function openMenuFor(
    member: MemberLike | string | null | undefined,
    ctx: MemberContext | null | undefined,
    x: number,
    y: number,
    triggerEl: Element | null = null,
  ): void {
    const items = buildItems(member, ctx);
    if (items.length === 0) return;
    menu.open(items, x, y, triggerEl);
  }

  // Hand buttonEl to useContextMenu so re-clicking the same trigger toggles
  // the menu closed instead of letting the click-outside listener close and
  // the trigger's own handler reopen on the same gesture.
  function openMenuFromButton(
    member: MemberLike | string | null | undefined,
    ctx: MemberContext | null | undefined,
    buttonEl: Element | null,
  ): void {
    if (!buttonEl) return;
    const items = buildItems(member, ctx);
    if (items.length === 0) return;
    const rect = buttonEl.getBoundingClientRect();
    menu.open(items, rect.left, rect.bottom + 2, buttonEl);
  }

  return { buildItems, openMenuFor, openMenuFromButton };
}
