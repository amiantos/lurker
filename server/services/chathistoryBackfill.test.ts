// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The gap-fill walk on its own (#1283): what it asks for, how it pages, when it
// stops. The host is scripted; the wire is ircChathistory.test.ts.

import { describe, it, expect } from 'vitest';
import { ChathistoryBackfill, BOUND_FUZZ_MS } from './chathistoryBackfill.js';
import type { BackfillHost } from './chathistoryBackfill.js';
import type { QueryEnd } from './replyRouter.js';

interface Sent {
  line: string;
  end: (how: QueryEnd) => void;
}

function host(over: Partial<BackfillHost> & { anchors?: Record<string, string | null> } = {}): {
  host: BackfillHost;
  sent: Sent[];
  logged: string[];
} {
  const sent: Sent[] = [];
  const logged: string[] = [];
  const anchors = over.anchors ?? {};
  return {
    sent,
    logged,
    host: {
      send: (line, end) => sent.push({ line, end }),
      limit: () => 100,
      anchor: (target) => anchors[target] ?? null,
      networkAnchor: () =>
        Object.values(anchors)
          .filter((t): t is string => !!t)
          .sort()
          .at(-1) ?? null,
      maxLines: () => 0,
      log: (text) => logged.push(text),
      ...over,
    },
  };
}

const T0 = Date.parse('2026-11-06T10:00:00.000Z');
const at = (ms: number) => new Date(ms).toISOString();

// What the server says back for the request on the wire: a batch of `lines`
// lines, the newest at `newest`.
function reply(
  b: ChathistoryBackfill,
  s: Sent,
  ref: string,
  lines: number,
  newest: string,
  last = false,
) {
  const type = s.line.startsWith('CHATHISTORY TARGETS')
    ? 'draft/chathistory-targets'
    : 'chathistory';
  const target = s.line.startsWith('CHATHISTORY TARGETS') ? undefined : s.line.split(' ')[2];
  b.onBatchStart(ref, type, target, last);
  for (let i = 0; i < lines; i++) b.onBatchLine(ref, i === lines - 1 ? newest : at(T0 + i));
  s.end('replied');
}

