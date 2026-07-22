// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Drives in-client notifications: a toast in the corner and an optional sound.
// Called from useSocket whenever an IRC message arrives. The server sets the
// authoritative `notify` flag — the highlight/DM/notify-always union with the
// ignore/mute veto already folded in (wsHub.decorateMessage) — so we gate on
// that one flag rather than re-deriving the ignore verdict here. The raw
// content signals (matched, dm, notifyAlways) still ride alongside it and pick
// the toast kind: each kind has its own master `enabled` toggle and sound
// sub-toggle, so toast/sound delivery is decoupled from how the signal was
// generated. Settings are read live so quick-toggles take effect at once.
//
// The in-app toast + sound fire only for a visible tab when the event's
// buffer isn't the one on screen — see shouldNotifyInApp for the three cases
// that suppress them.

import { useToastsStore, type ToastKind } from '../stores/toasts.js';
import { useSettingsStore } from '../stores/settings.js';
import { useNetworksStore } from '../stores/networks.js';
import { viewedBuffer } from './useViewedBuffer.js';
import { META_SEPARATOR } from '../utils/metaLine.js';
import { stripFormatting } from '../../../shared/textMatch.js';

export interface NotifyEvent {
  self?: boolean;
  // Server's authoritative "alert the user" verdict: the content-signal union
  // (matched/dm/notifyAlways) with the ignore/mute veto (hide + NONOTIFY)
  // already applied. A NOHIGHLIGHT rule is display-only and does NOT clear it.
  notify?: boolean;
  dm?: boolean;
  matched?: boolean;
  notifyAlways?: boolean;
  nick?: string;
  networkId?: number;
  userhost?: string;
  target?: string;
  text?: string;
  type?: string;
  id?: number;
}

// Cached templates, one per sound choice. Used purely to preload the file
// once per choice; we never play the template itself. Each actual play
// clones the template (see playSound) so it gets its own state machine.
const audioTemplates = new Map<string, HTMLAudioElement>();

function getTemplate(choice: string): HTMLAudioElement {
  let el = audioTemplates.get(choice);
  if (!el) {
    el = new Audio(`/sounds/${choice}.mp3`);
    el.preload = 'auto';
    audioTemplates.set(choice, el);
  }
  return el;
}

// Signal kind in priority order: DM > matched > always-notify. A DM that
// also happens to match a highlight rule is treated as a DM (single
// notification, gated by the DM master toggle), so users don't get
// double-fired or surprised by the wrong sound.
function pickKindKey(event: NotifyEvent): ToastKind | null {
  if (event.dm) return 'dm';
  if (event.matched) return 'highlight';
  if (event.notifyAlways) return 'always_notify';
  return null;
}

// Per-source notification throttle. A burst from one sender — the classic
// case is ChanServ answering /HELP with a dozen back-to-back NOTICEs — should
// land as a single toast + sound rather than a wall of them. Once a source
// notifies, repeats from that same source within this window are dropped
// outright (no queue). The key is per network + buffer + nick + kind, so
// distinct senders are unaffected: two people pinging you still both fire.
const NOTIFY_THROTTLE_MS = 3000;
const lastNotifyAt = new Map<string, number>();

function throttled(event: NotifyEvent, kind: ToastKind): boolean {
  const key = `${event.networkId}::${event.target ?? ''}::${event.nick ?? '?'}::${kind}`;
  const now = Date.now();
  const prev = lastNotifyAt.get(key);
  if (prev !== undefined && now - prev < NOTIFY_THROTTLE_MS) return true;
  lastNotifyAt.set(key, now);
  return false;
}

