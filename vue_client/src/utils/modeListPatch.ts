// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Keeping an open list tab in the channel modal current (#727). The list is
// fetched once when the tab opens; after that every `mode` row the channel
// receives patches it, so another op's ban — or our own — shows up without a
// refetch. That's also why Save never refetches: a fetch on the wire would take
// a 482 aimed at the MODE change just sent (see server/services/modeList.ts).

export interface ListEntry {
  mask: string;
  setBy: string | null;
  setAt: string | null;
}

/** The part of a stored `mode` row this reads. */
export interface ModeRowLike {
  nick?: string | null;
  time?: string | null;
  modes?: readonly { mode: string; param?: string | null; kind?: string }[] | null;
}

/** `entries` with every ±letter change in `rows` applied, in order. */
export function patchModeList(
  entries: readonly ListEntry[],
  rows: readonly ModeRowLike[],
  letter: string,
): ListEntry[] {
  let out = [...entries];
  for (const row of rows) {
    for (const change of row.modes ?? []) {
      if (change.kind !== 'list' || change.mode.slice(1) !== letter || !change.param) continue;
      const key = change.param.toLowerCase();
      const at = out.findIndex((e) => e.mask.toLowerCase() === key);
      if (change.mode[0] === '+') {
        if (at === -1) {
          out.push({ mask: change.param, setBy: row.nick ?? null, setAt: row.time ?? null });
        }
      } else if (at !== -1) {
        out = out.toSpliced(at, 1);
      }
    }
  }
  return out;
}
