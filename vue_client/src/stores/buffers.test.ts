// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

// buffers.ts reaches into the networks/toasts stores and the socket. The actions
// under test only consult useNetworksStore().activeKey and setActive(), so a
// minimal mutable mock covers it; toasts/socket are stubbed so importing the
// store doesn't stand up the rest of the graph.
const h = vi.hoisted(() => ({ activeKey: null as string | null }));

vi.mock('./networks.js', () => ({
  useNetworksStore: () => ({
    get activeKey() {
      return h.activeKey;
    },
    set activeKey(v: string | null) {
      h.activeKey = v;
    },
    // Mirrors the real store: activeKey = `${networkId}::${target}`.
    setActive(networkId: number | string, target: string) {
      h.activeKey = `${networkId}::${target}`;
    },
  }),
}));
vi.mock('./toasts.js', () => ({ useToastsStore: () => ({ push: vi.fn<() => void>() }) }));
vi.mock('../composables/useSocket.js', () => ({
  socketSend: vi.fn<(payload: unknown) => boolean>(),
}));

import { useBuffersStore, bufferNeedsHydration } from './buffers.js';
import { socketSend } from '../composables/useSocket.js';

// The store always seeds the app-scoped system buffer (#355). These tests assert
// on network-buffer counts (fork/removal semantics), so filter it out.
const netBuffers = (store: ReturnType<typeof useBuffersStore>) =>
  store.list.filter((b) => b.networkId != null);

beforeEach(() => {
  setActivePinia(createPinia());
  h.activeKey = null;
  vi.mocked(socketSend).mockClear();
});

describe('applyReadState', () => {
  // Regression for #319: mark-all-read fans out a read-state for every target
  // with history, including closed buffers (absent from the store). Applying
  // one must NOT materialize the buffer, or the closed buffer pops back into
  // the sidebar.
  it('does not create a buffer that is not open', () => {
    const store = useBuffersStore();
    expect(store.isOpen(1, '#closed')).toBe(false);

    store.applyReadState(1, '#closed', { lastReadId: 10, unread: 5, highlights: 2 });

    expect(store.isOpen(1, '#closed')).toBe(false);
    expect(netBuffers(store)).toHaveLength(0);
  });

  it('updates the badge on an open buffer', () => {
    const store = useBuffersStore();
    // replaceBacklog ensures the buffer exists (the snapshot path), so this is
    // an "open" buffer.
    store.replaceBacklog(1, '#open', [], undefined, undefined, undefined);
    expect(store.isOpen(1, '#open')).toBe(true);

    store.applyReadState(1, '#open', { lastReadId: 42, unread: 3, highlights: 1 });

    const buf = store.byKey('1::#open')!;
    expect(buf.unread).toBe(3);
    expect(buf.highlighted).toBe(1);
    expect(buf.lastReadId).toBe(42);
  });

  it('suppresses the unread badge for the active buffer', () => {
    const store = useBuffersStore();
    store.replaceBacklog(1, '#here', [], undefined, undefined, undefined);
    h.activeKey = '1::#here';

    store.applyReadState(1, '#here', { lastReadId: 42, unread: 9, highlights: 4 });

    const buf = store.byKey('1::#here')!;
    expect(buf.unread).toBe(0);
    expect(buf.highlighted).toBe(0);
  });

  // Servers hand us inconsistently-cased channel/nick names (#289). A read-state
  // broadcast whose target case differs from the buffer's stored key must still
  // resolve to the open buffer (findByTarget), not silently drop the badge or
  // fork a phantom lowercase entry.
  it('updates a buffer opened under a different target case', () => {
    const store = useBuffersStore();
    store.replaceBacklog(1, '#Chan', [], undefined, undefined, undefined);
    expect(store.isOpen(1, '#Chan')).toBe(true);

    store.applyReadState(1, '#chan', { lastReadId: 7, unread: 4, highlights: 1 });

    const buf = store.byKey('1::#Chan')!;
    expect(buf.unread).toBe(4);
    expect(buf.highlighted).toBe(1);
    expect(buf.lastReadId).toBe(7);
    expect(store.byKey('1::#chan')).toBeNull(); // no phantom lowercase entry
    expect(netBuffers(store)).toHaveLength(1);
  });

  // While a buffer is active its unread divider is pinned (dividerAfterId set on
  // activate); a late read-state carrying a lower lastReadId must not slide the
  // divider backward out from under the reader (the Math.max branch).
  it('does not move lastReadId backwards while the divider is pinned', () => {
    const store = useBuffersStore();
    store.replaceBacklog(1, '#pinned', [], undefined, undefined, undefined);
    const buf = store.byKey('1::#pinned')!;
    buf.dividerAfterId = 100;
    buf.lastReadId = 50;

    store.applyReadState(1, '#pinned', { lastReadId: 30, unread: 0, highlights: 0 });
    expect(buf.lastReadId).toBe(50);

    store.applyReadState(1, '#pinned', { lastReadId: 70, unread: 0, highlights: 0 });
    expect(buf.lastReadId).toBe(70);
  });
});

