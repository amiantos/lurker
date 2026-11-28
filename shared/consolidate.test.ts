// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { beforeEach, describe, expect, it } from 'vitest';

import {
  CONSOLIDATABLE_TYPES,
  consolidateMessages,
  type ConsolidationGroup,
  type ConsolidationRow,
  type ConsolidatableMessage,
  type NickEntry,
  type RenameEntry,
} from './consolidate.js';

// Ids and timestamps just need to be unique and ascending *within* a test —
// nothing here asserts on their values. Reset per test so a case's fixtures
// don't shift when one is added above it.
let seq = 0;
beforeEach(() => {
  seq = 0;
});

function ev(type: string, nick: string, extra: Partial<ConsolidatableMessage> = {}) {
  seq += 1;
  return {
    id: seq,
    type,
    nick,
    time: `2026-07-19T00:00:${String(seq).padStart(2, '0')}Z`,
    ...extra,
  };
}

function isConsolidation(row: unknown): row is ConsolidationRow {
  return !!row && (row as ConsolidationRow).consolidation === true;
}

/** The single consolidation row a run is expected to collapse to. */
function onlyRow(messages: ConsolidatableMessage[], maxNames = 5): ConsolidationRow {
  const rows = consolidateMessages(messages, { maxNames });
  expect(rows).toHaveLength(1);
  expect(isConsolidation(rows[0])).toBe(true);
  return rows[0] as ConsolidationRow;
}

/**
 * Groups as a plain `kind → nicks` map, for terse assertions. Mode groups key
 * on `kind:letter`, since one run can carry `modeGranted` for both `o` and `v`.
 */
function summarize(groups: ConsolidationGroup[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const g of groups) {
    const key = g.letter ? `${g.kind}:${g.letter}` : g.kind;
    out[key] = g.visible.map((v) =>
      'from' in v ? `${(v as RenameEntry).from}→${(v as RenameEntry).to}` : (v as NickEntry).nick,
    );
  }
  return out;
}

describe('CONSOLIDATABLE_TYPES', () => {
  it('covers the presence-noise types and nothing else', () => {
    expect([...CONSOLIDATABLE_TYPES].toSorted()).toEqual([
      'chghost',
      'join',
      'nick',
      'part',
      'quit',
    ]);
  });

  // Two separate reasons, both still true now that mode rows DO fold:
  //
  // The setter-vs-target problem (#593): a mode line's `nick` is whoever SET
  // the mode, not who it was applied to, so it can't feed the identity map —
  // which is why modeGroups is a second pass rather than another member here.
  //
  // And this set defines the `renderable` page unit (shared/eventFilter.ts).
  // Moving `mode` in would change what a `countBy:'renderable'` page contains
  // for every client, shipped iOS builds included. Whether a row FOLDS is
  // asked by foldsIntoRun instead.
  it('excludes mode', () => {
    expect(CONSOLIDATABLE_TYPES.has('mode')).toBe(false);
  });
});

// Helpers for mode rows. `nick` on a mode event is the SETTER; the targets ride
// in `modes`, each stamped with the class the server assigned it.
function grant(letter: string, ...nicks: string[]) {
  return ev('mode', 'ChanServ', {
    modes: nicks.map((n) => ({ mode: `+${letter}`, param: n, kind: 'prefix' as const })),
  });
}
function revoke(letter: string, ...nicks: string[]) {
  return ev('mode', 'ChanServ', {
    modes: nicks.map((n) => ({ mode: `-${letter}`, param: n, kind: 'prefix' as const })),
  });
}

