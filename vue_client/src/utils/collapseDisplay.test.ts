// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import type { DisplayRow } from './collapseDisplay.js';
import { collapseDisplay } from './collapseDisplay.js';

// Build a chat row with the same shape MessageList's renderRows emits.
function msg({
  id,
  nick,
  time,
  type = 'message',
  self = false,
}: {
  id: number;
  nick: string;
  time: string;
  type?: string;
  self?: boolean;
}): DisplayRow {
  return {
    m: { id, nick, time, type, self },
    key: id,
  };
}

function consolidation({ time, key = 'cons:k' }: { time: string; key?: string }): DisplayRow {
  return { consolidation: true, time, key };
}

function divider({
  kind = 'unread',
  key = 'd:k',
}: { kind?: string; key?: string } = {}): DisplayRow {
  return { divider: kind, key };
}

// Identity time formatter — turns ISO into the minute portion so we can
// exercise the "same displayed time" branch deterministically.
const minuteFormat = (iso: string | undefined): string => (iso ? iso.slice(11, 16) : '');

describe('collapseDisplay — author collapsing', () => {
  it('flags consecutive plain messages from the same nick', () => {
    const rows = [
      msg({ id: 1, nick: 'alice', time: '2026-05-16T10:00:00Z' }),
      msg({ id: 2, nick: 'alice', time: '2026-05-16T10:00:30Z' }),
      msg({ id: 3, nick: 'alice', time: '2026-05-16T10:01:00Z' }),
    ];
    collapseDisplay(rows, {
      collapseAuthors: true,
      authorWindowMs: 5 * 60_000,
    });
    expect(rows[0].continuationAuthor).toBeUndefined();
    expect(rows[1].continuationAuthor).toBe(true);
    expect(rows[2].continuationAuthor).toBe(true);
  });

  it('does not collapse across different nicks', () => {
    const rows = [
      msg({ id: 1, nick: 'alice', time: '2026-05-16T10:00:00Z' }),
      msg({ id: 2, nick: 'bob', time: '2026-05-16T10:00:30Z' }),
      msg({ id: 3, nick: 'alice', time: '2026-05-16T10:01:00Z' }),
    ];
    collapseDisplay(rows, {
      collapseAuthors: true,
      authorWindowMs: 5 * 60_000,
    });
    expect(rows.every((r) => !r.continuationAuthor)).toBe(true);
  });

  it('does not collapse self vs. non-self messages from the same nick', () => {
    // Highly unusual — exists for completeness because the visual identity
    // (self color vs. hashed nick color) differs.
    const rows = [
      msg({ id: 1, nick: 'alice', time: '2026-05-16T10:00:00Z', self: false }),
      msg({ id: 2, nick: 'alice', time: '2026-05-16T10:00:10Z', self: true }),
    ];
    collapseDisplay(rows, {
      collapseAuthors: true,
      authorWindowMs: 5 * 60_000,
    });
    expect(rows[1].continuationAuthor).toBeUndefined();
  });

  it('breaks the run when the gap exceeds authorWindowMs', () => {
    const rows = [
      msg({ id: 1, nick: 'alice', time: '2026-05-16T10:00:00Z' }),
      msg({ id: 2, nick: 'alice', time: '2026-05-16T10:30:00Z' }),
    ];
    collapseDisplay(rows, {
      collapseAuthors: true,
      authorWindowMs: 5 * 60_000,
    });
    expect(rows[1].continuationAuthor).toBeUndefined();
  });

  it('breaks the run when time goes BACKWARD (bouncer replay of an old line)', () => {
    // Rows carry server-time: a chained-bouncer replay can append a row whose
    // time is older than the previous row's. A negative delta must not read
    // as "within the window" and collapse the replayed line under the fresh
    // message.
    const rows = [
      msg({ id: 1, nick: 'alice', time: '2026-05-16T10:00:00Z' }),
      msg({ id: 2, nick: 'alice', time: '2026-05-16T08:00:00Z' }),
    ];
    collapseDisplay(rows, {
      collapseAuthors: true,
      authorWindowMs: 5 * 60_000,
    });
    expect(rows[1].continuationAuthor).toBeUndefined();
  });

  it('does not collapse action / notice rows even from the same nick', () => {
    const rows = [
      msg({ id: 1, nick: 'alice', time: '2026-05-16T10:00:00Z', type: 'action' }),
      msg({ id: 2, nick: 'alice', time: '2026-05-16T10:00:10Z', type: 'action' }),
      msg({ id: 3, nick: 'alice', time: '2026-05-16T10:00:20Z', type: 'notice' }),
      msg({ id: 4, nick: 'alice', time: '2026-05-16T10:00:30Z', type: 'notice' }),
    ];
    collapseDisplay(rows, {
      collapseAuthors: true,
      authorWindowMs: 5 * 60_000,
    });
    expect(rows.every((r) => !r.continuationAuthor)).toBe(true);
  });

  it('breaks the run on a system event between two messages', () => {
    const rows = [
      msg({ id: 1, nick: 'alice', time: '2026-05-16T10:00:00Z' }),
      msg({ id: 2, nick: 'bob', time: '2026-05-16T10:00:05Z', type: 'join' }),
      msg({ id: 3, nick: 'alice', time: '2026-05-16T10:00:10Z' }),
    ];
    collapseDisplay(rows, {
      collapseAuthors: true,
      authorWindowMs: 5 * 60_000,
    });
    expect(rows[2].continuationAuthor).toBeUndefined();
  });

  it('breaks the run on a divider', () => {
    const rows = [
      msg({ id: 1, nick: 'alice', time: '2026-05-16T10:00:00Z' }),
      divider({ kind: 'unread' }),
      msg({ id: 2, nick: 'alice', time: '2026-05-16T10:00:30Z' }),
    ];
    collapseDisplay(rows, {
      collapseAuthors: true,
      authorWindowMs: 5 * 60_000,
    });
    expect(rows[2].continuationAuthor).toBeUndefined();
  });

  it('breaks the run on a consolidation summary row', () => {
    const rows = [
      msg({ id: 1, nick: 'alice', time: '2026-05-16T10:00:00Z' }),
      consolidation({ time: '2026-05-16T10:00:10Z' }),
      msg({ id: 2, nick: 'alice', time: '2026-05-16T10:00:20Z' }),
    ];
    collapseDisplay(rows, {
      collapseAuthors: true,
      authorWindowMs: 5 * 60_000,
    });
    expect(rows[2].continuationAuthor).toBeUndefined();
  });
});