// Regression for #327: IRC targets are case-insensitive but buffer identity used
// to key by exact case, so a live DM (or a member-list/`/query` activation)
// arriving under a different nick-case than the open buffer forked a duplicate.
// ensureBuffer/activate/isOpen/drop now fold case via resolveExistingKey, so
// every write, the active-buffer pointer, the open/closed guard, and the close
// all resolve to the single canonical (first-seen) buffer. "No fork" is asserted
// with the exact-key byKey() (which stays a key primitive), since isOpen() now
// correctly reports the canonical buffer as open under any casing.
describe('case-insensitive buffer identity (#327)', () => {
  const dm = (target: string, id: number, nick = target) => ({
    networkId: 1,
    target,
    id,
    type: 'message',
    nick,
    body: 'x',
  });

  it('appends a live DM under a divergent nick-case to the existing buffer', () => {
    const store = useBuffersStore();
    store.pushMessage(dm('Bob', 1));
    expect(store.isOpen(1, 'Bob')).toBe(true);

    // Same peer, server-relayed under a different casing — must land in the open
    // buffer rather than fork a second `bob` entry.
    const fresh = store.pushMessage(dm('bob', 2));
    expect(fresh).toBe(true);

    expect(netBuffers(store)).toHaveLength(1);
    expect(store.byKey('1::Bob')!.messages).toHaveLength(2);
    expect(store.byKey('1::bob')).toBeNull(); // no lowercase fork
  });

  it('records a speaker under a divergent case without forking a buffer', () => {
    const store = useBuffersStore();
    store.pushMessage(dm('Bob', 1));

    // recordSpeaker is the sibling side effect fired right after pushMessage in
    // the socket handler; it funnels through ensureBuffer too, so it must not
    // fork its own lowercase shell.
    store.recordSpeaker(1, 'bob', 'bob', 1000);

    expect(netBuffers(store)).toHaveLength(1);
    expect(store.byKey('1::bob')).toBeNull(); // no lowercase fork
    expect(store.byKey('1::Bob')!.speakers['bob']).toBeTruthy();
  });

  it('keeps live read-sync on the active buffer when the inbound DM case diverges', () => {
    const store = useBuffersStore();
    store.pushMessage(dm('Bob', 1));
    h.activeKey = '1::Bob';

    store.pushMessage(dm('bob', 2));

    // The read pointer advances and a mark-read goes out under the buffer's
    // canonical target, even though the event arrived as `bob`.
    expect(store.byKey('1::Bob')!.lastReadId).toBe(2);
    expect(socketSend).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'mark-read', networkId: 1, target: 'Bob', messageId: 2 }),
    );
  });

  it('activates the existing buffer under a divergent case and keeps activeKey canonical', () => {
    const store = useBuffersStore();
    store.replaceBacklog(1, 'Bob', [dm('Bob', 5)], undefined, undefined, undefined);
    expect(store.isOpen(1, 'Bob')).toBe(true);

    store.activate(1, 'bob');

    // activeKey must point at the key the buffer is actually stored under, or
    // useActiveBuffer's byKey(activeKey) returns null and blanks the chat view.
    expect(h.activeKey).toBe('1::Bob');
    expect(store.byKey(h.activeKey!)).toBeTruthy();
    expect(netBuffers(store)).toHaveLength(1);
    expect(store.byKey('1::bob')).toBeNull(); // no lowercase fork
  });

  it('isOpen resolves a buffer open under a divergent case (toast/jump focus guard)', () => {
    const store = useBuffersStore();
    store.pushMessage(dm('Bob', 1));

    // ToastContainer/useJumpToMessage gate activate() on isOpen() with the raw
    // server-cased target (highlight toast → event.target, friend-online →
    // event.nick). Folding keeps a live buffer from being reported "closed" and
    // refusing to focus its own notification — the regression the read-path
    // fold otherwise introduces by merging the fork away.
    expect(store.isOpen(1, 'bob')).toBe(true);
    expect(store.isOpen(1, 'BOB')).toBe(true);
    expect(store.byKey('1::bob')).toBeNull(); // still one canonical buffer
  });

  it('drop removes the buffer when the close target case diverges', () => {
    const store = useBuffersStore();
    store.pushMessage(dm('Bob', 1));
    expect(netBuffers(store)).toHaveLength(1);

    // The server doesn't canonicalize DM casing, so a buffer-closed broadcast
    // can carry a different case than the stored buffer; an exact-key delete
    // would leave a sidebar ghost.
    store.drop(1, 'bob');

    expect(netBuffers(store)).toHaveLength(0);
    expect(store.isOpen(1, 'Bob')).toBe(false);
  });

  it('setJoined resolves a divergently-cased channel target', () => {
    const store = useBuffersStore();
    store.replaceBacklog(1, '#Chan', [], undefined, undefined, true);
    const buf = store.byKey('1::#Chan')!;
    expect(buf.joined).toBe(true);

    store.setJoined(1, '#chan', false);

    expect(buf.joined).toBe(false);
    expect(netBuffers(store)).toHaveLength(1);
  });
});

