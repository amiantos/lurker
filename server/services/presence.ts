// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Whether the user is here, for auto-away. Two things count:
// - a web or iOS socket whose app says it's visible (wsHub.ts);
// - an IRC client attached to a network through the bouncer, unless it said
//   with `AWAY *` (draft/pre-away) that it isn't the user (bouncer.ts).
// When nothing has counted for `away.auto.delay_seconds`, the account goes away
// on every network not already away, and the first thing to count again brings
// back the networks auto-away set. A manual /away is left alone either way.
//
// Push asks a narrower question, only about visible sockets (wsHub.ts). An IRC
// client has no visibility, and one left attached on a desktop would otherwise
// silence the phone.

import ircManager from './ircManager.js';
import { effectiveSetting } from './settingsService.js';
import { findUserById } from '../db/users.js';
import { wallClockStamp } from '../utils/timeZone.js';

type Source = 'web' | 'irc';

// How many things each source has that count, for a user.
const sources = new Map<Source, (userId: number) => number>();
// Per-user pending auto-away timers. Set when the last thing that counts goes,
// cleared when one comes back or the timer fires.
const timers = new Map<number, ReturnType<typeof setTimeout>>();

/** How to count one source's present things for a user. null removes the source. */
export function setPresenceSource(
  source: Source,
  count: ((userId: number) => number) | null,
): void {
  if (count) sources.set(source, count);
  else sources.delete(source);
}

/** Whether anything counts as the user being here. */
export function isPresent(userId: number): boolean {
  for (const count of sources.values()) if (count(userId) > 0) return true;
  return false;
}

/**
 * Something that counts came or went. With something here, auto-away clears;
 * with nothing, it's scheduled.
 */
export function evaluatePresence(userId: number): void {
  if (isPresent(userId)) {
    clearAutoAway(userId);
    ircManager.clearAway(userId, 'all', { autoSet: true });
  } else {
    scheduleAutoAway(userId);
  }
}

/** Drop a pending auto-away. */
export function clearAutoAway(userId: number): void {
  const t = timers.get(userId);
  if (t) {
    clearTimeout(t);
    timers.delete(userId);
  }
}

/** The auto-away settings changed: start the wait again with the new values. */
export function rescheduleAutoAway(userId: number): void {
  clearAutoAway(userId);
  if (!isPresent(userId)) scheduleAutoAway(userId);
}

function scheduleAutoAway(userId: number): void {
  if (timers.has(userId)) return;
  const enabled = !!effectiveSetting(userId, 'away.auto.enabled');
  if (!enabled) return;
  const rawDelay = Number(effectiveSetting(userId, 'away.auto.delay_seconds'));
  const delaySec = Number.isFinite(rawDelay) && rawDelay > 0 ? rawDelay : 30;
  // The user went idle the moment we scheduled this timer, not when it fires
  // `delaySec` later — backdate the away "since" to now so it reflects when
  // they actually stepped away (#155).
  const afkSince = new Date();
  const t = setTimeout(() => {
    timers.delete(userId);
    // Re-check: something may have come back during the delay.
    if (isPresent(userId)) return;
    // A client dropped as its account was paused or removed still reports
    // leaving, after wsHub has cleared the timer.
    const user = findUserById(userId);
    if (!user || user.is_paused) return;
    const message = buildAutoAwayMessage(userId, afkSince);
    ircManager.setAway(userId, 'all', message, { autoSet: true, since: afkSince });
  }, delaySec * 1000);
  t.unref?.();
  timers.set(userId, t);
}

function buildAutoAwayMessage(userId: number, since: Date): string {
  const base =
    ((effectiveSetting(userId, 'away.auto.message') as string | undefined) || 'afk').trim() ||
    'afk';
  const tz = effectiveSetting(userId, 'system.timezone');
  // "afk since 2026-05-09 15:30:00-0500" — screen_away.py's default time_format.
  return `${base} since ${wallClockStamp(since, tz)}`;
}
