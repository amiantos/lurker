// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from 'vitest';

import {
  CONSOLIDATABLE_TYPES,
  consolidateMessages,
  type ConsolidationGroup,
  type ConsolidationRow,
  type ConsolidatableMessage,
  type NickEntry,
  type RenameEntry,
} from './consolidate.js';

let seq = 0;
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

/** Groups as a plain `kind → nicks` map, for terse assertions. */
function summarize(groups: ConsolidationGroup[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const g of groups) {
    out[g.kind] = g.visible.map((v) =>
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

  // The setter-vs-target problem (#593): a mode line's `nick` is whoever SET
  // the mode, not who it was applied to, so it can't feed the identity map.
  it('excludes mode', () => {
    expect(CONSOLIDATABLE_TYPES.has('mode')).toBe(false);
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