// Feeds the PWA app-icon badge (#451). The sum must track each buffer's
// server-owned `highlighted` count and inherit applyReadState's active-buffer
// suppression, so the focused conversation never inflates the badge.
describe('totalHighlights', () => {
  it('is zero with only the seeded system buffer', () => {
    const store = useBuffersStore();
    expect(store.totalHighlights).toBe(0);
  });

  it('sums highlighted across open buffers', () => {
    const store = useBuffersStore();
    store.replaceBacklog(1, '#a', [], undefined, undefined, undefined);
    store.replaceBacklog(1, '#b', [], undefined, undefined, undefined);
    store.applyReadState(1, '#a', { lastReadId: 0, unread: 5, highlights: 2 });
    store.applyReadState(1, '#b', { lastReadId: 0, unread: 9, highlights: 3 });

    expect(store.totalHighlights).toBe(5);
  });

  it('excludes the active buffer, whose highlighted is forced to 0', () => {
    const store = useBuffersStore();
    store.replaceBacklog(1, '#a', [], undefined, undefined, undefined);
    store.replaceBacklog(1, '#b', [], undefined, undefined, undefined);
    // User is sitting in #a, so its read-state echo is suppressed to 0.
    h.activeKey = '1::#a';
    store.applyReadState(1, '#a', { lastReadId: 0, unread: 5, highlights: 2 });
    store.applyReadState(1, '#b', { lastReadId: 0, unread: 9, highlights: 3 });

    expect(store.byKey('1::#a')!.highlighted).toBe(0);
    expect(store.totalHighlights).toBe(3);
  });
});

