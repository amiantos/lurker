// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Is someone actually at this client? Visible is not enough: a tab left in
// front on a machine nobody is sitting at is visible for days (#1402). So
// "attended" is the page being visible AND having had input within
// `client.idle.delay_seconds`.
//
// Two things hang off it. usePresence reports it to the server as this
// client's presence, which is what holds push and auto-away. And the buffers
// store only counts a live line as read while it is true: a line that lands in
// front of nobody stays unread, here and on every other device.
//
// Module state, not a ref: the readers ask when an event arrives, and the two
// that need to act on a change subscribe with onAttentionChange.

import { useSettingsStore } from '../stores/settings.js';

let wired = false;
let attended = true;
let lastInputAt = Date.now();
let lastInputType = 'start';
let lastPointer: { x: number; y: number } | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let forced: boolean | null = null;
// setTimeout's delay is a signed 32-bit count of ms; past it the timer fires
// at once. A longer limit just re-arms when this runs out.
const MAX_TIMEOUT_MS = 2 ** 31 - 1;
const listeners = new Set<(attended: boolean) => void>();

function visible(): boolean {
  return typeof document !== 'undefined' && !document.hidden;
}

// 0 turns idle off: the client is attended whenever it is visible.
function idleMs(): number {
  const seconds = Number(useSettingsStore().effective('client.idle.delay_seconds'));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
}

// The answer from the clock, as of this instant.
function attendedNow(): boolean {
  const limit = idleMs();
  return visible() && (limit === 0 || Date.now() - lastInputAt < limit);
}

// Bring the flag, its timer and the listeners up to date. `mayReturn` false
// lets this only notice a departure: a raised limit must not announce someone
// back who has not touched anything.
function evaluate(mayReturn = true): void {
  if (timer) clearTimeout(timer);
  timer = null;
  const limit = idleMs();
  const idleFor = Date.now() - lastInputAt;
  const next = attendedNow() && (attended || mayReturn);
  // One timer, due when the current quiet spell would reach the limit. Input
  // only moves lastInputAt; the timer finds out when it fires and re-arms.
  if (next && limit > 0) {
    timer = setTimeout(() => evaluate(), Math.min(limit - idleFor, MAX_TIMEOUT_MS));
  }
  if (next === attended) return;
  attended = next;
  for (const fn of listeners) fn(next);
}

function onInput(e: Event): void {
  // A browser sends a pointermove when the page moves under a pointer that
  // didn't: a new line scrolling the list is enough. Only a change of screen
  // position is the user, and the first event has nothing to compare against,
  // so it only records where the pointer is.
  if (e.type === 'pointermove') {
    const { screenX: x, screenY: y } = e as PointerEvent;
    const last = lastPointer;
    lastPointer = { x, y };
    if (!last || (last.x === x && last.y === y)) return;
  }
  noteInput(e.type);
}

function noteInput(type: string): void {
  // The flag can be behind the clock: a laptop that slept through its idle
  // timer wakes with the timer still pending. Notice that departure first, so
  // this input is a return and the listeners hear both.
  if (attended && !attendedNow()) evaluate();
  lastInputAt = Date.now();
  lastInputType = type;
  if (!attended) evaluate();
}

// Coming back to the tab is the user doing something, even before a key.
function onVisibility(e: Event): void {
  if (visible()) noteInput(e.type);
  else evaluate();
}

// No 'scroll': the list scrolls itself to the tail on every new line, which
// would keep an empty room attended for as long as anyone was talking. A
// person scrolling arrives as wheel, touch, a key or a pointer on the bar.
const INPUT_EVENTS = ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart'] as const;

export function startAttention(): void {
  if (wired || typeof document === 'undefined') return;
  wired = true;
  for (const type of INPUT_EVENTS) {
    window.addEventListener(type, onInput, { capture: true, passive: true });
  }
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('focus', onVisibility);
  lastInputAt = Date.now();
  evaluate();
}

export function isAttended(): boolean {
  if (forced !== null) return forced;
  // Not started yet (the first moments of a load): visibility is all there is.
  if (!wired) return typeof document === 'undefined' || !document.hidden;
  // Asked of the clock as well as the flag, so a stale flag can't say yes.
  return attended && attendedNow();
}

/** Where the tracker stands right now, for the debug readout (AttentionDebug). */
export function attentionSnapshot() {
  return {
    attended: isAttended(),
    visible: visible(),
    idleForMs: Date.now() - lastInputAt,
    limitMs: idleMs(),
    lastInputType,
  };
}

/** Called with the new value on each change. Returns the unsubscribe. */
export function onAttentionChange(fn: (attended: boolean) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The idle limit changed: re-time from the last input. Never a return. */
export function attentionSettingChanged(): void {
  if (wired) evaluate(false);
}

/** Tests only: back to an unwired, attended tracker. */
export function resetAttentionForTests(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  if (wired) {
    for (const type of INPUT_EVENTS) window.removeEventListener(type, onInput, { capture: true });
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('focus', onVisibility);
  }
  wired = false;
  attended = true;
  lastInputAt = Date.now();
  lastInputType = 'start';
  lastPointer = null;
  forced = null;
  listeners.clear();
}

/** Tests only: set the answer without the DOM or a clock. */
export function setAttendedForTests(value: boolean | null): void {
  forced = value;
}
