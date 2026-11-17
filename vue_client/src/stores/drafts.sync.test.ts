// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// What was typed is never replaced by an older copy from the server. A flush is
// only done when the server says it has it: one sent with no socket, or into a
// socket that died, is sent again behind the snapshot that follows the
// reconnect, and that snapshot leaves the typed text alone.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

type Ack = { ok: boolean; error?: string; data?: unknown };
vi.mock('../composables/useSocket.js', () => ({
  socketSendWithAck: vi.fn<(payload: Record<string, unknown>) => Promise<Ack> | null>(),
}));

import { socketSendWithAck } from '../composables/useSocket.js';
import { useDraftStore } from './drafts.js';

const send = vi.mocked(socketSendWithAck);
const frames = () => send.mock.calls.map((c) => c[0]);
const serverHas = (body: string) => [{ networkId: 1, target: '#chan', body }];
// Let an answered flush's `.then` run.
const settle = () => Promise.resolve().then(() => Promise.resolve());

// A flush whose answer the test gives when it chooses.
function held(): (result: Ack) => Promise<void> {
  let resolve!: (result: Ack) => void;
  send.mockReturnValueOnce(new Promise<Ack>((r) => (resolve = r)));
  return async (result) => {
    resolve(result);
    await settle();
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.useFakeTimers();
  send.mockReset();
  send.mockImplementation(() => Promise.resolve({ ok: true }));
  useDraftStore().resetTimers();
});
afterEach(() => vi.useRealTimers());

describe('a draft the server may not have', () => {
  it('survives a flush with no socket, and is sent again behind the snapshot', () => {
    const drafts = useDraftStore();
    drafts.seed(serverHas('hello'));
    send.mockReturnValue(null); // disconnected
    drafts.setLocal(1, '#chan', 'hello there, how are');
    vi.advanceTimersByTime(600);
    expect(frames()).toHaveLength(1);

    // Reconnected: the snapshot has what the server last heard.
    send.mockImplementation(() => Promise.resolve({ ok: true }));
    drafts.seed(serverHas('hello'));
    expect(drafts.forBuffer(1, '#chan')).toBe('hello there, how are');
    expect(frames().at(-1)).toMatchObject({ type: 'draft-set', body: 'hello there, how are' });
  });

  it('survives a snapshot with no draft at all for the buffer', () => {
    const drafts = useDraftStore();
    send.mockReturnValue(null);
    drafts.setLocal(1, '#chan', 'a whole message');
    vi.advanceTimersByTime(600);
    drafts.seed([]);
    expect(drafts.forBuffer(1, '#chan')).toBe('a whole message');
  });

  it('survives a flush the socket closed under', async () => {
    const drafts = useDraftStore();
    const answer = held();
    drafts.setLocal(1, '#chan', 'typed into a dying socket');
    vi.advanceTimersByTime(600);
    await answer({ ok: false, error: 'disconnected' });
    drafts.seed(serverHas('typed'));
    expect(drafts.forBuffer(1, '#chan')).toBe('typed into a dying socket');
    expect(frames().at(-1)).toMatchObject({ body: 'typed into a dying socket' });
  });

  it('survives a snapshot that left the server before the flush arrived', async () => {
    const drafts = useDraftStore();
    const answer = held();
    drafts.setLocal(1, '#chan', 'newer');
    vi.advanceTimersByTime(600);
    drafts.seed(serverHas('older'));
    expect(drafts.forBuffer(1, '#chan')).toBe('newer');
    // Already on its way: not sent twice.
    expect(frames()).toHaveLength(1);
    await answer({ ok: true });
  });

  it('survives a flush nothing answered, without holding off another device', async () => {
    const drafts = useDraftStore();
    const answer = held();
    drafts.setLocal(1, '#chan', 'into the void');
    vi.advanceTimersByTime(600);
    await answer({ ok: false, error: 'timeout' });
    drafts.seed(serverHas(''));
    expect(drafts.forBuffer(1, '#chan')).toBe('into the void');
    expect(frames()).toHaveLength(2);
    await settle();

    drafts.applyRemoteUpdate(1, '#chan', 'from the phone');
    expect(drafts.forBuffer(1, '#chan')).toBe('from the phone');
  });
});

describe('a draft the server would not keep', () => {
  it('survives the snapshot, which cannot have it', async () => {
    const drafts = useDraftStore();
    send.mockImplementation(() => Promise.resolve({ ok: false, error: 'unknown-buffer' }));
    drafts.setLocal(1, '#chan', 'to a buffer the server has no row for');
    vi.advanceTimersByTime(600);
    await settle();
    drafts.seed([]);
    expect(drafts.forBuffer(1, '#chan')).toBe('to a buffer the server has no row for');
  });
});