// Offline buffers now arrive as SHELLS (events:[], hasMoreOlder:true) that the
// client hydrates on open. The empty-seed branch of replaceBacklog must honor
// the server's explicit hasMoreOlder instead of the `length >= 50` heuristic,
// or a zero-message shell would report hasMoreOlder:false and never lazy-load.
describe('replaceBacklog empty-seed honors server hasMoreOlder', () => {
  const ev = (id: number) => ({
    networkId: 1,
    target: '#full',
    id,
    type: 'message',
    nick: 'bob',
    body: 'x',
  });

  it('keeps a zero-message shell fetchable when the server sets hasMoreOlder', () => {
    const store = useBuffersStore();
    store.replaceBacklog(1, '#shell', [], undefined, undefined, false, { hasMoreOlder: true });
    const buf = store.byKey('1::#shell')!;
    expect(buf.messages).toHaveLength(0);
    // Without honoring the flag this would be false (0 >= 50), stranding the shell.
    expect(buf.hasMoreOlder).toBe(true);
  });

  it('falls back to the length heuristic when the server omits the flag', () => {
    const store = useBuffersStore();
    store.replaceBacklog(1, '#empty', [], undefined, undefined, undefined);
    expect(store.byKey('1::#empty')!.hasMoreOlder).toBe(false);
  });

  it('honors an explicit hasMoreOlder:false even when the slice is long', () => {
    const store = useBuffersStore();
    const slice = Array.from({ length: 60 }, (_, i) => ev(i + 1));
    // Server says there is nothing older; the old `length >= 50` heuristic would
    // wrongly report true and offer a page-up that returns nothing.
    store.replaceBacklog(1, '#full', slice, undefined, undefined, true, { hasMoreOlder: false });
    const buf = store.byKey('1::#full')!;
    expect(buf.messages.length).toBeGreaterThan(0);
    expect(buf.hasMoreOlder).toBe(false);
  });
});

// A fresh-connect shell (empty backlog frame + hasMoreOlder) can receive a live
// line before the user opens it. `unseeded` (not messages.length) must decide
// hydration so opening still fetches the real backlog and doesn't mark-read the
// unshown gap.
describe('shell unseeded lifecycle', () => {
  const shellFrame = (store: ReturnType<typeof useBuffersStore>, target: string) =>
    store.replaceBacklog(
      1,
      target,
      [],
      undefined,
      { lastReadId: 1000, unread: 5, highlights: 0 },
      true,
      { hasMoreOlder: true },
    );
  const live = (target: string, id: number) => ({
    networkId: 1,
    target,
    id,
    type: 'message',
    nick: 'bob',
    body: 'x',
  });

  it('marks an empty shell frame unseeded but a real-content frame seeded', () => {
    const store = useBuffersStore();
    shellFrame(store, '#a');
    expect(store.byKey('1::#a')!.unseeded).toBe(true);
    store.replaceBacklog(1, '#b', [live('#b', 5)], undefined, undefined, true, {
      hasMoreOlder: true,
    });
    expect(store.byKey('1::#b')!.unseeded).toBe(false);
  });

  it('stays unseeded when a live line arrives on the shell before open', () => {
    const store = useBuffersStore();
    shellFrame(store, '#a');
    store.pushMessage(live('#a', 5002));
    const buf = store.byKey('1::#a')!;
    expect(buf.messages.length).toBe(1);
    expect(buf.unseeded).toBe(true); // a stray live line does not hydrate it
  });

  it('on open, refetches the real backlog and does NOT mark-read the stray line', () => {
    const store = useBuffersStore();
    shellFrame(store, '#a');
    store.pushMessage(live('#a', 5002));
    vi.mocked(socketSend).mockClear();

    store.activate(1, '#a');

    const sends = vi.mocked(socketSend).mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(sends).toContainEqual(
      expect.objectContaining({ type: 'history', mode: 'latest', networkId: 1, target: '#a' }),
    );
    // The bug: without the unseeded guard, activate() would mark-read up to 5002,
    // clearing unread for the whole unshown gap (1001..5001).
    expect(sends.some((s) => s.type === 'mark-read')).toBe(false);
  });

  it('clears unseeded once applyLatestReplace hydrates it', () => {
    const store = useBuffersStore();
    shellFrame(store, '#a');
    store.activate(1, '#a');
    const token = store.byKey('1::#a')!.pendingHistoryToken;
    store.applyLatestReplace(1, '#a', {
      token,
      events: [live('#a', 4998), live('#a', 4999), live('#a', 5000)],
      hasMoreOlder: true,
    });
    expect(store.byKey('1::#a')!.unseeded).toBe(false);
  });

  it('seeds speakers from the history reply so autocomplete works on open, not just after live messages', () => {
    const store = useBuffersStore();
    shellFrame(store, '#a');
    store.activate(1, '#a');
    const token = store.byKey('1::#a')!.pendingHistoryToken;
    // The connect snapshot no longer ships speakers, so opening the buffer (this
    // reply) is where they must load — otherwise nick autocomplete is empty until
    // someone talks. applyLatestReplace previously dropped payload.speakers.
    store.applyLatestReplace(1, '#a', {
      token,
      events: [live('#a', 5000)],
      hasMoreOlder: true,
      speakers: [
        { nick: 'Alice', lastTime: 1000 },
        { nick: 'Bob', lastTime: 2000 },
      ],
    });
    expect(Object.keys(store.byKey('1::#a')!.speakers).sort()).toEqual(['alice', 'bob']);
  });
});

