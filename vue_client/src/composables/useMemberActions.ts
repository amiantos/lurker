// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import type { ContextMenuItem } from './useContextMenu.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useNickNotesStore } from '../stores/nickNotes.js';
import { useFriendsStore } from '../stores/friends.js';
import { useWhoisStore } from '../stores/whois.js';
import { useContextMenu } from './useContextMenu.js';
import { socketSend } from './useSocket.js';
import { addressNick } from './useComposerOverlay.js';

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

// Modes that grant moderation power (kick/ban/voice). Halfop (h) counts here.
const MODERATE_MODES = ['q', 'a', 'o', 'h'];
// Modes that grant op management (+o/-o). Plain halfops usually can't op, so
// they're excluded — keeps the action off the menu rather than letting the
// server bounce it.
const OP_MODES = ['q', 'a', 'o'];

function hasAny(modes: string[], wanted: string[]): boolean {
  return wanted.some((m) => modes.includes(m));
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
  const nickNotes = useNickNotesStore();
  const friends = useFriendsStore();
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
      const isFriend = !!friends.contactForTarget(ctx.networkId, nick);
      items.push({
        label: isFriend ? 'Edit Friend…' : 'Add Friend…',
        icon: 'fa-solid fa-user-group',
        onClick: () => friends.openEditorForNick(ctx.networkId, nick),
      });
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
    const channel =
      typeof ctx.channel === 'string' && ctx.channel.startsWith('#') ? ctx.channel : null;
    const selfModes = Array.isArray(ctx.selfModes) ? ctx.selfModes : [];
    if (!isSelf && channel && hasAny(selfModes, MODERATE_MODES)) {
      const networkId = ctx.networkId;
      const targetModes = modesOf(member);
      const send = (l: string) => socketSend({ type: 'raw', networkId, line: l });
      const ch = channel;

      items.push({ divider: true });

      if (hasAny(selfModes, OP_MODES)) {
        const opped = targetModes.includes('o');
        items.push({
          label: opped ? 'Take Op' : 'Give Op',
          icon: 'fa-solid fa-shield-halved',
          onClick: () => send(`MODE ${ch} ${opped ? '-' : '+'}o ${nick}`),
        });
      }

      const voiced = targetModes.includes('v');
      items.push({
        label: voiced ? 'Remove Voice' : 'Give Voice',
        icon: voiced ? 'fa-solid fa-microphone-slash' : 'fa-solid fa-microphone',
        onClick: () => send(`MODE ${ch} ${voiced ? '-' : '+'}v ${nick}`),
      });

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

  function openMenuFor(
    member: MemberLike | string | null | undefined,
    ctx: MemberContext | null | undefined,
    x: number,
    y: number,
  ): void {
    const items = buildItems(member, ctx);
    if (items.length === 0) return;
    menu.open(items, x, y);
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