describe('mode consolidation (#673)', () => {
  it('no longer breaks a run', () => {
    // The case that motivated this: a netsplit rejoin on an auto-op channel
    // used to come out as summary, mode, summary, mode, summary.
    const row = onlyRow([
      ev('join', 'alice'),
      grant('o', 'alice'),
      ev('join', 'bob'),
      grant('o', 'bob'),
      ev('join', 'carol'),
    ]);
    expect(summarize(row.groups)).toEqual({
      joined: ['alice', 'bob', 'carol'],
      'modeGranted:o': ['alice', 'bob'],
    });
  });

  it('puts presence first and modes after', () => {
    const row = onlyRow([ev('join', 'alice'), grant('o', 'alice')]);
    expect(row.groups.map((g) => g.kind)).toEqual(['joined', 'modeGranted']);
  });

  it('groups by letter and by direction', () => {
    const row = onlyRow([grant('o', 'alice'), grant('v', 'bob'), revoke('v', 'carol')]);
    expect(summarize(row.groups)).toEqual({
      'modeGranted:o': ['alice'],
      'modeGranted:v': ['bob'],
      'modeRevoked:v': ['carol'],
    });
  });

  it('reads a cancelled pair as "briefly", the way joinedAndLeft does', () => {
    // First change implies the prior state, exactly as in the presence walk: an
    // opening `+o` means they did not hold it before, so `+o` then `-o` is the
    // mode-side of joined-and-left rather than a plain deop.
    const row = onlyRow([grant('o', 'alice'), revoke('o', 'alice'), ev('join', 'bob')]);
    expect(summarize(row.groups)).toEqual({ joined: ['bob'], 'modeBriefly:o': ['alice'] });
  });

  it('reads a regained mode as "again", the way reconnected does', () => {
    // An opening `-o` means they DID hold it before the run.
    const row = onlyRow([revoke('o', 'alice'), grant('o', 'alice'), ev('join', 'bob')]);
    expect(summarize(row.groups)).toEqual({ joined: ['bob'], 'modeRegranted:o': ['alice'] });
  });

  it('classifies every letter the same way, not just op', () => {
    const row = onlyRow([
      grant('v', 'alice'),
      revoke('v', 'alice'),
      revoke('v', 'bob'),
      grant('v', 'bob'),
      grant('h', 'carol'),
      revoke('q', 'dave'),
    ]);
    expect(summarize(row.groups)).toEqual({
      'modeBriefly:v': ['alice'],
      'modeRegranted:v': ['bob'],
      'modeGranted:h': ['carol'],
      'modeRevoked:q': ['dave'],
    });
  });

  it('ignores the churn between the first and last change', () => {
    const row = onlyRow([
      grant('o', 'alice'),
      revoke('o', 'alice'),
      grant('o', 'alice'),
      revoke('o', 'alice'),
      ev('join', 'bob'),
    ]);
    // Started without it, ended without it, blipped in between.
    expect(summarize(row.groups)).toEqual({ joined: ['bob'], 'modeBriefly:o': ['alice'] });
  });

  it('keeps a nick in one group per letter, however many changes it saw', () => {
    const row = onlyRow([grant('o', 'alice'), grant('o', 'alice'), grant('o', 'alice')]);
    expect(summarize(row.groups)).toEqual({ 'modeGranted:o': ['alice'] });
  });

  it('tracks each letter for a nick separately', () => {
    const row = onlyRow([grant('o', 'alice'), revoke('v', 'alice')]);
    expect(summarize(row.groups)).toEqual({
      'modeGranted:o': ['alice'],
      'modeRevoked:v': ['alice'],
    });
  });

  it('folds every target of a multi-target message', () => {
    const row = onlyRow([grant('o', 'alice', 'bob', 'carol'), ev('join', 'dave')]);
    expect(summarize(row.groups)).toEqual({
      joined: ['dave'],
      'modeGranted:o': ['alice', 'bob', 'carol'],
    });
  });

  it('does not let a mode target reach the identity pass', () => {
    // alice never joined inside the run; being opped must not invent a
    // presence verdict for her.
    const row = onlyRow([grant('o', 'alice'), ev('join', 'bob')]);
    expect(summarize(row.groups)).toEqual({ joined: ['bob'], 'modeGranted:o': ['alice'] });
  });

  it('caps and counts mode nicks like any other category', () => {
    const row = onlyRow([grant('o', 'a', 'b', 'c', 'd'), ev('join', 'z')], 2);
    const modeGroup = row.groups.find((g) => g.kind === 'modeGranted')!;
    expect(modeGroup.visible).toHaveLength(2);
    expect(modeGroup.hidden).toBe(2);
    expect(modeGroup.letter).toBe('o');
  });

  it('still renders a lone mode row as its own line', () => {
    // A run of one passes through, so a solitary `+o alice` keeps its narrated
    // line rather than becoming a one-name summary.
    const rows = consolidateMessages([grant('o', 'alice')]);
    expect(rows).toHaveLength(1);
    expect(isConsolidation(rows[0])).toBe(false);
  });
});

