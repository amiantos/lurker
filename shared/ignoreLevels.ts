// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The ignore-level vocabulary (issue #301), shared by the server matcher, the
// client matcher, and the /ignore command parser so the three never drift on
// which level tokens exist, their aliases, or how they map to event types.

// Each level token maps to the persisted event `type`s it covers. PUBLIC vs MSGS
// split a 'message' by channel-vs-DM (`dm`). ALL and the modifier levels
// (NOHIGHLIGHT / NOUNREAD / NONOTIFY) are special (handled by the matcher, not
// event-type tokens); CTCPS is accepted but maps to nothing — Lurker never
// surfaces CTCP as a persisted type, a documented no-op.
export const LEVEL_DEFS: Record<string, { types: string[]; dm?: boolean }> = {
  PUBLIC: { types: ['message'], dm: false },
  MSGS: { types: ['message'], dm: true },
  NOTICES: { types: ['notice'] },
  ACTIONS: { types: ['action'] },
  JOINS: { types: ['join'] },
  PARTS: { types: ['part'] },
  QUITS: { types: ['quit'] },
  NICKS: { types: ['nick'] },
  KICKS: { types: ['kick'] },
  MODES: { types: ['mode'] },
  TOPICS: { types: ['topic'] },
  CTCPS: { types: [] },
};

// The event types an ALL rule covers — everything with a sender to ignore,
// excluding system/self rows (motd/error/usermode/own-nick/names).
export const ALL_TYPES = new Set([
  'message',
  'action',
  'notice',
  'join',
  'part',
  'quit',
  'nick',
  'kick',
  'mode',
  'topic',
]);

export const HIGHLIGHTABLE = new Set(['message', 'action']);

// alias -> canonical token. Accepts irssi's singular/plural forms.
export const LEVEL_ALIASES: Record<string, string> = {
  PUBLIC: 'PUBLIC',
  PUBLICS: 'PUBLIC',
  MSG: 'MSGS',
  MSGS: 'MSGS',
  NOTICE: 'NOTICES',
  NOTICES: 'NOTICES',
  ACTION: 'ACTIONS',
  ACTIONS: 'ACTIONS',
  JOIN: 'JOINS',
  JOINS: 'JOINS',
  PART: 'PARTS',
  PARTS: 'PARTS',
  QUIT: 'QUITS',
  QUITS: 'QUITS',
  NICK: 'NICKS',
  NICKS: 'NICKS',
  KICK: 'KICKS',
  KICKS: 'KICKS',
  MODE: 'MODES',
  MODES: 'MODES',
  TOPIC: 'TOPICS',
  TOPICS: 'TOPICS',
  CTCP: 'CTCPS',
  CTCPS: 'CTCPS',
  ALL: 'ALL',
  // Lurker calls them "highlights", so NOHIGHLIGHT(S) is the canonical token;
  // irssi's NOHILIGHT/NOHILITE spellings are accepted as aliases.
  NOHIGHLIGHT: 'NOHIGHLIGHT',
  NOHIGHLIGHTS: 'NOHIGHLIGHT',
  NOHILIGHT: 'NOHIGHLIGHT',
  NOHILITE: 'NOHIGHLIGHT',
  // Modifier levels for muting (issue #359). NOUNREAD suppresses the plain-unread
  // signal (≙ irssi's NO_ACT, "don't trigger channel activity"); NONOTIFY
  // suppresses toast/push/sound. Both keep the message visible + counted, like
  // NOHIGHLIGHT. irssi's NO_ACT spellings are accepted as NOUNREAD aliases.
  NOUNREAD: 'NOUNREAD',
  NOUNREADS: 'NOUNREAD',
  NO_ACT: 'NOUNREAD',
  NOACT: 'NOUNREAD',
  NOACTIVITY: 'NOUNREAD',
  NONOTIFY: 'NONOTIFY',
  NONOTIFYS: 'NONOTIFY',
  NONOTIFICATION: 'NONOTIFY',
  NONOTIFICATIONS: 'NONOTIFY',
};

// Deterministic order so the stored levels CSV is stable (the DB dedupe compares
// the CSV string) and listing output reads consistently.
export const CANONICAL_ORDER = [
  'ALL',
  'PUBLIC',
  'MSGS',
  'NOTICES',
  'ACTIONS',
  'JOINS',
  'PARTS',
  'QUITS',
  'NICKS',
  'KICKS',
  'MODES',
  'TOPICS',
  'CTCPS',
  'NOHIGHLIGHT',
  'NOUNREAD',
  'NONOTIFY',
];

export const KNOWN_LEVELS = new Set(Object.keys(LEVEL_ALIASES));

/** Resolve a single token to its canonical form, or null if unknown. */
export function canonicalLevel(token: string): string | null {
  return LEVEL_ALIASES[token.toUpperCase()] ?? null;
}

/** Normalize a level list: canonicalize aliases, dedupe, sort canonically. */
export function canonicalizeLevels(levels: string[]): string[] {
  const set = new Set<string>();
  for (const l of levels) {
    const c = canonicalLevel(l);
    if (c) set.add(c);
  }
  return CANONICAL_ORDER.filter((l) => set.has(l));
}
