// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The per-connection outbound queue (#1149): the burst budget, order, the
// lanes, the bypasses, thunks, units, cancel, onSent/onDropped, hold and drop.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SendPacer, lineCostMs, BURST_BUDGET_MS, EMPTY_HOLD_MS } from './sendPacer.js';

const SHORT = 'PRIVMSG #c :hi'; // 16 bytes with CRLF: 2 s
const LONG = `PRIVMSG #c :${'x'.repeat(284)}`; // 298 bytes with CRLF: 4 s

// Pacing is off for the suite (test-utils/setup.ts); this file is about it.
beforeEach(() => {
  process.env.LURKER_SEND_PACING = '1';
});
afterEach(() => {
  process.env.LURKER_SEND_PACING = '0';
});

describe('lineCostMs', () => {
  it('is 2 s plus 1 s per 100 bytes', () => {
    expect(lineCostMs(16)).toBe(2000);
    expect(lineCostMs(99)).toBe(2000);
    expect(lineCostMs(100)).toBe(3000);
    expect(lineCostMs(298)).toBe(4000);
    expect(lineCostMs(512)).toBe(7000);
  });

  it('is free with LURKER_SEND_PACING=0', () => {
    process.env.LURKER_SEND_PACING = '0';
    expect(lineCostMs(512)).toBe(0);
  });
});