describe('ChathistoryBackfill', () => {
  it('asks BETWEEN the newest stored line and the join, a second of fuzz each way', () => {
    const h = host({ anchors: { '#c': at(T0) } });
    const b = new ChathistoryBackfill(h.host);
    b.channelJoined('#c', T0 + 60_000);
    expect(h.sent.map((s) => s.line)).toEqual([
      `CHATHISTORY BETWEEN #c timestamp=${at(T0 - BOUND_FUZZ_MS)} timestamp=${at(T0 + 60_000 + BOUND_FUZZ_MS)} 100`,
    ]);
  });

  it('asks nothing for a buffer with nothing stored: no gap, a first join', () => {
    const h = host();
    const b = new ChathistoryBackfill(h.host);
    b.channelJoined('#new', T0);
    b.registered(T0);
    expect(h.sent).toEqual([]);
  });

  it('honours the ISUPPORT limit, capped at 1000, and 0 means 1000', () => {
    for (const [token, expected] of [
      [50, 50],
      [5000, 1000],
      [0, 1000],
    ] as const) {
      const h = host({ anchors: { '#c': at(T0) }, limit: () => token });
      new ChathistoryBackfill(h.host).channelJoined('#c', T0);
      expect(h.sent[0].line.endsWith(` ${expected}`)).toBe(true);
    }
  });

  it('pages while pages come back full, from the newest line of each, and stops on a short one', () => {
    const h = host({ anchors: { '#c': at(T0) }, limit: () => 2 });
    const b = new ChathistoryBackfill(h.host);
    b.channelJoined('#c', T0 + 60_000);
    reply(b, h.sent[0], 'r1', 2, at(T0 + 10_000));
    expect(h.sent).toHaveLength(2);
    // The next page starts a millisecond under the newest line it got.
    expect(h.sent[1].line).toContain(`timestamp=${at(T0 + 10_000 - 1)} timestamp=`);
    reply(b, h.sent[1], 'r2', 2, at(T0 + 20_000));
    reply(b, h.sent[2], 'r3', 1, at(T0 + 25_000));
    expect(h.sent).toHaveLength(3);
    expect(h.logged).toEqual(['History backfill: #c caught up 5 lines in 3 pages']);
  });

  it('stops on draft/chathistory-end even when the page is full', () => {
    const h = host({ anchors: { '#c': at(T0) }, limit: () => 2 });
    const b = new ChathistoryBackfill(h.host);
    b.channelJoined('#c', T0 + 60_000);
    reply(b, h.sent[0], 'r1', 2, at(T0 + 10_000), true);
    expect(h.sent).toHaveLength(1);
  });

  it('stops when a full page made no progress', () => {
    const h = host({ anchors: { '#c': at(T0) }, limit: () => 2 });
    const b = new ChathistoryBackfill(h.host);
    b.channelJoined('#c', T0 + 60_000);
    // Two lines at the lower bound itself: nothing newer than where we started.
    b.onBatchStart('r1', 'chathistory', '#c', false);
    b.onBatchLine('r1', at(T0 - BOUND_FUZZ_MS));
    b.onBatchLine('r1', at(T0 - BOUND_FUZZ_MS));
    h.sent[0].end('replied');
    expect(h.sent).toHaveLength(1);
  });

  it('stops at the buffer’s retention: the rest would be swept', () => {
    const h = host({ anchors: { '#c': at(T0) }, limit: () => 2, maxLines: () => 3 });
    const b = new ChathistoryBackfill(h.host);
    b.channelJoined('#c', T0 + 60_000);
    reply(b, h.sent[0], 'r1', 2, at(T0 + 10_000));
    reply(b, h.sent[1], 'r2', 2, at(T0 + 20_000));
    expect(h.sent).toHaveLength(2);
  });

  it('one request on the wire at a time, in order', () => {
    const h = host({ anchors: { '#a': at(T0), '#b': at(T0) } });
    const b = new ChathistoryBackfill(h.host);
    b.channelJoined('#a', T0);
    b.channelJoined('#b', T0);
    expect(h.sent).toHaveLength(1);
    reply(b, h.sent[0], 'r1', 0, at(T0));
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1].line).toContain(' #b ');
  });

  it('TARGETS names the DMs that had a line; each gets a window from its own newest line', () => {
    const h = host({ anchors: { '#c': at(T0 + 5000), bob: at(T0) } });
    const b = new ChathistoryBackfill(h.host);
    b.registered(T0 + 60_000);
    expect(h.sent[0].line).toBe(
      `CHATHISTORY TARGETS timestamp=${at(T0 + 5000 - BOUND_FUZZ_MS)} timestamp=${at(T0 + 60_000 + BOUND_FUZZ_MS)} 100`,
    );
    b.onBatchStart('t1', 'draft/chathistory-targets', undefined, false);
    b.onTargetsLine('t1', '#c', at(T0 + 30_000));
    b.onTargetsLine('t1', 'bob', at(T0 + 30_000));
    b.onTargetsLine('t1', 'carol', at(T0 + 40_000));
    h.sent[0].end('replied');
    // Channels are the JOIN's; bob from his newest stored line, carol (new in
    // the gap) from the network's.
    expect(h.sent.slice(1).map((s) => s.line)).toEqual([
      `CHATHISTORY BETWEEN bob timestamp=${at(T0 - BOUND_FUZZ_MS)} timestamp=${at(T0 + 60_000 + BOUND_FUZZ_MS)} 100`,
    ]);
    reply(b, h.sent[1], 'r1', 1, at(T0 + 30_000));
    expect(h.sent[2].line).toBe(
      `CHATHISTORY BETWEEN carol timestamp=${at(T0 + 5000 - BOUND_FUZZ_MS)} timestamp=${at(T0 + 60_000 + BOUND_FUZZ_MS)} 100`,
    );
  });

  it('a refusal ends that walk and the next goes', () => {
    const h = host({ anchors: { '#a': at(T0), '#b': at(T0) } });
    const b = new ChathistoryBackfill(h.host);
    b.channelJoined('#a', T0);
    b.channelJoined('#b', T0);
    h.sent[0].end('error');
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1].line).toContain(' #b ');
  });

  it('a network that answers nothing is not asked again on this socket', () => {
    const h = host({ anchors: { '#a': at(T0), '#b': at(T0) } });
    const b = new ChathistoryBackfill(h.host);
    b.channelJoined('#a', T0);
    b.channelJoined('#b', T0);
    h.sent[0].end('timeout');
    expect(h.sent).toHaveLength(1);
    b.channelJoined('#a', T0);
    expect(h.sent).toHaveLength(1);
    expect(h.logged[0]).toMatch(/answered no CHATHISTORY/);
    // The next socket starts clean.
    b.reset();
    b.channelJoined('#a', T0);
    expect(h.sent).toHaveLength(2);
  });

  it('a batch that went quiet after opening is taken as the page it was', () => {
    const h = host({ anchors: { '#c': at(T0) }, limit: () => 2 });
    const b = new ChathistoryBackfill(h.host);
    b.channelJoined('#c', T0 + 60_000);
    b.onBatchStart('r1', 'chathistory', '#c', false);
    b.onBatchLine('r1', at(T0 + 1000));
    h.sent[0].end('timeout');
    expect(h.sent).toHaveLength(1);
    expect(h.logged).toEqual(['History backfill: #c caught up 1 line']);
  });

  it('a hole in the engine backlog asks for every channel, from the rows before the attach to the drop', () => {
    const asked: Array<[string, number | undefined]> = [];
    const h = host({
      anchor: (target, maxId) => {
        asked.push([target, maxId]);
        return target === '#a' ? at(T0) : null;
      },
    });
    const b = new ChathistoryBackfill(h.host);
    b.gap(['#a', '#b'], T0 + 60_000, 4242);
    expect(asked).toEqual([
      ['#a', 4242],
      ['#b', 4242],
    ]);
    expect(h.sent.map((s) => s.line)).toEqual([
      `CHATHISTORY BETWEEN #a timestamp=${at(T0 - BOUND_FUZZ_MS)} timestamp=${at(T0 + 60_000 + BOUND_FUZZ_MS)} 100`,
    ]);
  });

  it('reset drops the walk and the request on the wire', () => {
    const h = host({ anchors: { '#a': at(T0), '#b': at(T0) } });
    const b = new ChathistoryBackfill(h.host);
    b.channelJoined('#a', T0);
    b.channelJoined('#b', T0);
    b.reset();
    h.sent[0].end('replied');
    expect(h.sent).toHaveLength(1);
    expect(b.isOurs('anything')).toBe(false);
  });
});