describe('mode rows that must NOT fold', () => {
  const ban = () =>
    ev('mode', 'op', { modes: [{ mode: '+b', param: '*!*@host', kind: 'list' as const }] });

  it('a ban still breaks the run', () => {
    const rows = consolidateMessages([ev('join', 'alice'), ban(), ev('join', 'bob')]);
    expect(rows).toHaveLength(3);
    expect(rows.some(isConsolidation)).toBe(false);
  });

  it('a channel flag still breaks the run', () => {
    const flag = ev('mode', 'op', { modes: [{ mode: '+m', kind: 'chan' as const }] });
    const rows = consolidateMessages([ev('join', 'alice'), flag, ev('join', 'bob')]);
    expect(rows).toHaveLength(3);
  });

  it('a message mixing an op change with a ban breaks the run', () => {
    // The whole-message gate: one non-prefix change anywhere and the row stands
    // alone, so a ban can never be folded away behind "alice was opped".
    const mixed = ev('mode', 'op', {
      modes: [
        { mode: '+o', param: 'alice', kind: 'prefix' as const },
        { mode: '-b', param: '*!*@host', kind: 'list' as const },
      ],
    });
    const rows = consolidateMessages([ev('join', 'alice'), mixed, ev('join', 'bob')]);
    expect(rows).toHaveLength(3);
  });

  it('an unstamped mode row breaks the run', () => {
    // Backlog older than the server-side `kind` stamp. Without the class there
    // is no way to know whether `+q alice` grants ownership or quiets a mask,
    // so it is shown rather than guessed at.
    const unstamped = ev('mode', 'op', { modes: [{ mode: '+o', param: 'alice' }] });
    const rows = consolidateMessages([ev('join', 'alice'), unstamped, ev('join', 'bob')]);
    expect(rows).toHaveLength(3);
  });

  it('a mode row with no change list breaks the run', () => {
    const rows = consolidateMessages([
      ev('join', 'alice'),
      ev('mode', 'op', { modes: [] }),
      ev('join', 'bob'),
    ]);
    expect(rows).toHaveLength(3);
  });
});

describe('baseline join/part/quit/nick consolidation', () => {
  it('classifies each net effect', () => {
    const row = onlyRow([
      ev('join', 'alice'),
      ev('quit', 'bob'),
      ev('join', 'carol'),
      ev('part', 'carol'),
      ev('quit', 'dave'),
      ev('join', 'dave'),
      ev('nick', 'eve', { newNick: 'eve_afk' }),
    ]);
    expect(summarize(row.groups)).toEqual({
      joined: ['alice'],
      left: ['bob'],
      reconnected: ['dave'],
      joinedAndLeft: ['carol'],
      renamed: ['eve→eve_afk'],
    });
  });

  it('passes a lone event through unchanged', () => {
    const rows = consolidateMessages([ev('join', 'alice')]);
    expect(rows).toHaveLength(1);
    expect(isConsolidation(rows[0])).toBe(false);
  });

  it('breaks runs on a non-consolidatable row', () => {
    const rows = consolidateMessages([
      ev('join', 'alice'),
      ev('join', 'bob'),
      ev('message', 'carol'),
      ev('join', 'dave'),
      ev('join', 'eve'),
    ]);
    expect(rows.map(isConsolidation)).toEqual([true, false, true]);
  });

  it('follows a rename chain through to the final nick', () => {
    const row = onlyRow([
      ev('join', 'alice'),
      ev('nick', 'alice', { newNick: 'alice_' }),
      ev('nick', 'alice_', { newNick: 'alice__' }),
      ev('join', 'bob'),
    ]);
    // One identity, not three: the joins bucket carries the final display nick.
    expect(summarize(row.groups)).toEqual({ joined: ['alice__', 'bob'] });
  });
});