describe('SendPacer', () => {
  let sent: string[];
  let ready: boolean;
  let depths: number[];
  let pacer: SendPacer;

  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setImmediate', 'clearImmediate', 'performance'],
    });
    sent = [];
    ready = true;
    depths = [];
    pacer = new SendPacer({
      send: (l) => {
        sent.push(l);
      },
      ready: () => ready,
      onDepth: (n) => depths.push(n),
      maxKeyed: 2,
    });
  });
  afterEach(() => {
    pacer.dispose();
    vi.useRealTimers();
  });

  describe('the budget', () => {
    it('sends five short lines at once, then one every 2 s', () => {
      for (let i = 0; i < 7; i++) pacer.write(`PRIVMSG #c :${i}`);
      expect(sent).toHaveLength(5);
      vi.advanceTimersByTime(1999);
      expect(sent).toHaveLength(5);
      vi.advanceTimersByTime(1);
      expect(sent).toHaveLength(6);
      vi.advanceTimersByTime(2000);
      expect(sent).toHaveLength(7);
    });

    it('charges long lines by their bytes', () => {
      for (let i = 0; i < 4; i++) pacer.write(LONG);
      // 4 s each: two fit under the 10 s budget, the third waits for the
      // charge to decay enough to take it.
      expect(sent).toHaveLength(2);
      vi.advanceTimersByTime(1999);
      expect(sent).toHaveLength(2);
      vi.advanceTimersByTime(1);
      expect(sent).toHaveLength(3);
      vi.advanceTimersByTime(4000);
      expect(sent).toHaveLength(4);
    });

    it('lets the charge decay in real time', () => {
      for (let i = 0; i < 5; i++) pacer.write(SHORT);
      vi.advanceTimersByTime(BURST_BUDGET_MS);
      for (let i = 0; i < 5; i++) pacer.write(SHORT);
      expect(sent).toHaveLength(10);
    });

    it('keeps order: a short line waits behind a long one', () => {
      for (let i = 0; i < 3; i++) pacer.write(LONG);
      pacer.write(SHORT);
      expect(sent).toHaveLength(2);
      vi.advanceTimersByTime(2000);
      expect(sent).toEqual([LONG, LONG, LONG]);
      vi.advanceTimersByTime(1999);
      expect(sent).toHaveLength(3);
      vi.advanceTimersByTime(1);
      expect(sent.at(-1)).toBe(SHORT);
    });
  });

  describe('bypasses', () => {
    it('lets PING, PONG and QUIT past a wait', () => {
      for (let i = 0; i < 5; i++) pacer.write(SHORT);
      pacer.write('PRIVMSG #c :held');
      pacer.write('PONG :srv');
      pacer.write('@label=1 PING lurker-lag-1');
      pacer.write('QUIT :bye');
      expect(sent.slice(5)).toEqual(['PONG :srv', '@label=1 PING lurker-lag-1', 'QUIT :bye']);
      expect(pacer.pending).toBe(1);
    });

    it('sends everything at once before registration, uncharged', () => {
      ready = false;
      for (let i = 0; i < 8; i++) pacer.write(LONG);
      expect(sent).toHaveLength(8);
      ready = true;
      pacer.write(SHORT);
      expect(sent).toHaveLength(9);
    });

    it('sends a thunk and a unit at once before registration too', () => {
      ready = false;
      const log: string[] = [];
      pacer.write(() => [{ text: 'NOTICE bob :a', onSent: () => log.push('a') }, 'NOTICE bob :b'], {
        onSent: () => log.push('item'),
      });
      pacer.unit(['BATCH +r', 'BATCH -r'], { onSent: () => log.push('unit') });
      expect(sent).toEqual(['NOTICE bob :a', 'NOTICE bob :b', 'BATCH +r', 'BATCH -r']);
      expect(log).toEqual(['a', 'item', 'unit']);
    });

    it('sends the registration burst past held lines', () => {
      pacer.write(SHORT);
      for (let i = 0; i < 5; i++) pacer.write(SHORT);
      ready = false;
      pacer.write('NICK me');
      expect(sent.at(-1)).toBe('NICK me');
      expect(pacer.pending).toBe(1);
    });
  });

  describe('hold and drop', () => {
    it('holds the queue while the connection is down, and sends it on resume', () => {
      for (let i = 0; i < 5; i++) pacer.write(SHORT);
      pacer.write('PRIVMSG #c :held');
      ready = false;
      vi.advanceTimersByTime(5000);
      expect(sent).toHaveLength(5);
      ready = true;
      pacer.resume();
      expect(sent.at(-1)).toBe('PRIVMSG #c :held');
    });

    it('drops the queue and the charge for a new socket, and tells each item', () => {
      const dropped: string[] = [];
      for (let i = 0; i < 5; i++) pacer.write(SHORT);
      pacer.write('PRIVMSG #c :stale', { onDropped: () => dropped.push('stale') });
      pacer.write(() => 'PRIVMSG #c :thunk', { onDropped: () => dropped.push('thunk') });
      pacer.drop();
      expect(dropped).toEqual(['stale', 'thunk']);
      vi.advanceTimersByTime(10_000);
      expect(sent).toHaveLength(5);
      pacer.write('PRIVMSG #c :fresh');
      expect(sent.at(-1)).toBe('PRIVMSG #c :fresh');
    });

    it('drops a write after dispose', () => {
      const dropped = vi.fn<() => void>();
      pacer.dispose();
      pacer.write(SHORT, { onDropped: dropped });
      expect(dropped).toHaveBeenCalledOnce();
      expect(sent).toEqual([]);
    });
  });

  describe('keyed items', () => {
    it('replaces a queued keyed line in place, and drops the oldest over the cap', () => {
      const dropped: string[] = [];
      for (let i = 0; i < 5; i++) pacer.write(SHORT);
      pacer.write('NOTICE bob :old', { key: 'bob', onDropped: () => dropped.push('bob') });
      pacer.write('NOTICE carol :c', { key: 'carol', onDropped: () => dropped.push('carol') });
      pacer.write('NOTICE bob :new', { key: 'bob', onDropped: () => dropped.push('bob') });
      pacer.write('PRIVMSG #c :mine');
      pacer.write('NOTICE dave :d', { key: 'dave' });
      expect(dropped).toEqual(['bob']);
      vi.advanceTimersByTime(20_000);
      expect(sent.slice(5)).toEqual(['NOTICE carol :c', 'PRIVMSG #c :mine', 'NOTICE dave :d']);
    });
  });

  describe('thunks', () => {
    it('makes the line when its turn comes', () => {
      let nick = 'bob';
      for (let i = 0; i < 5; i++) pacer.write(SHORT);
      pacer.write(() => `NOTICE ${nick} :hi`);
      nick = 'bob2';
      vi.advanceTimersByTime(2001);
      expect(sent.at(-1)).toBe('NOTICE bob2 :hi');
    });

    it('skips a thunk that returns null or throws, without charge', () => {
      pacer.write(() => null);
      pacer.write(() => {
        throw new Error('no');
      });
      for (let i = 0; i < 5; i++) pacer.write(SHORT);
      expect(sent).toHaveLength(5);
    });

    it('paces the lines a thunk expands to one by one, in order, with their callbacks', () => {
      const log: string[] = [];
      pacer.write(
        () => [
          { text: 'NOTICE bob :REKEY', onSent: () => log.push('rekey') },
          { text: LONG, onSent: () => log.push('chunk1') },
          { text: LONG, onSent: () => log.push('chunk2') },
          { text: LONG, onSent: () => log.push('chunk3') },
        ],
        { onSent: () => log.push('message') },
      );
      pacer.write(SHORT);
      // 2 + 4 + 4 = 10 s fit; the third chunk waits.
      expect(sent).toEqual(['NOTICE bob :REKEY', LONG, LONG]);
      expect(log).toEqual(['rekey', 'chunk1', 'chunk2']);
      vi.advanceTimersByTime(4000);
      expect(sent).toHaveLength(4);
      expect(log).toEqual(['rekey', 'chunk1', 'chunk2', 'chunk3', 'message']);
      vi.advanceTimersByTime(2000);
      expect(sent.at(-1)).toBe(SHORT);
    });

    it('tells a dropped thunk once, however many lines it expanded to', () => {
      const dropped = vi.fn<() => void>();
      for (let i = 0; i < 5; i++) pacer.write(SHORT);
      pacer.write(() => [LONG, LONG, LONG], { onDropped: dropped });
      vi.advanceTimersByTime(4000);
      expect(sent).toHaveLength(6);
      pacer.drop();
      expect(dropped).toHaveBeenCalledOnce();
    });
  });

  describe('units', () => {
    it('sends a unit back to back and charges for all of it after', () => {
      const batch = [
        'BATCH +r draft/multiline #c',
        `@batch=r ${LONG}`,
        `@batch=r ${LONG}`,
        'BATCH -r',
      ];
      pacer.unit(batch);
      pacer.write(SHORT);
      expect(sent).toEqual(batch);
      // 2 + 5 + 5 + 2 = 14 s charged: the short line fits once 6 s have gone.
      vi.advanceTimersByTime(5999);
      expect(sent).toHaveLength(4);
      vi.advanceTimersByTime(1);
      expect(sent.at(-1)).toBe(SHORT);
    });
  });

  describe('liveness, nesting and re-entrancy', () => {
    it('asks live() when the line is due, and sends nothing for a withdrawn one', () => {
      let wanted = true;
      for (let i = 0; i < 5; i++) pacer.write(SHORT);
      pacer.write('PRIVMSG bob :\u0001DCC SEND f 1 2 3\u0001', { live: () => wanted });
      pacer.write(SHORT);
      wanted = false;
      vi.advanceTimersByTime(2000);
      expect(sent.at(-1)).toBe(SHORT);
      expect(sent).toHaveLength(6);
    });

    it('runs a thunk a thunk made at its own turn', () => {
      let nick = 'carol';
      for (let i = 0; i < 5; i++) pacer.write(SHORT);
      pacer.write(() => [LONG, () => `NOTICE ${nick} :REKEY`]);
      vi.advanceTimersByTime(2000);
      // The outer thunk ran; its long line waits for the budget, and the
      // thunk behind it has not run.
      expect(sent).toHaveLength(5);
      nick = 'carol2';
      vi.advanceTimersByTime(2000);
      expect(sent.slice(5)).toEqual([LONG]);
      vi.advanceTimersByTime(2000);
      expect(sent.slice(5)).toEqual([LONG, 'NOTICE carol2 :REKEY']);
    });

    it('makes a line whose text is a function when that line goes', () => {
      let nick = 'carol';
      const dropped = vi.fn<() => void>();
      for (let i = 0; i < 5; i++) pacer.write(SHORT);
      pacer.write(() => [LONG, { text: () => `NOTICE ${nick} :REKEY`, onDropped: dropped }]);
      vi.advanceTimersByTime(4000);
      expect(sent.slice(5)).toEqual([LONG]);
      nick = 'carol2';
      vi.advanceTimersByTime(2000);
      expect(sent.at(-1)).toBe('NOTICE carol2 :REKEY');
      expect(dropped).not.toHaveBeenCalled();
    });

    it('cancels what a thunk expanded to', () => {
      for (let i = 0; i < 5; i++) pacer.write(SHORT);
      const h = pacer.write(() => [LONG, LONG]);
      vi.advanceTimersByTime(2000);
      expect(sent).toHaveLength(5);
      expect(h.cancel()).toBe(true);
      vi.advanceTimersByTime(20_000);
      expect(sent).toHaveLength(5);
    });

    it("tells an expanded line's own onDropped and its item's, once each", () => {
      const log: string[] = [];
      for (let i = 0; i < 5; i++) pacer.write(SHORT);
      pacer.write(
        () => [
          { text: LONG, onDropped: () => log.push('rekey') },
          { text: LONG, onDropped: () => log.push('chunk') },
        ],
        { onDropped: () => log.push('message') },
      );
      vi.advanceTimersByTime(2000);
      pacer.drop();
      expect(log.sort()).toEqual(['chunk', 'message', 'rekey']);
    });

    it('drops a write made from an onDropped during dispose', () => {
      for (let i = 0; i < 5; i++) pacer.write(SHORT);
      const dropped = vi.fn<() => void>();
      pacer.write(SHORT, {
        onDropped: () => pacer.write('PRIVMSG #c :from the grave', { onDropped: dropped }),
      });
      pacer.dispose();
      expect(sent).toHaveLength(5);
      expect(dropped).toHaveBeenCalledOnce();
    });

    it('keeps the keyed cap when an evicted item writes another from its onDropped', () => {
      for (let i = 0; i < 5; i++) pacer.write(SHORT);
      pacer.write('NOTICE bob :b', {
        key: 'bob',
        onDropped: () => pacer.write('NOTICE eric :e', { key: 'eric' }),
      });
      pacer.write('NOTICE carol :c', { key: 'carol' });
      pacer.write('NOTICE dave :d', { key: 'dave' });
      expect(pacer.pending).toBe(2);
    });
  });

  describe('handles and callbacks', () => {
    it('cancels a waiting item, and not a sent one', () => {
      const h1 = pacer.write(SHORT);
      for (let i = 0; i < 4; i++) pacer.write(SHORT);
      const h2 = pacer.write('PRIVMSG #c :withdrawn');
      expect(h1.cancel()).toBe(false);
      expect(h2.cancel()).toBe(true);
      expect(h2.cancel()).toBe(false);
      vi.advanceTimersByTime(10_000);
      expect(sent).not.toContain('PRIVMSG #c :withdrawn');
    });

    it('calls onSent with the send time, not the write time', () => {
      const at: number[] = [];
      for (let i = 0; i < 5; i++) pacer.write(SHORT);
      pacer.write(SHORT, { onSent: (t) => at.push(t) });
      const wrote = performance.now();
      vi.advanceTimersByTime(2000);
      expect(at).toEqual([wrote + 2000]);
    });

    it('reports the depth once per tick, and only when it changes', () => {
      for (let i = 0; i < 8; i++) pacer.write(SHORT);
      vi.advanceTimersByTime(1);
      expect(depths).toEqual([3]);
      vi.advanceTimersByTime(2000);
      expect(depths).toEqual([3, 2]);
      vi.advanceTimersByTime(1);
      expect(depths).toEqual([3, 2]);
      pacer.drop();
      vi.advanceTimersByTime(1);
      expect(depths).toEqual([3, 2, 0]);
    });

    it('reports empty at once on dispose, with no tick left to do it', () => {
      fill();
      pacer.write(SHORT);
      vi.advanceTimersByTime(1);
      expect(depths).toEqual([1]);
      pacer.dispose();
      expect(depths).toEqual([1, 0]);
    });

    it('reports empty once the queue has stayed empty EMPTY_HOLD_MS', () => {
      fill();
      pacer.write(SHORT);
      vi.advanceTimersByTime(1);
      expect(depths).toEqual([1]);
      vi.advanceTimersByTime(2000);
      expect(sent).toHaveLength(6);
      vi.advanceTimersByTime(EMPTY_HOLD_MS - 1);
      expect(depths).toEqual([1]);
      vi.advanceTimersByTime(1);
      expect(depths).toEqual([1, 0]);
    });

    it('a line written during the hold is a rise, not a blink', () => {
      fill();
      pacer.write(SHORT);
      // The line went at 2000; the depth report ran a tick later and armed
      // the hold. Written now, the lines are a rise, and the armed hold goes.
      vi.advanceTimersByTime(2001);
      expect(sent).toHaveLength(6);
      pacer.write(SHORT);
      pacer.write(SHORT);
      vi.advanceTimersByTime(1);
      expect(depths).toEqual([1, 2]);
      // Past when that hold would have fired: no 0 from it. One line per 2 s.
      vi.advanceTimersByTime(EMPTY_HOLD_MS);
      expect(sent).toHaveLength(7);
      expect(depths).toEqual([1, 2, 1]);
      vi.advanceTimersByTime(2000);
      expect(sent).toHaveLength(8);
      expect(depths).toEqual([1, 2, 1]);
      vi.advanceTimersByTime(EMPTY_HOLD_MS);
      expect(depths).toEqual([1, 2, 1, 0]);
    });
  });

  // The budget spent, so the next line waits 2 s.
  function fill(): void {
    for (let i = 0; i < 5; i++) pacer.write(`PRIVMSG #f :${i}`);
    expect(sent).toHaveLength(5);
  }

  describe('a line the socket refuses (#1259)', () => {
    // `send` answers false once a disconnect is under way: the framework would
    // drop the line in silence, so the pacer must not call it sent.
    let refusing: boolean;
    beforeEach(() => {
      refusing = false;
      pacer.dispose();
      pacer = new SendPacer({
        send: (l) => {
          if (refusing) return false;
          sent.push(l);
        },
        ready: () => ready,
        onDepth: (n) => depths.push(n),
      });
    });

    it('tells an immediate line dropped, not sent, and charges nothing for it', () => {
      const onSent = vi.fn<(at: number) => void>();
      const onDropped = vi.fn<() => void>();
      refusing = true;
      pacer.write(LONG, { onSent, onDropped });
      expect(sent).toEqual([]);
      expect(onSent).not.toHaveBeenCalled();
      expect(onDropped).toHaveBeenCalledOnce();
      // Uncharged: five short lines still fit the budget exactly, as they do
      // from a clean start. Had the refused line been charged, the fifth waits.
      refusing = false;
      for (let i = 0; i < 5; i++) pacer.write(SHORT);
      expect(sent).toHaveLength(5);
    });

    it('tells a line written before registration the same way', () => {
      const onDropped = vi.fn<() => void>();
      ready = false;
      refusing = true;
      pacer.write('NICK alice', { onDropped });
      expect(sent).toEqual([]);
      expect(onDropped).toHaveBeenCalledOnce();
    });

    it('stops draining, leaving the rest for drop() to tell once each', () => {
      fill();
      const told: string[] = [];
      pacer.write('PRIVMSG #c :first', { onDropped: () => told.push('first') });
      pacer.write('PRIVMSG #c :second', { onDropped: () => told.push('second') });
      refusing = true;
      vi.advanceTimersByTime(2000);
      expect(told).toEqual(['first']);
      expect(pacer.pending).toBe(1);
      vi.advanceTimersByTime(10_000);
      expect(told).toEqual(['first']);
      pacer.drop();
      expect(told).toEqual(['first', 'second']);
      expect(sent).toHaveLength(5);
    });

    it('tells a thunk once, through the line it made, and never calls it sent', () => {
      const onSent = vi.fn<(at: number) => void>();
      const onDropped = vi.fn<() => void>();
      refusing = true;
      pacer.write(() => ['PRIVMSG #c :a', 'PRIVMSG #c :b'], { onSent, onDropped });
      expect(sent).toEqual([]);
      expect(onSent).not.toHaveBeenCalled();
      expect(onDropped).toHaveBeenCalledOnce();
    });

    it('tells a unit once when a line of it is refused, keeping what went', () => {
      const onSent = vi.fn<(at: number) => void>();
      const onDropped = vi.fn<() => void>();
      let lines = 0;
      pacer = new SendPacer({
        send: (l) => {
          // The socket goes away between the batch's first and second line.
          if (lines++ >= 1) return false;
          sent.push(l);
        },
        ready: () => ready,
      });
      pacer.unit(['BATCH +x draft/multiline #c', '@batch=x PRIVMSG #c :a', 'BATCH -x'], {
        onSent,
        onDropped,
      });
      expect(sent).toEqual(['BATCH +x draft/multiline #c']);
      expect(onSent).not.toHaveBeenCalled();
      expect(onDropped).toHaveBeenCalledOnce();
    });
  });

  describe('flood protection off (#1193)', () => {
    let paced: boolean;
    beforeEach(() => {
      paced = true;
      pacer.dispose();
      pacer = new SendPacer({
        send: (l) => {
          sent.push(l);
        },
        ready: () => ready,
        onDepth: (n) => depths.push(n),
        paced: () => paced,
      });
    });

    it('sends everything at once, in lane order, and charges nothing', () => {
      paced = false;
      for (let i = 0; i < 12; i++) pacer.write(`PRIVMSG #c :${i}`);
      pacer.write(LONG);
      pacer.write('JOIN #b', { priority: 'high' });
      expect(sent).toHaveLength(14);
      expect(sent.at(-1)).toBe('JOIN #b');
      expect(pacer.pending).toBe(0);
      // A thunk and a unit go the same way.
      pacer.write(() => [{ text: 'NOTICE bob :built' }]);
      pacer.unit(['PRIVMSG #c :1/2', 'PRIVMSG #c :2/2']);
      expect(sent.slice(-3)).toEqual(['NOTICE bob :built', 'PRIVMSG #c :1/2', 'PRIVMSG #c :2/2']);
    });

    it('turned off mid-wait, a backlog goes now, not when its timer fires', () => {
      fill();
      pacer.write('PRIVMSG #c :waiting');
      pacer.write('PRIVMSG #c :too');
      expect(sent).toHaveLength(5);
      paced = false;
      pacer.redrain();
      expect(sent).toHaveLength(7);
      vi.advanceTimersByTime(10_000);
      expect(sent).toHaveLength(7);
    });

    it('turned off with the clock already past the budget, the backlog goes now too', () => {
      // A unit is admitted on its first line and charged whole, so it can
      // leave the clock past the budget; unpaced, nothing waits that out.
      fill();
      pacer.unit(['PRIVMSG #c :1/3', 'PRIVMSG #c :2/3', 'PRIVMSG #c :3/3']);
      pacer.write('PRIVMSG #c :waiting');
      vi.advanceTimersByTime(2000);
      expect(sent).toHaveLength(8);
      paced = false;
      pacer.redrain();
      expect(sent).toHaveLength(9);
    });

    it('still holds while holding() says so, and still drops with its socket', () => {
      let hold = true;
      pacer.dispose();
      pacer = new SendPacer({
        send: (l) => {
          sent.push(l);
        },
        ready: () => ready,
        holding: () => hold,
        paced: () => false,
      });
      const dropped: string[] = [];
      pacer.write('PRIVMSG #c :held', { onDropped: () => dropped.push('held') });
      expect(sent).toHaveLength(0);
      pacer.drop();
      expect(dropped).toEqual(['held']);
      hold = false;
      pacer.write('PRIVMSG #c :now');
      expect(sent).toEqual(['PRIVMSG #c :now']);
    });

    it('turned back on, the clock starts from nothing: what went unpaced is not charged', () => {
      paced = false;
      for (let i = 0; i < 20; i++) pacer.write(`PRIVMSG #c :${i}`);
      // A unit is charged whole after it goes, and unpaced that is nothing too.
      pacer.unit([LONG, LONG, LONG]);
      expect(sent).toHaveLength(23);
      paced = true;
      pacer.redrain();
      for (let i = 0; i < 6; i++) pacer.write(`PRIVMSG #c :again ${i}`);
      // Five fit under the fresh budget; the sixth waits its 2 s.
      expect(sent).toHaveLength(28);
      vi.advanceTimersByTime(2000);
      expect(sent).toHaveLength(29);
    });
  });

  describe('holding', () => {
    it('keeps what waits waiting while holding() says so, though the connection is ready', () => {
      let holding = false;
      pacer = new SendPacer({
        send: (l) => {
          sent.push(l);
        },
        ready: () => ready,
        holding: () => holding,
      });
      fill();
      pacer.write(SHORT);
      holding = true;
      // A write meanwhile drains, and must not send the held line.
      pacer.write('MONITOR + bob');
      vi.advanceTimersByTime(6000);
      expect(sent).toHaveLength(5);
      holding = false;
      pacer.resume();
      // The budget decayed meanwhile: both fit now, in order.
      expect(sent.slice(5)).toEqual([SHORT, 'MONITOR + bob']);
    });
  });

  describe('hooks that throw', () => {
    it('a throwing onDropped leaves the rest told', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      fill();
      const told: string[] = [];
      pacer.write('PRIVMSG #c :a', {
        onDropped: () => {
          throw new Error('SQLITE_BUSY');
        },
      });
      pacer.write('PRIVMSG #c :b', { onDropped: () => told.push('b') });
      pacer.drop();
      expect(told).toEqual(['b']);
      expect(warn).toHaveBeenCalledTimes(1);
      warn.mockRestore();
    });

    it('a thunk whose build throws is told it was dropped', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      fill();
      const told: string[] = [];
      pacer.write(
        () => {
          throw new Error('keyring');
        },
        { onDropped: () => told.push('thunk') },
      );
      vi.advanceTimersByTime(2000);
      expect(told).toEqual(['thunk']);
      expect(pacer.pending).toBe(0);
      warn.mockRestore();
    });

    it('a throwing onSent or send does not stop the queue', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      fill();
      pacer.write(SHORT, {
        onSent: () => {
          throw new Error('SQLITE_BUSY');
        },
      });
      pacer.write('PRIVMSG #c :after');
      vi.advanceTimersByTime(2000);
      expect(sent.at(-1)).toBe(SHORT);
      vi.advanceTimersByTime(2000);
      expect(sent.at(-1)).toBe('PRIVMSG #c :after');
      expect(warn).toHaveBeenCalledTimes(1);
      warn.mockRestore();
    });
  });

  describe('live on a thunk', () => {
    it('asks live() before building, and again for each line the thunk made', () => {
      fill();
      let wanted = true;
      let built = 0;
      pacer.write(
        () => {
          built++;
          return ['NOTICE p :one', 'NOTICE p :two'];
        },
        { live: () => wanted },
      );
      wanted = false;
      vi.advanceTimersByTime(2000);
      expect(built).toBe(0);
      expect(sent).toHaveLength(5);
      expect(pacer.pending).toBe(0);
      // Built at once (the budget has 2 s free), first line gone, then
      // withdrawn: the second never goes.
      wanted = true;
      pacer.write(
        () => {
          built++;
          return ['NOTICE p :three', 'NOTICE p :four'];
        },
        { live: () => wanted },
      );
      expect(built).toBe(1);
      expect(sent.at(-1)).toBe('NOTICE p :three');
      wanted = false;
      vi.advanceTimersByTime(2000);
      expect(sent.at(-1)).toBe('NOTICE p :three');
      expect(pacer.pending).toBe(0);
    });
  });

  describe('lanes', () => {
    it('sends high before normal before low while lines wait, in order within a lane', () => {
      fill();
      pacer.write('WHO #a', { priority: 'low' });
      pacer.write('PRIVMSG #c :1');
      pacer.write('JOIN #b', { priority: 'high' });
      pacer.write('PRIVMSG #c :2');
      pacer.write('WHO #b', { priority: 'low' });
      const went: string[] = [];
      for (let i = 0; i < 5; i++) {
        vi.advanceTimersByTime(2000);
        went.push(sent.at(-1)!);
      }
      expect(went).toEqual(['JOIN #b', 'PRIVMSG #c :1', 'PRIVMSG #c :2', 'WHO #a', 'WHO #b']);
      expect(pacer.pending).toBe(0);
    });

    it("what a thunk makes waits in the thunk's lane", () => {
      fill();
      pacer.write(() => ['WHO #a', 'WHO #b'], { priority: 'low' });
      vi.advanceTimersByTime(2000);
      // The thunk ran: its first line went, its second waits, still low.
      expect(sent.at(-1)).toBe('WHO #a');
      pacer.write('PRIVMSG #c :1');
      vi.advanceTimersByTime(2000);
      expect(sent.at(-1)).toBe('PRIVMSG #c :1');
      vi.advanceTimersByTime(2000);
      expect(sent.at(-1)).toBe('WHO #b');
    });

    it('a keyed item replaces its predecessor where it stands, in its lane', () => {
      fill();
      pacer.write('NOTICE p :one', { key: 'p', priority: 'low' });
      pacer.write('WHO #a', { priority: 'low' });
      pacer.write('JOIN #b', { priority: 'high' });
      pacer.write('NOTICE p :two', { key: 'p' });
      expect(pacer.pending).toBe(3);
      const went: string[] = [];
      for (let i = 0; i < 3; i++) {
        vi.advanceTimersByTime(2000);
        went.push(sent.at(-1)!);
      }
      expect(went).toEqual(['JOIN #b', 'NOTICE p :two', 'WHO #a']);
      expect(sent).not.toContain('NOTICE p :one');
    });

    it('a line in a higher lane does not wait out the wait scheduled for a slower head', () => {
      fill();
      pacer.write(`MONITOR + ${'n,'.repeat(200)}`, { priority: 'low' }); // 412 bytes: 6 s
      pacer.write('JOIN #b', { priority: 'high' });
      // The JOIN's own wait, 2 s, not the 6 s scheduled for the MONITOR.
      vi.advanceTimersByTime(2000);
      expect(sent.at(-1)).toBe('JOIN #b');
      vi.advanceTimersByTime(5999);
      expect(sent).toHaveLength(6);
      vi.advanceTimersByTime(1);
      expect(sent.at(-1)).toMatch(/^MONITOR \+ /);
    });

    it('the keyed cap drops the oldest keyed item, whichever lane it waits in', () => {
      fill();
      const dropped: string[] = [];
      pacer.write('NOTICE a :1', { key: 'a', priority: 'low', onDropped: () => dropped.push('a') });
      pacer.write('NOTICE b :2', { key: 'b', onDropped: () => dropped.push('b') });
      pacer.write('NOTICE c :3', {
        key: 'c',
        priority: 'high',
        onDropped: () => dropped.push('c'),
      });
      expect(dropped).toEqual(['a']);
      expect(pacer.pending).toBe(2);
      vi.advanceTimersByTime(2000);
      expect(sent.at(-1)).toBe('NOTICE c :3');
      vi.advanceTimersByTime(2000);
      expect(sent.at(-1)).toBe('NOTICE b :2');
    });

    it('cancel takes an item out of whichever lane it waits in', () => {
      fill();
      const low = pacer.write('WHO #a', { priority: 'low' });
      const high = pacer.write('JOIN #b', { priority: 'high' });
      expect(low.cancel()).toBe(true);
      expect(high.cancel()).toBe(true);
      expect(pacer.pending).toBe(0);
      vi.advanceTimersByTime(4000);
      expect(sent).toHaveLength(5);
    });
  });
});