describe('collapseDisplay — timestamp collapsing', () => {
  it('hides repeated formatted time strings across consecutive rows', () => {
    const rows = [
      msg({ id: 1, nick: 'alice', time: '2026-05-16T10:00:05Z' }),
      msg({ id: 2, nick: 'bob', time: '2026-05-16T10:00:30Z' }),
      msg({ id: 3, nick: 'carol', time: '2026-05-16T10:00:55Z' }),
      msg({ id: 4, nick: 'dave', time: '2026-05-16T10:01:10Z' }),
    ];
    collapseDisplay(rows, {
      collapseTimestamps: true,
      formatTime: minuteFormat,
    });
    expect(rows[0].continuationTime).toBeUndefined();
    expect(rows[1].continuationTime).toBe(true);
    expect(rows[2].continuationTime).toBe(true);
    expect(rows[3].continuationTime).toBeUndefined();
  });

  it('also applies across system rows and consolidation rows', () => {
    const rows = [
      msg({ id: 1, nick: 'alice', time: '2026-05-16T10:00:00Z' }),
      msg({ id: 2, nick: 'bob', time: '2026-05-16T10:00:10Z', type: 'join' }),
      consolidation({ time: '2026-05-16T10:00:30Z' }),
      msg({ id: 3, nick: 'carol', time: '2026-05-16T10:00:45Z' }),
    ];
    collapseDisplay(rows, {
      collapseTimestamps: true,
      formatTime: minuteFormat,
    });
    expect(rows[0].continuationTime).toBeUndefined();
    expect(rows[1].continuationTime).toBe(true);
    expect(rows[2].continuationTime).toBe(true);
    expect(rows[3].continuationTime).toBe(true);
  });

  it('resets on a divider so the next row re-shows its time', () => {
    const rows = [
      msg({ id: 1, nick: 'alice', time: '2026-05-16T10:00:00Z' }),
      divider({ kind: 'unread' }),
      msg({ id: 2, nick: 'bob', time: '2026-05-16T10:00:10Z' }),
    ];
    collapseDisplay(rows, {
      collapseTimestamps: true,
      formatTime: minuteFormat,
    });
    expect(rows[2].continuationTime).toBeUndefined();
  });

  it('does not flag when the format string is empty (time column hidden)', () => {
    // look.buffer.time_format='' → formatTime returns '', which would otherwise
    // make every adjacent row "match"; the empty-string guard prevents the
    // collapse flag from firing in that case.
    const rows = [
      msg({ id: 1, nick: 'alice', time: '2026-05-16T10:00:00Z' }),
      msg({ id: 2, nick: 'bob', time: '2026-05-16T10:00:10Z' }),
    ];
    collapseDisplay(rows, {
      collapseTimestamps: true,
      formatTime: () => '',
    });
    expect(rows.every((r) => !r.continuationTime)).toBe(true);
  });
});

describe('collapseDisplay — continuation rows participate in time chain', () => {
  // continuationAuthor rows still render their own time span in the template
  // (compact mode's head omission only hides the nick — the body row keeps a
  // right-aligned time). So the time chain must track them like any other
  // visible row, otherwise repeated timestamps fail to collapse.
  it('flags continuationAuthor rows as continuationTime when times match', () => {
    const rows = [
      msg({ id: 1, nick: 'alice', time: '2026-05-16T10:00:00Z' }),
      msg({ id: 2, nick: 'alice', time: '2026-05-16T10:00:30Z' }),
      msg({ id: 3, nick: 'bob', time: '2026-05-16T10:00:45Z' }),
    ];
    collapseDisplay(rows, {
      collapseAuthors: true,
      authorWindowMs: 5 * 60_000,
      collapseTimestamps: true,
      formatTime: minuteFormat,
    });
    expect(rows[1].continuationAuthor).toBe(true);
    expect(rows[1].continuationTime).toBe(true);
    expect(rows[2].continuationTime).toBe(true);
  });
});

describe('collapseDisplay — bypass', () => {
  it('returns rows unchanged when both flags are off', () => {
    const rows = [
      msg({ id: 1, nick: 'alice', time: '2026-05-16T10:00:00Z' }),
      msg({ id: 2, nick: 'alice', time: '2026-05-16T10:00:10Z' }),
    ];
    const result = collapseDisplay(rows, {});
    expect(result).toBe(rows);
    expect(rows.every((r) => !r.continuationAuthor && !r.continuationTime)).toBe(true);
  });
});
