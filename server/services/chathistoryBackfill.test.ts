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
          .toSorted()
          .at(-1) ?? null,
      maxLines: () => 0,
      fold: (name) => name.toLowerCase(),
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
  for (let i = 0; i < lines; i++) b.onBatchLine(ref, i === lines - 1 ? newest : at(T0 + i), true);
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
    b.onBatchLine('r1', at(T0 - BOUND_FUZZ_MS), true);
    b.onBatchLine('r1', at(T0 - BOUND_FUZZ_MS), true);
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

  it('retention counts conversation only: a page of reactions does not use it up', () => {
    const h = host({ anchors: { '#c': at(T0) }, limit: () => 2, maxLines: () => 3 });
    const b = new ChathistoryBackfill(h.host);
    b.channelJoined('#c', T0 + 60_000);
    // A full page that is one message and one reaction: the page is full for
    // the server (two lines), one line for retention.
    b.onBatchStart('r1', 'chathistory', '#c', false);
    b.onBatchLine('r1', at(T0 + 1000), true);
    b.onBatchLine('r1', at(T0 + 2000), false);
    h.sent[0].end('replied');
    b.onBatchStart('r2', 'chathistory', '#c', false);
    b.onBatchLine('r2', at(T0 + 3000), true);
    b.onBatchLine('r2', at(T0 + 4000), false);
    h.sent[1].end('replied');
    // Two conversation lines of three allowed: one more page goes.
    expect(h.sent).toHaveLength(3);
    expect(h.logged).toEqual([]);
  });

  it('a batch naming the target in another case is still ours, by the network’s fold', () => {
    const h = host({ anchors: { '#Chan': at(T0) }, limit: () => 2 });
    const b = new ChathistoryBackfill(h.host);
    b.channelJoined('#Chan', T0 + 60_000);
    b.onBatchStart('r1', 'chathistory', '#CHAN', false);
    expect(b.isOurs('r1')).toBe(true);
  });

  it('TARGETS pages on the newest time its lines name', () => {
    const h = host({ anchors: { '#c': at(T0), bob: at(T0) }, limit: () => 2 });
    const b = new ChathistoryBackfill(h.host);
    b.registered(T0 + 60_000);
    b.onBatchStart('t1', 'draft/chathistory-targets', undefined, false);
    b.onTargetsLine('t1', 'bob', at(T0 + 10_000));
    b.onBatchLine('t1', undefined, false);
    b.onTargetsLine('t1', 'carol', at(T0 + 20_000));
    b.onBatchLine('t1', undefined, false);
    h.sent[0].end('replied');
    // A full page: the next TARGETS page goes first, from under its newest.
    expect(h.sent[1].line).toBe(
      `CHATHISTORY TARGETS timestamp=${at(T0 + 20_000 - 1)} timestamp=${at(T0 + 60_000 + BOUND_FUZZ_MS)} 2`,
    );
    // The next page names carol again (the cursor sits under her time) and
    // one more; carol is not windowed twice.
    b.onBatchStart('t2', 'draft/chathistory-targets', undefined, false);
    b.onTargetsLine('t2', 'carol', at(T0 + 20_000));
    b.onBatchLine('t2', undefined, false);
    b.onTargetsLine('t2', 'dave', at(T0 + 30_000));
    b.onBatchLine('t2', undefined, false);
    h.sent[1].end('replied');
    b.onBatchStart('t3', 'draft/chathistory-targets', undefined, false);
    h.sent[2].end('replied');
    // One window on the wire at a time: each goes as the last ends.
    const windows: string[] = [];
    for (let i = 3; i < 6; i++) {
      windows.push(h.sent[i].line.split(' ')[2]);
      reply(b, h.sent[i], `w${i}`, 0, at(T0));
    }
    expect(windows).toEqual(['bob', 'carol', 'dave']);
    expect(h.sent).toHaveLength(6);
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

  it('a network that answers nothing twice running is not asked again on this socket', () => {
    const h = host({ anchors: { '#a': at(T0), '#b': at(T0), '#c': at(T0) } });
    const b = new ChathistoryBackfill(h.host);
    b.channelJoined('#a', T0);
    b.channelJoined('#b', T0);
    b.channelJoined('#c', T0);
    // One unanswered request is a lagging server: that walk is lost, the
    // next goes.
    h.sent[0].end('timeout');
    expect(h.sent).toHaveLength(2);
    expect(h.logged).toEqual([]);
    // Two running: the cap is not honoured. The rest of the queue goes too.
    h.sent[1].end('timeout');
    expect(h.sent).toHaveLength(2);
    b.channelJoined('#a', T0);
    expect(h.sent).toHaveLength(2);
    expect(h.logged[0]).toMatch(/answered no CHATHISTORY/);
    // The next socket starts clean.
    b.reset();
    b.channelJoined('#a', T0);
    expect(h.sent).toHaveLength(3);
  });

  it('an answer in between starts the count over', () => {
    const h = host({ anchors: { '#a': at(T0), '#b': at(T0), '#c': at(T0) } });
    const b = new ChathistoryBackfill(h.host);
    b.channelJoined('#a', T0);
    b.channelJoined('#b', T0);
    b.channelJoined('#c', T0);
    h.sent[0].end('timeout');
    reply(b, h.sent[1], 'r2', 0, at(T0));
    h.sent[2].end('timeout');
    b.channelJoined('#a', T0);
    expect(h.sent).toHaveLength(4);
  });

  it('a batch that went quiet after opening is taken as the page it was', () => {
    const h = host({ anchors: { '#c': at(T0) }, limit: () => 2 });
    const b = new ChathistoryBackfill(h.host);
    b.channelJoined('#c', T0 + 60_000);
    b.onBatchStart('r1', 'chathistory', '#c', false);
    b.onBatchLine('r1', at(T0 + 1000), true);
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