describe('joinOrActivate channel key', () => {
  // /join #chan <key> must forward the key so keyed (+k) channels are joinable.
  it('includes the key in the JOIN payload for a brand-new channel', () => {
    const store = useBuffersStore();
    store.joinOrActivate(1, '#secret', 'sekret');
    expect(socketSend).toHaveBeenCalledWith({
      type: 'join',
      networkId: 1,
      channel: '#secret',
      key: 'sekret',
    });
  });

  it('re-sends JOIN with the key when the buffer exists but we are not in it', () => {
    const store = useBuffersStore();
    // Open the buffer but leave it un-joined (e.g. after a part/kick).
    store.replaceBacklog(1, '#secret', [], undefined, undefined, undefined);
    store.byKey('1::#secret')!.joined = false;
    vi.mocked(socketSend).mockClear();

    store.joinOrActivate(1, '#secret', 'sekret');

    expect(socketSend).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'join', channel: '#secret', key: 'sekret' }),
    );
  });

  it('omits the key when none is given (plain /join)', () => {
    const store = useBuffersStore();
    store.joinOrActivate(1, '#open');
    expect(socketSend).toHaveBeenCalledWith({
      type: 'join',
      networkId: 1,
      channel: '#open',
      key: undefined,
    });
  });
});

describe('member attribute patching (#591, #508)', () => {
  const member = (nick: string, extra: Record<string, unknown> = {}) => ({
    nick,
    modes: [],
    away: false,
    ...extra,
  });

  it('patches a member in place, leaving unmentioned fields alone', () => {
    const store = useBuffersStore();
    store.setMembers(1, '#chan', [member('bob', { user: 'ident', host: 'old.host' })]);

    store.updateMember(1, '#chan', 'bob', { host: 'user/bob' });

    const m = store.byKey('1::#chan')!.members[0];
    expect(m.host).toBe('user/bob');
    expect(m.user).toBe('ident'); // untouched
  });

  it('matches the nick case-insensitively', () => {
    const store = useBuffersStore();
    store.setMembers(1, '#chan', [member('Bob', { host: 'old.host' })]);

    // A CHGHOST/ACCOUNT echoes the nick as the server holds it, which needn't
    // match the case NAMES gave us.
    store.updateMember(1, '#chan', 'bob', { host: 'user/bob' });

    expect(store.byKey('1::#chan')!.members[0].host).toBe('user/bob');
    expect(store.byKey('1::#chan')!.members[0].nick).toBe('Bob'); // case preserved
  });

  it('never lets a patch overwrite the nick', () => {
    const store = useBuffersStore();
    store.setMembers(1, '#chan', [member('bob')]);

    store.updateMember(1, '#chan', 'bob', { nick: 'evil', host: 'user/bob' });

    expect(store.byKey('1::#chan')!.members[0].nick).toBe('bob');
  });

  it('does not materialize a buffer for an unopened target', () => {
    const store = useBuffersStore();
    const before = netBuffers(store).length;

    store.updateMember(1, '#never-opened', 'bob', { host: 'user/bob' });

    // A pure attribute patch has no business creating a buffer — doing so
    // would leave an empty one in the sidebar.
    expect(netBuffers(store)).toHaveLength(before);
    expect(store.isOpen(1, '#never-opened')).toBe(false);
  });

  it('finds an account from any shared channel on the network', () => {
    const store = useBuffersStore();
    store.setMembers(1, '#one', [member('bob')]); // joined before us — no data
    store.setMembers(1, '#two', [member('bob', { account: 'bobaccount' })]);

    expect(store.accountFor(1, 'bob')).toBe('bobaccount');
  });

  it('tolerates a string network id', () => {
    const store = useBuffersStore();
    store.setMembers(1, '#one', [member('bob', { account: 'bobaccount' })]);

    // Buffers store networkId as a number; `'1' !== 1` would silently match
    // nothing rather than fail loudly.
    expect(store.accountFor('1', 'bob')).toBe('bobaccount');
  });

  it('distinguishes logged-out from never-learned', () => {
    const store = useBuffersStore();
    store.setMembers(1, '#one', [member('bob', { account: null })]);
    store.setMembers(1, '#two', [member('carol')]);

    expect(store.accountFor(1, 'bob')).toBeNull(); // server said logged out
    expect(store.accountFor(1, 'carol')).toBeUndefined(); // we never learned
  });
});