// The in-app toast + sound only reach a user whose tab is in the foreground
// and not already looking at the buffer the event belongs to. Three things
// suppress them:
//
//   - No document: a non-browser context (SSR, tests) has no DOM to render a
//     toast into, so this returns false — matching usePresence.currentVisible().
//   - Tab hidden: a hidden tab can't render a toast, and browsers throttle or
//     defer a background tab's audio — so this path would fire unreliably (the
//     toast/sound only "catch up" when the tab is refocused). The server-side
//     push owns the hidden case: wsHub.maybePush fires precisely when the user
//     has no visible client. Letting the in-app path fire here too would just
//     double up with push, badly. Visibility is the Page Visibility API — the
//     same signal usePresence reports to the server — so the in-app and push
//     paths agree on "present" and never both fire for one event.
//   - Viewed buffer: the event's buffer is the one whose message list is on
//     screen right now, so the message is already materializing in plain view
//     and a toast would be redundant (issue #50) — Discord and Slack mute the
//     focused channel the same way.
//
// "Viewed buffer" is viewedBuffer(), owned by MessageList — NOT networks
// .activeKey. activeKey only tracks the last-opened buffer and lingers across
// route / mobile-screen changes, so keying off it would wrongly suppress a
// toast while the user sits on the Settings route or the mobile buffer list,
// where no message list is mounted.
function shouldNotifyInApp(event: NotifyEvent): boolean {
  if (typeof document === 'undefined' || document.hidden) return false;
  return viewedBuffer() !== `${event.networkId}::${event.target}`;
}

export function notifyForEvent(event: NotifyEvent | null | undefined): void {
  if (!event || event.self) return;
  // Trust the server's `notify` verdict — the ignore/mute veto (a hidden
  // sender or a NONOTIFY-muted channel/network/DM — issue #359) is already
  // folded in, so a muted buffer never toasts, and we don't re-run ignore
  // matching here. A NOHIGHLIGHT rule is display-only and does NOT clear
  // `notify`, so it still toasts — matching the server push path. Push is
  // gated the same way server-side (it fires while no client is open).
  if (!event.notify) return;
  const kindKey = pickKindKey(event);
  if (!kindKey) return;

  // Toast + sound only when the tab is visible and the event's buffer isn't
  // the one on screen — a hidden tab is the push path's job, and the viewed
  // buffer is already in plain view. See shouldNotifyInApp.
  if (!shouldNotifyInApp(event)) return;

  const settings = useSettingsStore();
  if (!settings.effective(`notifications.${kindKey}.enabled`)) return;

  // Collapse a rapid burst from one source into a single toast + sound.
  if (throttled(event, kindKey)) return;

  const networks = useNetworksStore();
  const toasts = useToastsStore();

  const netName = (networks.networkById(event.networkId!) as any)?.name || `net:${event.networkId}`;
  const where =
    event.target && !event.target.startsWith(':server:')
      ? `${netName} ${META_SEPARATOR} ${event.target}`
      : netName;
  toasts.push({
    kind: kindKey,
    title: `${event.nick || '?'} in ${where}`,
    // The toast renders body as plain text, so mIRC formatting codes (\x03
    // colors, \x02 bold, …) would show up as literal control chars. Strip them
    // — a toast is a glanceable summary, not the message view (#606).
    body: stripFormatting(event.text || ''),
    networkId: event.networkId,
    target: event.target,
    messageId: event.id,
  });

  if (settings.effective(`notifications.${kindKey}.sound.enabled`)) {
    playSound(
      (settings.effective(`notifications.${kindKey}.sound.choice`) as string) || 'ping',
      settings.effective(`notifications.${kindKey}.sound.volume`),
    );
  }
}

export function playSound(choice: string, volume: unknown): void {
  // Clone the cached template so each notification gets its own audio
  // element. A shared element silently drops rapid-fire plays: setting
  // currentTime mid-play aborts the in-flight play() promise, and the
  // element's state machine races subsequent calls. cloneNode reuses the
  // browser's cached audio bytes but produces an independent state.
  const el = getTemplate(choice || 'ping').cloneNode() as HTMLAudioElement;
  el.volume = Math.max(0, Math.min(1, (Number(volume) || 0) / 100));
  const p = el.play();
  // Pre-user-gesture autoplay is blocked by the browser; swallow that one
  // case quietly. Real failures (decode errors etc.) will still surface in
  // the devtools console because the promise itself logs an unhandled
  // rejection if we don't catch — keeping the catch keeps the console
  // clean during the very common pre-gesture replay.
  if (p && typeof p.catch === 'function')
    p.catch(() => {
      /* autoplay blocked */
    });
}
