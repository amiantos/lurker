// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { nextTick, watch } from 'vue';
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

import { useBuffersStore, bufferNeedsHydration, windowAroundAnchor } from './buffers.js';
import { useSettingsStore } from './settings.js';
import { socketSend } from '../composables/useSocket.js';
import { retainViewedBuffer, resetViewedBuffers } from '../composables/useViewedBuffer.js';

// The store always seeds the app-scoped system buffer (#355). These tests assert
// on network-buffer counts (fork/removal semantics), so filter it out.
const netBuffers = (store: ReturnType<typeof useBuffersStore>) =>
  store.list.filter((b) => b.networkId != null);

beforeEach(() => {
  setActivePinia(createPinia());
  h.activeKey = null;
  // Module state like h.activeKey above: the set of buffers with a message list
  // on screen, which live read-sync now consults.
  resetViewedBuffers();
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

// #724: deriveKind tested a bare `#`, so an `&`/`+`/`!` channel was kinded a DM — and that
// cascaded. The nicklist pane keys off kind, and activate() fires a `probe-presence` for DMs,
// which meant WHOIS-probing the channel NAME as if it were a nick.
describe('non-# channels are kinded as channels (#724)', () => {
  const line = (target: string, id: number) => ({
    networkId: 1,
    target,
    id,
    type: 'message',
    nick: 'bob',
    body: 'x',
  });

  it('kinds &, + and ! targets as channels', () => {
    const store = useBuffersStore();
    store.pushMessage(line('&local', 1));
    store.pushMessage(line('+nomodes', 2));
    store.pushMessage(line('!ABCDEsafe', 3));
    store.pushMessage(line('bob', 4));

    expect(store.byKey('1::&local')!.kind).toBe('channel');
    expect(store.byKey('1::+nomodes')!.kind).toBe('channel');
    expect(store.byKey('1::!ABCDEsafe')!.kind).toBe('channel');
    expect(store.byKey('1::bob')!.kind).toBe('dm');
  });

  it('does not WHOIS-probe a &channel as if its name were a nick', () => {
    const store = useBuffersStore();
    store.pushMessage(line('&local', 1));
    vi.mocked(socketSend).mockClear();

    store.activate(1, '&local');

    // The probe is DMs-only. Sending it for a channel asks the server to WHOIS `&local`.
    const probes = vi
      .mocked(socketSend)
      .mock.calls.filter(([p]) => (p as { type?: string })?.type === 'probe-presence');
    expect(probes).toEqual([]);
  });

  it('still probes a real DM', () => {
    // Positive control: without this, "no probe" could just mean activate() did nothing at all.
    const store = useBuffersStore();
    store.pushMessage(line('bob', 1));
    vi.mocked(socketSend).mockClear();

    store.activate(1, 'bob');

    const probes = vi
      .mocked(socketSend)
      .mock.calls.filter(([p]) => (p as { type?: string })?.type === 'probe-presence');
    expect(probes).toHaveLength(1);
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

// WS_PROTOCOL_FIXES #10. Two halves of one rule: ask the server to size a page
// in the unit we render it in, and don't let our own ring silently swallow the
// extra rows that unit brings with it.
describe('renderable-counted history paging', () => {
  /** Settings as they are once the bootstrap has landed. */
  const settingsLoaded = (consolidate: boolean) => {
    const settings = useSettingsStore();
    settings.loaded = true;
    settings.values['chat.consolidate_joins'] = consolidate;
  };

  it('asks for renderable-counted pages while consolidation is on', () => {
    const store = useBuffersStore();
    settingsLoaded(true);
    vi.mocked(socketSend).mockReturnValue(true);

    store.reattachToLive(1, '#a');

    expect(socketSend).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'history', mode: 'latest', countBy: 'renderable' }),
    );
  });

  it('falls back to event counting when the user turned consolidation off', () => {
    // With every event rendering as its own line, 'event' IS the unit we render
    // in — and asking for 'renderable' would drag the server's whole scan window
    // into a page the user then sees in full.
    const store = useBuffersStore();
    settingsLoaded(false);
    vi.mocked(socketSend).mockReturnValue(true);

    store.reattachToLive(1, '#a');

    expect(socketSend).toHaveBeenCalledWith(expect.objectContaining({ countBy: 'event' }));
  });

  it('holds off on renderable pages until the settings bootstrap lands', () => {
    // The registry default is `true`, so `effective` would answer 'renderable'
    // here — for a user who may well have turned consolidation off. Of the two
    // wrong guesses that's the damaging one (a scan window rendered line by
    // line); guessing 'event' just means the first page is sized the way every
    // page used to be, and the next scroll corrects it.
    const store = useBuffersStore();
    expect(useSettingsStore().loaded).toBe(false);
    vi.mocked(socketSend).mockReturnValue(true);

    store.reattachToLive(1, '#a');

    expect(socketSend).toHaveBeenCalledWith(expect.objectContaining({ countBy: 'event' }));
  });

  it('re-arms the upward pager when a latest slice overflows the ring', () => {
    // The server computes hasMoreOlder against the WHOLE slice it sent. A
    // renderable-counted page can exceed our 500-row ring (a netsplit's noise
    // rides along), and honoring a `false` after trimming would strand the pager
    // on history we evicted ourselves.
    const store = useBuffersStore();
    vi.mocked(socketSend).mockReturnValue(true);
    store.reattachToLive(1, '#a');
    const token = store.byKey('1::#a')!.pendingHistoryToken;

    const events = Array.from({ length: 600 }, (_, i) => ({
      networkId: 1,
      target: '#a',
      id: i + 1,
      type: 'message',
      nick: 'bob',
      body: 'x',
    }));
    store.applyLatestReplace(1, '#a', { token, events, hasMoreOlder: false });

    const buf = store.byKey('1::#a')!;
    expect(buf.messages).toHaveLength(500);
    expect(buf.messages[0].id).toBe(101); // oldest 100 evicted
    expect(buf.hasMoreOlder).toBe(true);
  });

  it('re-arms the upward pager when appendHistory evicts off the old edge', () => {
    const store = useBuffersStore();
    vi.mocked(socketSend).mockReturnValue(true);
    store.reattachToLive(1, '#a');
    const token = store.byKey('1::#a')!.pendingHistoryToken;
    const row = (id: number) => ({
      networkId: 1,
      target: '#a',
      id,
      type: 'message',
      nick: 'bob',
      body: 'x',
    });
    store.applyLatestReplace(1, '#a', {
      token,
      events: Array.from({ length: 500 }, (_, i) => row(i + 1)),
      hasMoreOlder: false,
    });
    const buf = store.byKey('1::#a')!;
    expect(buf.hasMoreOlder).toBe(false); // nothing evicted yet

    store.appendHistory(1, '#a', [row(501), row(502)], false, undefined);

    expect(buf.messages).toHaveLength(500);
    expect(buf.messages[0].id).toBe(3);
    expect(buf.hasMoreOlder).toBe(true);
  });
});

// The other half of "a page can now be bigger than the ring": what an
// INCREMENTAL merge does with one. Both of these are silent when wrong — the
// reader just ends up looking at the wrong content, or at a buffer with a hole
// in it — so they're pinned rather than reasoned about.
describe('oversized history pages vs the in-memory ring', () => {
  const row = (id: number) => ({
    networkId: 1,
    target: '#a',
    id,
    type: 'message',
    nick: 'bob',
    body: 'x',
  });

  /** Hydrate '#a' with `count` rows, ids 1..count. */
  const seed = (store: ReturnType<typeof useBuffersStore>, count: number) => {
    vi.mocked(socketSend).mockReturnValue(true);
    store.reattachToLive(1, '#a');
    store.applyLatestReplace(1, '#a', {
      token: store.byKey('1::#a')!.pendingHistoryToken,
      events: Array.from({ length: count }, (_, i) => row(i + 1)),
      hasMoreOlder: true,
    });
    return store.byKey('1::#a')!;
  };

  it('keeps the reader’s context when an append page dwarfs the ring', () => {
    // A renderable-counted `after` page can be thousands of rows. Merged
    // wholesale it would evict every row held, MessageList would read both ends
    // changing as a wholesale replace, and a detached reader's scroll position
    // would point at content that no longer exists.
    const store = useBuffersStore();
    const buf = seed(store, 500);

    store.appendHistory(
      1,
      '#a',
      Array.from({ length: 2000 }, (_, i) => row(501 + i)),
      false,
      undefined,
    );

    expect(buf.messages).toHaveLength(500);
    // The previous tail survived, which is what tells the scroll watcher this
    // was an append and not a re-snapshot.
    expect(buf.messages.some((m) => m.id === 500)).toBe(true);
    // Contiguous, and the page we didn't take is still fetchable.
    expect(buf.messages.at(-1)!.id).toBe(750);
    expect(buf.hasMoreNewer).toBe(true);
  });

  it('takes the adjacent end of an oversized prepend page and stays contiguous', () => {
    const store = useBuffersStore();
    // Hold ids 1000..1099 (seed() emits 1..100, so shift them up).
    vi.mocked(socketSend).mockReturnValue(true);
    store.reattachToLive(1, '#a');
    store.applyLatestReplace(1, '#a', {
      token: store.byKey('1::#a')!.pendingHistoryToken,
      events: Array.from({ length: 100 }, (_, i) => row(1000 + i)),
      hasMoreOlder: true,
    });
    const buf = store.byKey('1::#a')!;

    // 900 older rows, ids 100..999 — contiguous, ending right below what we hold.
    store.prependHistory(
      1,
      '#a',
      Array.from({ length: 900 }, (_, i) => row(100 + i)),
      false,
      undefined,
    );

    // We took the NEWEST 250 of the page, so the merged slice is one gapless run
    // ending where it did before. Taking the oldest 250 instead would have left
    // a 650-row hole in the middle with nothing to signal it.
    const ids = buf.messages.map((m) => m.id);
    expect(ids[0]).toBe(750);
    expect(ids.at(-1)).toBe(1099);
    expect(ids).toEqual(Array.from({ length: 350 }, (_, i) => 750 + i));
    expect(buf.oldestId).toBe(750);
    // We deliberately didn't take the whole page, so the pager stays armed even
    // though the server said there was nothing older.
    expect(buf.hasMoreOlder).toBe(true);
  });

  it('re-anchors the paging cursor when a live line evicts the rows it pointed at', () => {
    // prependHistory doesn't trim (the reader is walking backwards), so paging
    // up grows the buffer past the ring and the NEXT live line re-imposes it.
    // Leaving oldestId pointing at an evicted row makes the following upward
    // page non-contiguous — a silent hole with nothing to signal it.
    const store = useBuffersStore();
    const buf = seed(store, 500);
    store.prependHistory(
      1,
      '#a',
      Array.from({ length: 200 }, (_, i) => row(i - 199)),
      true,
      undefined,
    );
    expect(buf.messages).toHaveLength(700); // over the ring, by design
    const staleOldest = buf.oldestId;

    store.pushMessage(row(501));

    expect(buf.messages).toHaveLength(500);
    expect(buf.oldestId).not.toBe(staleOldest);
    expect(buf.oldestId).toBe(buf.messages[0].id); // the cursor tracks what survived
    expect(buf.hasMoreOlder).toBe(true);
  });
});

// `buffer-opened` means two different things depending on who asked, and the
// frame looks identical either way (lurker WS_PROTOCOL_FIXES #1). Getting this
// wrong is not subtle to the user — their active buffer changes under them
// because they opened something on another device — but it is completely silent
// in code, so it's pinned here.
describe('open-buffer focus correlation', () => {
  it('claims exactly one reply for a target this tab asked to open', () => {
    const store = useBuffersStore();
    vi.mocked(socketSend).mockReturnValue(true);

    store.openBuffer(1, '#chan');

    expect(socketSend).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'open-buffer', networkId: 1, target: '#chan' }),
    );
    // Case-insensitively, since the server answers with the row's canonical
    // casing rather than the casing that was clicked.
    expect(store.claimPendingOpen(1, '#CHAN')).toBe(true);
    // ...and only once: a second frame for the same target is somebody else's.
    expect(store.claimPendingOpen(1, '#chan')).toBe(false);
  });

  it('does not claim an open this tab never asked for', () => {
    const store = useBuffersStore();
    expect(store.claimPendingOpen(1, '#elsewhere')).toBe(false);
  });

  it('forgets a request whose send failed, so it cannot claim a later fan-out', () => {
    const store = useBuffersStore();
    vi.mocked(socketSend).mockReturnValue(false);

    expect(store.openBuffer(1, '#dropped')).toBe(false);

    expect(store.claimPendingOpen(1, '#dropped')).toBe(false);
  });

  it('forgets a request the server never answered', () => {
    // `open-buffer` can be refused outright — a paused account gets `{kind:'error'}` and no
    // `buffer-opened` — and without a backstop that request would sit armed for the life of
    // the session, then claim an unrelated open from another device. Same backstop as
    // pendingJoins.
    vi.useFakeTimers();
    try {
      const store = useBuffersStore();
      vi.mocked(socketSend).mockReturnValue(true);
      store.openBuffer(1, '#unanswered');

      vi.advanceTimersByTime(10_000);

      expect(store.claimPendingOpen(1, '#unanswered')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('forgets pending requests on logout, which never reaches the socket-close path', () => {
    // resetSession aborts the socket listeners, so 'close' — and therefore
    // failInFlightHistory — never fires. A latch surviving into the next account's session
    // would let a cross-device open steal that user's focus.
    const store = useBuffersStore();
    vi.mocked(socketSend).mockReturnValue(true);
    store.openBuffer(1, '#previous-account');

    store.resetTimers();

    expect(store.claimPendingOpen(1, '#previous-account')).toBe(false);
  });

  it('forgets pending requests when the socket drops', () => {
    // A reply that can no longer arrive must not leave us primed to treat some
    // unrelated open — days later, from another device — as our own.
    const store = useBuffersStore();
    vi.mocked(socketSend).mockReturnValue(true);
    store.openBuffer(1, '#stale');

    store.failInFlightHistory();

    expect(store.claimPendingOpen(1, '#stale')).toBe(false);
  });
});

describe('applyClearedState — unclearing resets to the latest page', () => {
  it('trims the in-memory slice and re-arms the upward pager', async () => {
    const { setActivePinia, createPinia } = await import('pinia');
    setActivePinia(createPinia());
    const { useBuffersStore } = await import('./buffers.js');
    const store = useBuffersStore();
    const buf = store.ensure(1, '#deep');
    // Simulate the pile a cleared-state session can accumulate.
    for (let i = 1; i <= 500; i++) {
      buf.messages.push({ id: i, networkId: 1, target: '#deep', type: 'message' });
    }
    buf.clearedBeforeId = 450;
    buf.hasMoreOlder = false;

    store.applyClearedState(1, '#deep', { clearedBeforeId: 0, clearedAt: null });

    // The buffer comes back as "latest chat", not an archaeology dig: one
    // standard page, with older history reachable through the normal pager.
    expect(buf.messages.length).toBe(200);
    expect(buf.messages[0].id).toBe(301);
    expect(buf.hasMoreOlder).toBe(true);
    expect(buf.clearedBeforeId).toBe(0);
  });

  it('a clear (not an unclear) never trims', async () => {
    const { setActivePinia, createPinia } = await import('pinia');
    setActivePinia(createPinia());
    const { useBuffersStore } = await import('./buffers.js');
    const store = useBuffersStore();
    const buf = store.ensure(1, '#keep');
    for (let i = 1; i <= 300; i++) {
      buf.messages.push({ id: i, networkId: 1, target: '#keep', type: 'message' });
    }
    store.applyClearedState(1, '#keep', { clearedBeforeId: 300, clearedAt: 'now' });
    expect(buf.messages.length).toBe(300);
    expect(buf.clearedBeforeId).toBe(300);
  });
});

describe('userhostFor — the DM header identity', () => {
  it('prefers live member data, falls back to the DM rows, strips the nick half', async () => {
    const { setActivePinia, createPinia } = await import('pinia');
    setActivePinia(createPinia());
    const { useBuffersStore } = await import('./buffers.js');
    const store = useBuffersStore();

    // Peer visible in a shared channel: member data wins.
    const chan = store.ensure(1, '#shared');
    chan.members = [{ nick: 'Bob', modes: [], away: false, user: 'rob', host: 'host.example' }];
    expect(store.userhostFor(1, 'bob')).toBe('rob@host.example');

    // No shared channel: the DM's own rows answer, mask stripped to ident@host.
    const dm = store.ensure(2, 'carol');
    dm.messages.push({
      id: 1,
      networkId: 2,
      target: 'carol',
      type: 'message',
      nick: 'Carol',
      userhost: 'Carol!cc@irc.example',
      self: false,
    });
    expect(store.userhostFor(2, 'carol')).toBe('cc@irc.example');

    // Own rows never answer for the peer.
    const dm2 = store.ensure(3, 'dave');
    dm2.messages.push({
      id: 2,
      networkId: 3,
      target: 'dave',
      type: 'message',
      nick: 'me',
      userhost: 'me!my@own.host',
      self: true,
    });
    expect(store.userhostFor(3, 'dave')).toBeNull();
  });
});

describe('byId — the reactive counterpart to the keyById index', () => {
  it('resolves a buffer by its server id', () => {
    const store = useBuffersStore();
    store.ensure(1, '#chan', 7);

    expect(store.byId(7)?.target).toBe('#chan');
    expect(store.byId(999)).toBeNull();
  });

  it('re-fires a watcher when a buffer arrives — the whole reason it exists', async () => {
    // The module-level keyById Map is invisible to Vue, so a watcher built on
    // bufferKeyForId never re-runs when an id is learned. That silently broke
    // the cold-start deep link (#744): the socket connects FIRST, buffers land
    // after, and the resolver had already taken its only look. This getter must
    // track reactive state instead — asserted here against the real store,
    // because a test double is free to be more reactive than production is.
    const store = useBuffersStore();
    const seen: boolean[] = [];
    const stop = watch(
      () => store.byId(7) != null,
      (found) => seen.push(found),
    );

    store.ensure(1, '#chan', 7);
    await nextTick();
    stop();

    expect(seen).toEqual([true]);
  });

  it('re-fires when an already-open buffer LEARNS its id', async () => {
    // The optimistic path: "Send DM" materializes the buffer, and the row id
    // only arrives with the server's answer.
    const store = useBuffersStore();
    store.ensure(1, 'newpal');
    const seen: boolean[] = [];
    const stop = watch(
      () => store.byId(9) != null,
      (found) => seen.push(found),
    );

    store.ensure(1, 'newpal', 9);
    await nextTick();
    stop();

    expect(seen).toEqual([true]);
  });
});

describe('windowAroundAnchor — trimming an around slice', () => {
  const ev = (id: number) => ({ id, networkId: 1, target: '#c', type: 'message' }) as any;
  const run = (n: number, anchor: unknown, max: number) =>
    windowAroundAnchor(
      Array.from({ length: n }, (_, i) => ev(i + 1)),
      anchor,
      max,
    );

  it('leaves a slice that already fits', () => {
    const r = run(10, 5, 500);
    expect(r.events).toHaveLength(10);
    expect(r.trimmedOlder).toBe(false);
    expect(r.trimmedNewer).toBe(false);
  });

  it('centres the window on the anchor', () => {
    // THE bug: `slice(-max)` kept the newest rows, so a 963-row around slice
    // trimmed to 500 left the anchor ~18 rows from the top with no context
    // above it — "loaded high up in the list, but not at the message".
    const r = run(963, 482, 500);
    const ids = r.events.map((e: any) => e.id);
    expect(ids).toContain(482);
    // Roughly centred: a comfortable block of context on each side.
    expect(ids.indexOf(482)).toBeGreaterThan(200);
    expect(ids.length - ids.indexOf(482)).toBeGreaterThan(200);
    expect(r.trimmedOlder).toBe(true);
    expect(r.trimmedNewer).toBe(true);
  });

  it('keeps the anchor when it sits near the start', () => {
    const r = run(963, 3, 500);
    expect(r.events.map((e: any) => e.id)).toContain(3);
    expect(r.events).toHaveLength(500);
    expect(r.trimmedOlder).toBe(false);
    expect(r.trimmedNewer).toBe(true);
  });

  it('keeps the anchor when it sits near the end', () => {
    const r = run(963, 960, 500);
    expect(r.events.map((e: any) => e.id)).toContain(960);
    expect(r.events).toHaveLength(500);
    expect(r.trimmedOlder).toBe(true);
    expect(r.trimmedNewer).toBe(false);
  });

  it('never drops the anchor, wherever it falls', () => {
    // The failure mode behind the "couldn't load that message" toast: when more
    // than max rows follow the anchor, tail-trimming discarded it outright.
    for (const anchor of [1, 250, 481, 700, 963]) {
      expect(run(963, anchor, 500).events.map((e: any) => e.id)).toContain(anchor);
    }
  });

  it('falls back to the newest rows when the anchor is absent', () => {
    const r = run(963, 99999, 500);
    expect(r.events).toHaveLength(500);
    expect(r.events[r.events.length - 1].id).toBe(963);
    expect(r.trimmedOlder).toBe(true);
  });
});

describe('applyAroundSlice — the anchor survives the ring', () => {
  it('keeps the anchor centred rather than trimming to the newest rows', () => {
    // Exercised through the store, not just the helper: the bug was in which
    // window applyAroundSlice asked for, so a helper-only test lets the old
    // `slice(-MAX)` back in unnoticed.
    vi.mocked(socketSend).mockReturnValue(true);
    const store = useBuffersStore();
    store.ensure(1, '#busy', 47);
    const token = store.loadAround(1, '#busy', 250528);
    expect(token).not.toBeNull();

    // A noisy channel: far more rows come back than the ring holds, spread
    // either side of the anchor.
    const events = Array.from({ length: 963 }, (_, i) => ({
      id: 250528 - 481 + i,
      networkId: 1,
      target: '#busy',
      type: 'message',
      nick: 'someone',
      text: 'x',
    }));

    store.applyAroundSlice(1, '#busy', { token, anchorId: 250528, events });

    const buf = store.findByTarget(1, '#busy')!;
    const ids = buf.messages.map((m) => m.id);
    expect(ids).toContain(250528);
    // And with real context above it — landing the anchor at the top of the
    // pane is the visible half of this bug.
    expect(ids.indexOf(250528)).toBeGreaterThan(100);
    expect(buf.hasMoreOlder).toBe(true);
    expect(buf.hasMoreNewer).toBe(true);
  });
});

// A split frame puts several buffers on screen at once, so "the user is sitting
// in this buffer" stopped meaning "this is THE active buffer". Live read-sync
// asks the viewed set — the same question toast suppression asks — so a pane
// the user is watching can't accrue unread while its toasts are suppressed.
describe('live read-sync follows what is on screen', () => {
  const line = (target: string, id: number) => ({
    networkId: 1,
    target,
    id,
    type: 'message',
    nick: 'bob',
    body: 'x',
  });

  it('marks read in a visible pane that does not hold focus', () => {
    const store = useBuffersStore();
    store.pushMessage(line('#side', 1));
    // Another pane has focus; this buffer is on screen in a second pane.
    h.activeKey = '1::#focused';
    retainViewedBuffer('1::#side');

    store.pushMessage(line('#side', 2));

    expect(store.byKey('1::#side')!.lastReadId).toBe(2);
    expect(socketSend).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'mark-read', target: '#side', messageId: 2 }),
    );
  });

  it('leaves a buffer that is on no screen alone', () => {
    const store = useBuffersStore();
    store.pushMessage(line('#off', 1));
    h.activeKey = '1::#focused';

    store.pushMessage(line('#off', 2));

    expect(store.byKey('1::#off')!.lastReadId).toBe(0);
    expect(socketSend).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'mark-read', target: '#off' }),
    );
  });

  // The states with no message list mounted at all — the Settings route, the
  // mobile buffer-list/members screens — have always marked read off activeKey,
  // and still do.
  it('still marks read for the active buffer with no message list mounted', () => {
    const store = useBuffersStore();
    store.pushMessage(line('#here', 1));
    h.activeKey = '1::#here';

    store.pushMessage(line('#here', 2));

    expect(store.byKey('1::#here')!.lastReadId).toBe(2);
  });
});