describe('hydration lifecycle (blank-buffer fix)', () => {
  const shellFrame = (store: ReturnType<typeof useBuffersStore>, target: string) =>
    store.replaceBacklog(
      1,
      target,
      [],
      undefined,
      { lastReadId: 1000, unread: 5, highlights: 0 },
      true,
      { hasMoreOlder: true },
    );

  describe('bufferNeedsHydration', () => {
    it('is true for a fresh-connect shell and false once hydrated', () => {
      const store = useBuffersStore();
      shellFrame(store, '#a');
      const buf = store.byKey('1::#a')!;
      expect(bufferNeedsHydration(buf)).toBe(true);

      vi.mocked(socketSend).mockReturnValue(true);
      store.reattachToLive(1, '#a');
      // In flight: not "in need" — the pending fetch will resolve or be failed.
      expect(bufferNeedsHydration(buf)).toBe(false);
      store.applyLatestReplace(1, '#a', {
        token: buf.pendingHistoryToken,
        events: [{ networkId: 1, target: '#a', id: 5000, type: 'message', nick: 'bob', body: 'x' }],
        hasMoreOlder: true,
      });
      expect(bufferNeedsHydration(buf)).toBe(false);
    });

    it('is false for a genuinely-empty buffer (empty latest reply cleared hasMoreOlder)', () => {
      const store = useBuffersStore();
      store.ensure(1, 'newnick'); // brand-new DM, no history server-side
      const buf = store.byKey('1::newnick')!;
      expect(bufferNeedsHydration(buf)).toBe(true); // empty + default hasMoreOlder

      vi.mocked(socketSend).mockReturnValue(true);
      store.reattachToLive(1, 'newnick');
      store.applyLatestReplace(1, 'newnick', {
        token: buf.pendingHistoryToken,
        events: [],
        hasMoreOlder: false,
      });
      // No refetch loop: hydrated-and-empty is a terminal state.
      expect(bufferNeedsHydration(buf)).toBe(false);
    });

    it('treats an all-filtered latest reply as terminal (no refetch loop)', () => {
      const store = useBuffersStore();
      shellFrame(store, '#a');
      const buf = store.byKey('1::#a')!;
      vi.mocked(socketSend).mockReturnValue(true);
      store.reattachToLive(1, '#a');

      // Legacy away/back rows at the tail: the server ships them (it doesn't
      // filter by type) with hasMoreOlder=true, the client filters them ALL
      // out. Without the terminal clamp this left messages empty +
      // hasMoreOlder true — permanently "needy", spinning the reconciler on a
      // refetch every throttle window while the pane claimed settled-empty.
      store.applyLatestReplace(1, '#a', {
        token: buf.pendingHistoryToken,
        events: [
          { networkId: 1, target: '#a', id: 4001, type: 'away', nick: 'bob' },
          { networkId: 1, target: '#a', id: 4002, type: 'back', nick: 'bob' },
        ],
        hasMoreOlder: true,
      });

      expect(buf.messages.length).toBe(0);
      expect(buf.hasMoreOlder).toBe(false); // clamped: hydration is terminal
      expect(bufferNeedsHydration(buf)).toBe(false);
    });

    it('is true when the slice was wiped on switch-away-from-detached (pendingRefetch)', () => {
      const store = useBuffersStore();
      shellFrame(store, '#a');
      const buf = store.byKey('1::#a')!;
      buf.detached = true;
      store.clearDetached(1, '#a', { wipeMessages: true });
      expect(buf.pendingRefetch).toBe(true);
      expect(bufferNeedsHydration(buf)).toBe(true);
    });

    it('excludes the system buffer and detached buffers', () => {
      const store = useBuffersStore();
      expect(bufferNeedsHydration(store.byKey(':system:')!)).toBe(false);
      shellFrame(store, '#a');
      const buf = store.byKey('1::#a')!;
      buf.detached = true;
      expect(bufferNeedsHydration(buf)).toBe(false);
    });
  });

  describe('ensureHydrated', () => {
    it('fires a latest fetch for an unhydrated shell', () => {
      const store = useBuffersStore();
      shellFrame(store, '#a');
      vi.mocked(socketSend).mockClear().mockReturnValue(true);

      store.ensureHydrated(1, '#a');

      expect(socketSend).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'history', mode: 'latest', networkId: 1, target: '#a' }),
      );
    });

    it('preserves pendingRefetch when the send fails, consumes it when the send succeeds', () => {
      const store = useBuffersStore();
      shellFrame(store, '#a');
      const buf = store.byKey('1::#a')!;
      buf.detached = true;
      store.clearDetached(1, '#a', { wipeMessages: true });
      expect(buf.pendingRefetch).toBe(true);

      // Socket closed: socketSend reports false. The intent flag must survive
      // so the reconciler's reconnect attempt still knows to refetch.
      vi.mocked(socketSend).mockReturnValue(false);
      store.ensureHydrated(1, '#a');
      expect(buf.pendingRefetch).toBe(true);
      expect(buf.loadingHistory).toBe(false); // rolled back, not wedged

      vi.mocked(socketSend).mockReturnValue(true);
      store.ensureHydrated(1, '#a');
      expect(buf.pendingRefetch).toBe(false);
      expect(buf.loadingHistory).toBe(true); // fetch in flight
    });

    it('no-ops while a fetch is already in flight', () => {
      const store = useBuffersStore();
      shellFrame(store, '#a');
      vi.mocked(socketSend).mockReturnValue(true);
      store.ensureHydrated(1, '#a');
      vi.mocked(socketSend).mockClear();

      store.ensureHydrated(1, '#a');

      expect(socketSend).not.toHaveBeenCalled();
    });
  });

  describe('failInFlightHistory', () => {
    it('clears loadingHistory and pendingHistoryToken on every buffer', () => {
      const store = useBuffersStore();
      shellFrame(store, '#a');
      shellFrame(store, '#b');
      vi.mocked(socketSend).mockReturnValue(true);
      store.reattachToLive(1, '#a');
      store.reattachToLive(1, '#b');
      expect(store.byKey('1::#a')!.loadingHistory).toBe(true);
      expect(store.byKey('1::#b')!.loadingHistory).toBe(true);

      store.failInFlightHistory();

      for (const key of ['1::#a', '1::#b']) {
        expect(store.byKey(key)!.loadingHistory).toBe(false);
        expect(store.byKey(key)!.pendingHistoryToken).toBe(null);
      }
    });

    it('unwedges a buffer whose reply was lost, so the next hydration attempt can fetch', () => {
      const store = useBuffersStore();
      shellFrame(store, '#a');
      vi.mocked(socketSend).mockReturnValue(true);
      store.reattachToLive(1, '#a');
      const buf = store.byKey('1::#a')!;

      // Socket died mid-flight: the reply never arrives. Historically this
      // wedged the buffer forever (every fetch guard early-returns on
      // loadingHistory). The close handler now sweeps the flags…
      store.failInFlightHistory();
      expect(bufferNeedsHydration(buf)).toBe(true);

      // …so the reconciler's post-reconnect attempt goes through.
      vi.mocked(socketSend).mockClear().mockReturnValue(true);
      store.ensureHydrated(1, '#a');
      expect(socketSend).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'history', mode: 'latest', target: '#a' }),
      );
    });
  });
});