describe('chghost consolidation (#593)', () => {
  it('no longer breaks a run', () => {
    const rows = consolidateMessages([
      ev('join', 'alice'),
      ev('chghost', 'alice'),
      ev('join', 'bob'),
    ]);
    expect(rows).toHaveLength(1);
  });

  // The netsplit-recovery case this issue exists for: rejoins interleaved with
  // the CHGHOST each user emits as they identify. Must read as a plain "N
  // joined", with no separate host-change category.
  it('is transparent when the identity also joined', () => {
    const row = onlyRow([
      ev('join', 'alice'),
      ev('join', 'bob'),
      ev('chghost', 'alice'),
      ev('join', 'carol'),
      ev('chghost', 'bob'),
      ev('chghost', 'carol'),
    ]);
    expect(summarize(row.groups)).toEqual({ joined: ['alice', 'bob', 'carol'] });
  });

  it('is transparent for an identity that left', () => {
    const row = onlyRow([ev('chghost', 'alice'), ev('quit', 'alice'), ev('join', 'bob')]);
    expect(summarize(row.groups)).toEqual({ joined: ['bob'], left: ['alice'] });
  });

  it('gets its own category only when nothing else happened', () => {
    const row = onlyRow([ev('chghost', 'alice'), ev('chghost', 'bob')]);
    expect(summarize(row.groups)).toEqual({ rehosted: ['alice', 'bob'] });
  });

  it('collapses repeated host changes for one nick into a single entry', () => {
    const row = onlyRow([ev('chghost', 'alice'), ev('chghost', 'alice'), ev('chghost', 'bob')]);
    expect(summarize(row.groups)).toEqual({ rehosted: ['alice', 'bob'] });
  });

  it('prefers the rename when an identity both renamed and rehosted', () => {
    const row = onlyRow([
      ev('nick', 'alice', { newNick: 'alice_' }),
      ev('chghost', 'alice_'),
      ev('chghost', 'bob'),
    ]);
    expect(summarize(row.groups)).toEqual({ renamed: ['alice→alice_'], rehosted: ['bob'] });
  });

  it('still renders a lone chghost as its own row', () => {
    const rows = consolidateMessages([ev('chghost', 'alice')]);
    expect(rows).toHaveLength(1);
    expect(isConsolidation(rows[0])).toBe(false);
  });

  it('folds host changes into an identity tracked across a rename', () => {
    const row = onlyRow([
      ev('join', 'alice'),
      ev('nick', 'alice', { newNick: 'alice_' }),
      ev('chghost', 'alice_'),
      ev('join', 'bob'),
    ]);
    expect(summarize(row.groups)).toEqual({ joined: ['alice_', 'bob'] });
  });

  it('caps and counts rehosted nicks like any other category', () => {
    const row = onlyRow(
      ['a', 'b', 'c', 'd'].map((n) => ev('chghost', n)),
      2,
    );
    expect(row.groups).toHaveLength(1);
    expect(row.groups[0]).toMatchObject({ kind: 'rehosted', hidden: 2 });
    expect(row.groups[0].visible).toHaveLength(2);
  });
});

describe('an opened run (#1430)', () => {
  const run = () => [ev('join', 'alice'), ev('quit', 'bob'), ev('join', 'carol')];

  it('carries the rows it folded', () => {
    const row = onlyRow(run());
    expect(row.rows.map((r) => r.key)).toEqual([1, 2, 3]);
    expect(row.expanded).toBeUndefined();
  });

  it('keeps its summary and lists its rows under it', () => {
    const rows = consolidateMessages(run(), { isExpanded: () => true });
    expect(isConsolidation(rows[0])).toBe(true);
    expect((rows[0] as ConsolidationRow).expanded).toBe(true);
    expect(summarize((rows[0] as ConsolidationRow).groups)).toEqual({
      joined: ['alice', 'carol'],
      left: ['bob'],
    });
    expect(rows.slice(1).map((r) => r.key)).toEqual([1, 2, 3]);
  });

  it('is asked per run, with that run', () => {
    const messages = [...run(), ev('message', 'dave'), ev('join', 'erin'), ev('join', 'frank')];
    const rows = consolidateMessages(messages, {
      isExpanded: (r) => r.some((x) => x.key === 5),
    });
    // First run stays folded; the second is open: summary, then its two rows.
    expect(rows.map((r) => (isConsolidation(r) ? 'cons' : r.key))).toEqual([
      'cons',
      4,
      'cons',
      5,
      6,
    ]);
    expect((rows[0] as ConsolidationRow).expanded).toBeUndefined();
  });

  it('never asks about a lone event', () => {
    let asked = 0;
    consolidateMessages([ev('join', 'alice')], {
      isExpanded: () => {
        asked += 1;
        return true;
      },
    });
    expect(asked).toBe(0);
  });
});