describe('the unload beacon', () => {
  it('marks nothing saved: a page that was only hidden still holds its text', () => {
    const drafts = useDraftStore();
    const beacon = vi.fn<(url: string, data: Blob) => boolean>(() => true);
    vi.stubGlobal('navigator', { sendBeacon: beacon });
    try {
      send.mockReturnValue(null);
      drafts.setLocal(1, '#chan', 'typed, then the app was switched away');
      expect(drafts.flushAllForBeacon()).toBe(true);
      expect(beacon).toHaveBeenCalledTimes(1);
      drafts.seed(serverHas('typed'));
      expect(drafts.forBuffer(1, '#chan')).toBe('typed, then the app was switched away');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('a renamed buffer', () => {
  it('sends its unsaved draft again under the new name', async () => {
    const drafts = useDraftStore();
    const answer = held();
    drafts.setLocal(1, 'bob', 'hey bob');
    vi.advanceTimersByTime(600);
    drafts.rekeyBuffer(1, 'bob', 'bobby');
    await answer({ ok: true }); // about the old name: settles nothing
    vi.advanceTimersByTime(600);
    expect(frames().at(-1)).toMatchObject({ type: 'draft-set', target: 'bobby', body: 'hey bob' });
    await settle();
    drafts.applyRemoteUpdate(1, 'bobby', 'from the phone');
    expect(drafts.forBuffer(1, 'bobby')).toBe('from the phone');
  });
});

describe('a draft the server has', () => {
  it('takes the snapshot and another device’s update once the flush is answered', async () => {
    const drafts = useDraftStore();
    drafts.setLocal(1, '#chan', 'mine');
    vi.advanceTimersByTime(600);
    await settle();
    drafts.applyRemoteUpdate(1, '#chan', 'theirs');
    expect(drafts.forBuffer(1, '#chan')).toBe('theirs');
    drafts.seed(serverHas('from the snapshot'));
    expect(drafts.forBuffer(1, '#chan')).toBe('from the snapshot');
    expect(frames()).toHaveLength(1);
  });

  it('holds off another device until the flush is answered', async () => {
    const drafts = useDraftStore();
    const answer = held();
    drafts.setLocal(1, '#chan', 'mine');
    vi.advanceTimersByTime(600);
    drafts.applyRemoteUpdate(1, '#chan', 'theirs, and older');
    expect(drafts.forBuffer(1, '#chan')).toBe('mine');
    await answer({ ok: true });
    drafts.applyRemoteUpdate(1, '#chan', 'theirs, and newer');
    expect(drafts.forBuffer(1, '#chan')).toBe('theirs, and newer');
  });

  // The server's own answer to a flush whose reply it didn't keep comes back
  // to the sender ahead of the ACK. It has the sender's text.
  it('takes the server’s answer to the flush in flight, but not once more is typed', async () => {
    const drafts = useDraftStore();
    const answer = held();
    drafts.setLocal(1, '#chan', 'alice: noon');
    drafts.setReplyForKey('1::#chan', { messageId: 42, nick: 'alice', type: 'message', text: 'q' });
    vi.advanceTimersByTime(600);
    drafts.applyRemoteUpdate(1, '#chan', 'alice: noon', null);
    expect(drafts.replyForKey('1::#chan')).toBeNull();
    await answer({ ok: true });

    const second = held();
    drafts.setLocal(1, '#chan', 'alice: noon?');
    vi.advanceTimersByTime(600);
    drafts.setLocal(1, '#chan', 'alice: noon? or one');
    drafts.applyRemoteUpdate(1, '#chan', 'alice: noon?', null);
    expect(drafts.forBuffer(1, '#chan')).toBe('alice: noon? or one');
    await second({ ok: true });
  });

  it('an answer about older text does not settle what was typed since', async () => {
    const drafts = useDraftStore();
    const answer = held();
    drafts.setLocal(1, '#chan', 'first');
    vi.advanceTimersByTime(600);
    drafts.setLocal(1, '#chan', 'first and more');
    await answer({ ok: true });
    drafts.seed(serverHas('first'));
    expect(drafts.forBuffer(1, '#chan')).toBe('first and more');
  });

  it('a cleared draft that was never delivered is cleared again, not brought back', () => {
    const drafts = useDraftStore();
    drafts.seed(serverHas('sent already'));
    send.mockReturnValue(null);
    drafts.setLocal(1, '#chan', '');
    vi.advanceTimersByTime(600);
    send.mockImplementation(() => Promise.resolve({ ok: true }));
    drafts.seed(serverHas('sent already'));
    expect(drafts.forBuffer(1, '#chan')).toBe('');
    expect(frames().at(-1)).toMatchObject({ type: 'draft-clear' });
  });
});

// A flush says which revision of the draft it was typed against and how long
// ago, and the server refuses one that is older than what it holds.
describe('a draft another device changed meanwhile', () => {
  const serverHasAt = (body: string, rev: number) => [{ networkId: 1, target: '#chan', body, rev }];

  it('sends the revision it had and the age of the text', () => {
    const drafts = useDraftStore();
    drafts.seed(serverHasAt('hello', 7));
    drafts.setLocal(1, '#chan', 'hello there');
    vi.advanceTimersByTime(600);
    expect(frames().at(-1)).toMatchObject({ type: 'draft-set', base: 7, age: 500 });
  });

  it('moves on to the revision its own flush was given', async () => {
    const drafts = useDraftStore();
    drafts.seed(serverHasAt('hello', 7));
    send.mockImplementation(() => Promise.resolve({ ok: true, data: { rev: 8 } }));
    drafts.setLocal(1, '#chan', 'one');
    vi.advanceTimersByTime(600);
    await settle();
    drafts.setLocal(1, '#chan', 'two');
    vi.advanceTimersByTime(600);
    expect(frames().at(-1)).toMatchObject({ body: 'two', base: 8 });
  });

  it('sends a draft held through a reconnect against the revision it was typed on', () => {
    const drafts = useDraftStore();
    drafts.seed(serverHasAt('hello', 7));
    send.mockReturnValue(null);
    drafts.setLocal(1, '#chan', 'typed offline');
    vi.advanceTimersByTime(60_000);
    send.mockImplementation(() => Promise.resolve({ ok: true }));
    // The other device wrote meanwhile: the snapshot is at 9.
    drafts.seed(serverHasAt('written elsewhere', 9));
    expect(frames().at(-1)).toMatchObject({ body: 'typed offline', base: 7, age: 60_000 });
  });

  it('gives way when the server says its draft is the later one', async () => {
    const drafts = useDraftStore();
    drafts.seed(serverHasAt('hello', 7));
    send.mockReturnValue(null);
    drafts.setLocal(1, '#chan', 'typed offline, long ago');
    vi.advanceTimersByTime(600);
    send.mockImplementation(() => Promise.resolve({ ok: false, error: 'stale' }));
    drafts.seed(serverHasAt('written elsewhere', 9));
    expect(drafts.forBuffer(1, '#chan')).toBe('typed offline, long ago');
    await settle();
    // The server follows its refusal with the draft that stands.
    drafts.applyRemoteUpdate(1, '#chan', 'written elsewhere', null, 9);
    expect(drafts.forBuffer(1, '#chan')).toBe('written elsewhere');
    // And nothing is held over the next snapshot.
    drafts.seed(serverHasAt('written elsewhere', 9));
    expect(drafts.forBuffer(1, '#chan')).toBe('written elsewhere');
  });

  it('gives way to a draft that was sent from the other device', async () => {
    const drafts = useDraftStore();
    send.mockReturnValue(null);
    drafts.setLocal(1, '#chan', 'already sent from the phone');
    vi.advanceTimersByTime(600);
    send.mockImplementation(() => Promise.resolve({ ok: false, error: 'stale' }));
    drafts.seed([]);
    await settle();
    drafts.applyRemoteUpdate(1, '#chan', '', null, 12);
    expect(drafts.forBuffer(1, '#chan')).toBe('');
    expect(drafts.hasDraft(1, '#chan')).toBe(false);
  });

  it('weighs text held off another device’s draft against it, not past it', () => {
    const drafts = useDraftStore();
    drafts.seed(serverHasAt('hello', 7));
    drafts.setLocal(1, '#chan', 'mine');
    // Theirs arrives while this is unsaved: not taken, so not the base either.
    drafts.applyRemoteUpdate(1, '#chan', 'theirs', null, 9);
    vi.advanceTimersByTime(600);
    expect(frames().at(-1)).toMatchObject({ body: 'mine', base: 7 });
  });

  it('keeps the typing time of a draft that moved with a rename', () => {
    const drafts = useDraftStore();
    send.mockReturnValue(null);
    drafts.setLocal(1, 'bob', 'hey bob');
    vi.advanceTimersByTime(60_000);
    send.mockImplementation(() => Promise.resolve({ ok: true }));
    drafts.rekeyBuffer(1, 'bob', 'bobby');
    vi.advanceTimersByTime(600);
    const sent = frames().at(-1) as { target: string; age: number };
    expect(sent.target).toBe('bobby');
    expect(sent.age).toBeGreaterThanOrEqual(60_000);
  });

  it('waits for one flush’s answer before sending the next, with its revision', async () => {
    const drafts = useDraftStore();
    drafts.seed(serverHasAt('hello', 7));
    const answer = held();
    drafts.setLocal(1, '#chan', 'first');
    vi.advanceTimersByTime(600);
    drafts.setLocal(1, '#chan', 'first and more');
    vi.advanceTimersByTime(600);
    expect(frames()).toHaveLength(1);
    await answer({ ok: true, data: { rev: 8 } } as Ack);
    expect(frames()).toHaveLength(2);
    expect(frames().at(-1)).toMatchObject({ body: 'first and more', base: 8 });
  });
});
