// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The channel modal's mode form (#727), as pure functions: which rows to draw
// from the network's modeSpec, and what MODE changes an edit amounts to.
//
// The form holds only the rows the user TOUCHED (a draft), never a copy of the
// channel's modes taken when it opened. Everything else reads the live state,
// and Save diffs the draft against the live state at that moment. So another
// op's change while the modal is open shows up, and Save never re-sends or
// reverts it — the stale-baseline bug obby's modal has.

import type { ModeSpec, OutgoingModeChange } from '../../../shared/channelModes.js';

/** The names a letter has on every ircd we know. Anything else shows as `+X`. */
const MODE_NAMES: Record<string, string> = {
  n: 'No outside messages',
  t: 'Only operators set the topic',
  i: 'Invite only',
  m: 'Moderated',
  s: 'Secret',
  p: 'Private',
  k: 'Key',
  l: 'User limit',
};

/** A list mode's tab label, for the letters the server can fetch. */
export const LIST_NAMES: Record<string, string> = {
  b: 'Bans',
  e: 'Exceptions',
  I: 'Invites',
  q: 'Quiets',
};

export function modeName(letter: string): string | null {
  return Object.hasOwn(MODE_NAMES, letter) ? MODE_NAMES[letter] : null;
}

/** How a row is edited. */
export type RowKind = 'flag' | 'param' | 'key';

export interface ModeRow {
  letter: string;
  kind: RowKind;
  name: string | null;
}

/**
 * The rows to draw: every flag and param mode the network advertises, the
 * well-known ones first. List modes have their own tabs, and prefix modes are
 * people, not the channel.
 */
export function modeRows(spec: ModeSpec): ModeRow[] {
  const rows: ModeRow[] = [];
  for (const letter of spec.flags) rows.push({ letter, kind: 'flag', name: modeName(letter) });
  for (const letter of spec.always + spec.onSet) {
    rows.push({ letter, kind: letter === 'k' ? 'key' : 'param', name: modeName(letter) });
  }
  return rows.toSorted((a, b) => namedFirst(a) - namedFirst(b));
}

function namedFirst(row: ModeRow): number {
  return row.name ? 0 : 1;
}

/** One row as the user left it. For the key, '' or the current key keeps it. */
export interface DraftRow {
  on: boolean;
  value: string;
}

export interface LiveModes {
  /** Every set letter, e.g. 'ntkl'. */
  modes: string;
  /** Values of set param modes. The server never sends the key; the modal puts
   *  the one we joined with here once it has fetched it, so an untouched key
   *  field reads as "keep". */
  params: Record<string, string>;
}

export function liveRow(live: LiveModes, letter: string): DraftRow {
  return { on: live.modes.includes(letter), value: live.params[letter] ?? '' };
}

/**
 * The MODE changes that turn the live state into the draft, or the first
 * problem that stops it. Rows the draft left alone are not looked at.
 */
export function modeChanges(
  spec: ModeSpec,
  live: LiveModes,
  draft: Record<string, DraftRow>,
): { changes: OutgoingModeChange[] } | { error: string } {
  const changes: OutgoingModeChange[] = [];
  const kindOf = new Map(modeRows(spec).map((r) => [r.letter, r.kind]));
  for (const [letter, want] of Object.entries(draft)) {
    const kind = kindOf.get(letter);
    if (!kind) continue;
    const was = liveRow(live, letter);
    const value = want.value.trim();
    if (kind === 'flag') {
      if (want.on !== was.on) changes.push({ sign: want.on ? '+' : '-', letter });
      continue;
    }
    if (/\s/.test(value)) return { error: `+${letter} can't contain spaces` };
    if (!want.on) {
      if (!was.on) continue;
      // A B-group mode names its value to unset it; the server fills in -k's.
      const needsParam = spec.always.includes(letter) && kind !== 'key';
      changes.push(needsParam ? { sign: '-', letter, param: was.value } : { sign: '-', letter });
      continue;
    }
    if (kind === 'key') {
      if (!value) {
        if (!was.on) return { error: 'Enter a key' };
        continue; // on, and no new key: keep the one it has
      }
      if (was.on && value === was.value) continue;
      // Replacing a key: several ircds answer a bare +k over an existing one
      // with 467, so take the old one off first.
      if (was.on) changes.push({ sign: '-', letter });
      changes.push({ sign: '+', letter, param: value });
      continue;
    }
    if (!value) return { error: `Enter a value for +${letter}` };
    if (!was.on || value !== was.value) changes.push({ sign: '+', letter, param: value });
  }
  return { changes };
}

/** A topic's length as the server counts it: bytes, not characters. */
export function topicBytes(topic: string): number {
  return new TextEncoder().encode(topic).length;
}
