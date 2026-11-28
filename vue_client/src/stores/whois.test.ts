// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

// openViewer fires the WHOIS itself; nothing here needs a real socket. It
// defaults to a delivered send — the not-delivered case is its own test.
vi.mock('../composables/useSocket.js', () => ({
  socketSend: vi.fn<(payload: Record<string, unknown>) => boolean>(),
}));

import { socketSend } from '../composables/useSocket.js';
import { useWhoisStore } from './whois.js';

const send = vi.mocked(socketSend);

// refreshingKey is the in-flight marker for the viewer's own lookup. It used to
// mean "we already asked for this nick at some point in this viewer session",
// which read the same for a lookup that answered and one that never will — so a
// nick whose WHOIS came back not-found kept the slot for the rest of the
// session and could not be retried (#818).
describe('whois store — in-flight tracking', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    send.mockReset();
    send.mockReturnValue(true);
  });

  const NET = 1;

  it('kicks one WHOIS while the reply is still out', () => {
    const store = useWhoisStore();
    store.openViewer(NET, 'fartboy');
    store.openViewer(NET, 'fartboy');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('lets a reopen retry a lookup that came back not-found', () => {
    // The bug: a 401 answers the WHOIS with `error: 'not_found'`, which is an
    // answer — the slot has to free even though there is no identity in it.
    const store = useWhoisStore();
    store.openViewer(NET, 'fartboy');
    store.applyResult(NET, { nick: 'fartboy', error: 'not_found' });
    expect(store.refreshingKey).toBeNull();

    store.openViewer(NET, 'fartboy');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('frees the slot on a successful reply too', () => {
    const store = useWhoisStore();
    store.openViewer(NET, 'someone');
    store.applyResult(NET, { nick: 'someone', ident: 'u', hostname: 'h' });
    expect(store.refreshingKey).toBeNull();
  });

  it("doesn't free the slot for a different nick's reply", () => {
    // Results arrive for nicks nobody opened a viewer on — the modal isn't the
    // only thing that can provoke a WHOIS. One must not clear another's marker.
    const store = useWhoisStore();
    store.openViewer(NET, 'fartboy');
    store.applyResult(NET, { nick: 'someoneelse', ident: 'u' });
    expect(store.refreshingKey).not.toBeNull();

    store.openViewer(NET, 'fartboy');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("doesn't claim the slot for a WHOIS that never went out", () => {
    // socketSend returns false with no live socket. Claiming the slot anyway
    // wedges it exactly as a never-cleared one did — no reply is coming to
    // free it — so a reconnected user could never look the nick up again.
    const store = useWhoisStore();
    send.mockReturnValue(false);
    store.openViewer(NET, 'fartboy');
    expect(store.refreshingKey).toBeNull();

    send.mockReturnValue(true);
    store.openViewer(NET, 'fartboy');
    expect(send).toHaveBeenCalledTimes(2);
    expect(store.refreshingKey).not.toBeNull();
  });

  it('reports a lookup as in flight only for the nick it is out for', () => {
    const store = useWhoisStore();
    store.openViewer(NET, 'FartBoy');
    expect(store.isRefreshing(NET, 'fartboy')).toBe(true);
    expect(store.isRefreshing(NET, 'someoneelse')).toBe(false);
    expect(store.isRefreshing(2, 'fartboy')).toBe(false);

    store.applyResult(NET, { nick: 'fartboy', error: 'not_found' });
    expect(store.isRefreshing(NET, 'fartboy')).toBe(false);
  });

  it('matches the reply to the request case-insensitively', () => {
    // IRC nicks are case-insensitive and servers echo whatever case they hold,
    // so a reply cased differently from the request is the normal path, not an
    // edge case. key() folds both, and this pins that it stays that way.
    const store = useWhoisStore();
    store.openViewer(NET, 'FartBoy');
    store.applyResult(NET, { nick: 'fartboy', error: 'not_found' });
    expect(store.refreshingKey).toBeNull();
  });
});

// ⚠⚠ A `=bob` buffer is a DCC chat with bob, and the lookup goes out as a RAW
// line — which bypasses every `=` guard in ircManager by design (it is what
// /quote uses). So the DCC chat header, which passes its buffer target, put
// `WHOIS =bob` straight on the wire. Normalized in the store so no entry point
// can reintroduce it.
describe('whois store — DCC chat targets', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    send.mockReset();
    send.mockReturnValue(true);
  });

  it('looks up the peer, never the =nick buffer name', () => {
    const store = useWhoisStore();
    store.openViewer(1, '=bob');
    expect(send).toHaveBeenCalledWith({
      type: 'raw',
      networkId: 1,
      line: 'WHOIS bob',
      profile: true,
    });
    expect(store.viewer.nick).toBe('bob');
  });

  it('shares the cache and in-flight slot with a plain whois of the same peer', () => {
    const store = useWhoisStore();
    store.openViewer(1, '=bob');
    store.openViewer(1, 'bob'); // same person, same lookup still out
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('leaves an ordinary nick alone', () => {
    useWhoisStore().openViewer(1, 'alice');
    expect(send).toHaveBeenCalledWith({
      type: 'raw',
      networkId: 1,
      line: 'WHOIS alice',
      profile: true,
    });
  });
});
