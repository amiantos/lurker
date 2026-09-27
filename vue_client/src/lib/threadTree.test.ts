// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { threadRows } from './threadTree.js';
import type { ThreadRow } from './threadTree.js';

type L = { id: number; msgid?: string; replyTo?: { msgid: string } | null; name: string };

const line = (id: number, name: string, parent?: string): L => ({
  id,
  name,
  msgid: name,
  replyTo: parent ? { msgid: parent } : null,
});

// The tree as tree(1) would print it — what the view draws.
function draw(rows: ThreadRow<L>[]): string[] {
  return rows.map((r) => {
    const name = r.line?.name ?? '(gone)';
    if (r.depth === 0) return name;
    const rails = r.rails.map((on) => (on ? '│  ' : '   ')).join('');
    return `${rails}${r.last ? '└─ ' : '├─ '}${name}`;
  });
}

describe('threadRows', () => {
  it('draws the operator’s example', () => {
    const root = line(1, 'blah');
    const rows = threadRows(root, [
      line(2, 'yadda', 'blah'),
      line(3, 'disagree', 'yadda'),
      line(4, 'great idea', 'blah'),
    ]);
    expect(draw(rows)).toEqual(['blah', '├─ yadda', '│  └─ disagree', '└─ great idea']);
  });

  it('carries a rail only where an ancestor has a later sibling', () => {
    const rows = threadRows(line(1, 'r'), [
      line(2, 'a', 'r'),
      line(3, 'a1', 'a'),
      line(4, 'a1x', 'a1'),
      line(5, 'a2', 'a'),
      line(6, 'b', 'r'),
      line(7, 'b1', 'b'),
      line(8, 'b1x', 'b1'),
    ]);
    expect(draw(rows)).toEqual([
      'r',
      '├─ a',
      '│  ├─ a1',
      '│  │  └─ a1x',
      '│  └─ a2',
      '└─ b',
      '   └─ b1',
      '      └─ b1x',
    ]);
  });

  it('orders siblings oldest first, whatever order they arrive in', () => {
    const rows = threadRows(line(1, 'r'), [line(9, 'late', 'r'), line(3, 'early', 'r')]);
    expect(draw(rows)).toEqual(['r', '├─ early', '└─ late']);
  });

  it('hangs a reply whose parent it can’t find off the first line', () => {
    const rows = threadRows(line(1, 'r'), [line(2, 'a', 'r'), line(3, 'orphan', 'gone')]);
    expect(draw(rows)).toEqual(['r', '├─ a', '└─ orphan']);
  });

  it('keeps the shape under a stand-in when the first line is gone', () => {
    const rows = threadRows<L>(null, [line(2, 'a', 'r'), line(3, 'a1', 'a')]);
    expect(draw(rows)).toEqual(['(gone)', '└─ a', '   └─ a1']);
    expect(rows[0].hasChildren).toBe(true);
  });

  it('never loops on replies naming each other', () => {
    // A backfilled pair: 2 answers 3 and 3 answers 2. Only the older can parent.
    const rows = threadRows(line(1, 'r'), [line(2, 'x', 'y'), line(3, 'y', 'x')]);
    expect(draw(rows)).toEqual(['r', '└─ x', '   └─ y']);
  });
});
