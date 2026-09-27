// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { defineComponent, nextTick, reactive } from 'vue';
import { mount } from '@vue/test-utils';

// The composable's whole job is wiring, so everything it talks to is stubbed and
// the assertions are about which navigations happen — and, as much as anything,
// which DON'T: a feedback loop between the two directions would surface as an
// endless stream of pushes.
//
// The fakes must be exactly as reactive as the real thing and no more. An
// earlier version of this file backed the buffer-id lookup with a reactive
// object while production read a plain module-level Map; every test passed and
// the cold-start deep link never fired in the app. `byId` below is a store
// getter reading reactive state, which is what the real one is.
//
// `h.s` is assigned in beforeEach: vi.hoisted() runs before any import, so it
// can't build reactive state itself — but the mock factories only CREATE the
// exported bindings there, and every getter body runs later, from inside a test.
const h = vi.hoisted(() => ({
  s: null as any,
  push: vi.fn<(to: string) => void>(),
  replace: vi.fn<(to: string) => void>(),
  // Echoes the activation back into activeKey, exactly as the real
  // buffers.activate() does. Load-bearing, not convenience: without the echo
  // the inbound direction never feeds the outbound one, and the feedback loop
  // these tests exist to pin down is never actually run.
  activate: vi.fn<(networkId: number | null, target: string) => void>((networkId, target) => {
    h.s.networks.activeKey = networkId == null ? target : `${networkId}::${target}`;
  }),
  toast: vi.fn<(t: unknown) => void>(),
}));

// Navigation applies to the fake route, so the composable observes the same
// param flip a real router would produce.
function applyPath(to: string): void {
  const [path] = to.split('?');
  h.s.route.path = path;
  const members = /^\/buffer\/([^/]+)\/members$/.exec(path);
  const thread = /^\/buffer\/([^/]+)\/thread\/([^/]+)$/.exec(path);
  const m = /^\/buffer\/([^/]+)$/.exec(path);
  h.s.route.params = members
    ? { id: members[1] }
    : thread
      ? { id: thread[1], root: thread[2] }
      : m
        ? { id: m[1] }
        : {};
  h.s.route.name = members
    ? 'buffer-members'
    : thread
      ? 'buffer-thread'
      : m
        ? 'buffer'
        : path === '/system'
          ? 'system'
          : 'chat';
}

vi.mock('vue-router', () => ({
  useRoute: () => h.s.route,
  useRouter: () => ({
    // currentRoute is the same reactive route object useRoute() hands back, as
    // on the real router — pushBuffer reads it to skip a navigation to where we
    // already are.
    currentRoute: {
      get value() {
        return h.s.route;
      },
    },
    // push/replace both return a promise, like the real router — pushBuffer
    // chains off it to clear its in-flight guard, so a void-returning fake
    // would wedge after the first navigation.
    push: (to: string) => {
      h.push(to);
      applyPath(to);
      return Promise.resolve();
    },
    replace: (to: string) => {
      h.replace(to);
      applyPath(to);
      return Promise.resolve();
    },
  }),
}));
vi.mock('./useSocket.js', () => ({
  connected: {
    get value(): boolean {
      return h.s.connected;
    },
    set value(v: boolean) {
      h.s.connected = v;
    },
  },
}));
vi.mock('../stores/networks.js', () => ({ useNetworksStore: () => h.s.networks }));
vi.mock('../stores/toasts.js', () => ({ useToastsStore: () => ({ push: h.toast }) }));
vi.mock('../stores/buffers.js', () => ({
  useBuffersStore: () => ({
    byKey: (k: string) => h.s.buffers[k] ?? null,
    // Scans the reactive buffer collection, like the real getter — so a watcher
    // over it re-fires when a buffer arrives or learns its id.
    byId: (id: number) => Object.values(h.s.buffers).find((b: any) => b.id === id) ?? null,
    activate: h.activate,
  }),
  bufferKey: (networkId: number | null, target: string) =>
    networkId == null ? target : `${networkId}::${target}`,
}));

import { useBufferRoute, pushBuffer } from './useBufferRoute.js';

const Harness = defineComponent({
  setup() {
    useBufferRoute();
    return () => null;
  },
});

/** Open a buffer the way the rest of the app does: flip activeKey. */
async function activate(key: string): Promise<void> {
  h.s.networks.activeKey = key;
  await nextTick();
}

/** Register a buffer as known to the store, keyed the way the real store keys
 *  it. No id models a buffer created optimistically, before the server has
 *  answered with its row id. */
function known(key: string, id?: number): void {
  const sep = key.indexOf('::');
  const networkId = sep === -1 ? null : Number(key.slice(0, sep));
  const target = sep === -1 ? key : key.slice(sep + 2);
  h.s.buffers[key] = { networkId, target, ...(id == null ? {} : { id }) };
}

let wrapper: ReturnType<typeof mount> | null = null;
const start = () => (wrapper = mount(Harness));

beforeEach(() => {
  h.s = reactive({
    route: { path: '/', name: 'chat' as string, params: {} as Record<string, string> },
    connected: true,
    networks: {
      activeKey: null as string | null,
      // As on the real store: deactivate without closing anything.
      clearActive() {
        this.activeKey = null;
      },
    },
    buffers: {} as Record<string, { id?: number; networkId: number | null; target: string }>,
  });
  h.push.mockReset();
  h.replace.mockReset();
  h.activate.mockClear();
  h.toast.mockReset();
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.useRealTimers();
});

describe('useBufferRoute — active buffer to URL', () => {
  it('pushes /buffer/<id> when a buffer is activated', async () => {
    known('1::#chan', 7);
    start();
    await activate('1::#chan');

    expect(h.push).toHaveBeenCalledWith('/buffer/7');
  });

  it('pushes once per buffer and does not re-push the route it just made', async () => {
    known('1::#a', 7);
    known('1::#b', 8);
    start();
    await activate('1::#a');
    await activate('1::#b');
    await nextTick();

    // The loop guard: each activation produces exactly one navigation, and the
    // route change it causes doesn't bounce back through the inbound watcher
    // into another push.
    expect(h.push.mock.calls).toEqual([['/buffer/7'], ['/buffer/8']]);
    // Nor did the inbound direction re-activate what was already active.
    expect(h.activate).not.toHaveBeenCalled();
  });

  it.each([['#chan'], ['&local'], ['+modeless'], ['!12345chan'], ['alice']])(
    'addresses %s by id, with no name in the URL',
    async (target) => {
      known(`1::${target}`, 42);
      start();
      await activate(`1::${target}`);

      expect(h.push).toHaveBeenCalledWith('/buffer/42');
      // The point of id addressing: no sigil ever reaches the URL, so there is
      // no encoding path left to get wrong.
      expect(h.push.mock.calls[0][0]).not.toContain(target);
    },
  );

  it('holds the URL for an optimistic buffer, then pushes when its id lands', async () => {
    // "Send DM" to a nick never messaged before: the buffer exists locally but
    // the server hasn't answered with a row id yet.
    known('1::#old', 7);
    start();
    await activate('1::#old');
    h.push.mockReset();

    known('1::newpal'); // no id
    await activate('1::newpal');
    expect(h.push).not.toHaveBeenCalled();

    known('1::newpal', 9); // server answers
    await nextTick();

    // Push, not replace — the buffer we came from has to keep its entry, or
    // back/swipe would skip straight past it.
    expect(h.push).toHaveBeenCalledWith('/buffer/9');
    expect(h.replace).not.toHaveBeenCalled();
  });

  it('replaces to / when the active buffer goes away', async () => {
    known('1::#chan', 7);
    start();
    await activate('1::#chan');

    h.s.networks.activeKey = null; // buffer closed, or its network was removed
    await nextTick();

    expect(h.replace).toHaveBeenCalledWith('/');
  });

  it('replaces to / when an ID-LESS active buffer goes away', async () => {
    // The 'none'/'pending' distinction: both mean "no id to name it with", so
    // collapsing them would leave this transition silent and the URL pointing at
    // a buffer that is gone.
    known('1::#chan', 7);
    start();
    await activate('1::#chan');
    known('1::pal'); // no id
    await activate('1::pal');

    // Landing on an id-less buffer is NOT "nothing is active" — the URL just
    // stays where it was. Bouncing to / here would throw the user back to the
    // buffer list the instant they opened a new DM.
    expect(h.replace).not.toHaveBeenCalled();

    h.s.networks.activeKey = null;
    await nextTick();

    expect(h.replace).toHaveBeenCalledExactlyOnceWith('/');
  });

  it('leaves the URL alone when a rename moves a buffer to a new key', async () => {
    known('1::oldnick', 7);
    start();
    await activate('1::oldnick');
    h.push.mockReset();

    // A rename keeps the same Buffer (and id) under a new key — the id index
    // re-points. The URL names the id, so it stays correct with no navigation.
    delete h.s.buffers['1::oldnick'];
    known('1::newnick', 7);
    await activate('1::newnick');

    expect(h.push).not.toHaveBeenCalled();
    expect(h.s.route.path).toBe('/buffer/7');
  });
});

describe('pushBuffer — one guard, not two', () => {
  /** A router parked at `at`, whose pushes stay in flight until released. */
  function pendingRouter(at: string) {
    const pushes: string[] = [];
    let release!: () => void;
    const settled = new Promise<void>((r) => (release = r));
    const m = /^\/buffer\/(\d+)$/.exec(at);
    return {
      pushes,
      release,
      router: {
        currentRoute: {
          value: { name: m ? 'buffer' : 'chat', params: m ? { id: m[1] } : {} },
        },
        push: (to: string) => {
          pushes.push(to);
          return settled;
        },
      } as any,
    };
  }

  it('navigates to the current route when a push elsewhere is in flight', async () => {
    // The route lags a push — the whole reason an in-flight target is tracked.
    // pushBuffer used to re-check the route ANYWAY, so with /buffer/8 in flight
    // a re-activation of #a (id 7, which the route still names) read as
    // "already there" and was dropped; /buffer/8 then landed and the inbound
    // binding moved the user to #b. Two guards for one decision.
    const { router, pushes, release } = pendingRouter('/buffer/7');

    pushBuffer(router, 8); // in flight, route still says 7
    pushBuffer(router, 7); // the user comes back to #a before it lands

    expect(pushes).toEqual(['/buffer/8', '/buffer/7']);
    release();
    await Promise.resolve();
  });

  it('still skips a push to where we already are', async () => {
    const { router, pushes, release } = pendingRouter('/buffer/7');
    pushBuffer(router, 7);
    expect(pushes).toEqual([]);
    release();
    await Promise.resolve();
  });
});

describe('useBufferRoute — URL to active buffer', () => {
  it('activates the buffer a launch URL names', async () => {
    known('1::#chan', 7);
    applyPath('/buffer/7'); // the launch URL is already in place when we mount
    start();
    await nextTick();

    expect(h.activate).toHaveBeenCalledWith(1, '#chan');
    expect(h.push).not.toHaveBeenCalled();
  });

  it('opens a reply thread’s buffer without reading its lines', async () => {
    known('1::#chan', 7);
    applyPath('/buffer/7/thread/abc');
    start();
    await nextTick();

    expect(h.activate).toHaveBeenCalledWith(1, '#chan', { thread: true });
    expect(h.push).not.toHaveBeenCalled();
  });

  it('activates on a back/forward hop', async () => {
    known('1::#a', 7);
    known('1::#b', 8);
    start();
    await activate('1::#a');
    await activate('1::#b');
    h.activate.mockClear();
    h.push.mockReset(); // discard the two setup activations' own pushes

    // Browser back — or, on an installed PWA, the platform swipe gesture, which
    // is the same history.back(). The route moves and nothing else does.
    applyPath('/buffer/7');
    await nextTick();

    expect(h.activate).toHaveBeenCalledWith(1, '#a');
    // And the activation it triggered must NOT push the route back on. This is
    // the whole loop guard: a back hop that re-pushes its own destination adds
    // a forward entry every time, so back/forward (and the PWA swipe) would
    // walk into a stack that grows in both directions and never leaves #a.
    expect(h.push).not.toHaveBeenCalled();
  });

  it('ignores a non-numeric id rather than resolving NaN', async () => {
    start();
    applyPath('/buffer/nonsense');
    await nextTick();

    expect(h.activate).not.toHaveBeenCalled();
    expect(h.toast).not.toHaveBeenCalled();
  });

  it('activates the system buffer from /system, and routes back to it by name', async () => {
    h.s.buffers[':system:'] = { networkId: null, target: ':system:' }; // no id yet
    start();
    h.s.route.name = 'system';
    h.s.route.path = '/system';
    await nextTick();

    expect(h.activate).toHaveBeenCalledWith(null, ':system:');
  });

  it('sends an active app-scoped buffer to /system rather than an id', async () => {
    // It may have no row id at all before the socket connects, so an id-based
    // URL would make the connection log unreachable exactly when it's wanted.
    h.s.buffers[':system:'] = { networkId: null, target: ':system:' };
    start();
    await activate(':system:');

    // PUSH, not replace: opening the console is a navigation like any other
    // buffer switch. Replacing swallowed the entry the user came from, so
    // reading a channel then opening the console lost the channel from history.
    expect(h.push).toHaveBeenCalledWith('/system');
    expect(h.replace).not.toHaveBeenCalled();
  });

  it('drops a non-numeric /buffer/<junk> back to /', async () => {
    known('1::#chan', 7);
    start();
    await activate('1::#chan');
    h.replace.mockReset();

    applyPath('/buffer/nonsense');
    await nextTick();

    // Otherwise the address bar keeps asserting a buffer the shell isn't
    // showing; an unknown NUMERIC id already ends the same way, on timeout.
    expect(h.replace).toHaveBeenCalledWith('/');
  });

  it('does not deactivate when navigating to /', async () => {
    known('1::#chan', 7);
    start();
    await activate('1::#chan');
    h.activate.mockClear();

    // Mobile "back to the buffer list": a screen change, not a buffer change.
    // Deactivating here would run activate()'s mark-read and divider snapshot.
    applyPath('/');
    await nextTick();

    expect(h.activate).not.toHaveBeenCalled();
    expect(h.s.networks.activeKey).toBe('1::#chan');
  });

  it('DOES deactivate an id-less buffer when the URL lands on /', async () => {
    // The back-gesture lock. An optimistic DM has no URL, so the mobile shell
    // shows it on EVERY route via activeLacksId — landing on `/` while it is
    // active can only mean the user backed out of it (the platform gesture, or
    // goList normalizing). Holding it pinned the shell on the DM screen with a
    // back button that moved the URL and nothing else.
    known('1::#chan', 7);
    start();
    await activate('1::#chan');
    known('1::pal'); // no id
    await activate('1::pal'); // URL stays /buffer/7 — nothing can name the DM

    applyPath('/'); // the back gesture
    await nextTick();

    expect(h.s.networks.activeKey).toBeNull();
  });

  it('does not push when an activation echoes onto its own members route', async () => {
    // Back onto a /buffer/7/members history entry (or a members deep link
    // resolving): the inbound side activates buffer 7, and the outbound
    // watcher must read the members route as "already there" — pushing
    // /buffer/7 here ejects the user from the member list they just reached.
    // This is why routeId() is NOT name-gated; see its divergence note.
    known('1::#a', 7);
    start();
    applyPath('/buffer/7/members');
    await nextTick();

    expect(h.activate).toHaveBeenCalledWith(1, '#a');
    expect(h.push).not.toHaveBeenCalled();
  });

  it('defers an unresolvable id until the buffer arrives over the socket', async () => {
    vi.useFakeTimers();
    h.s.connected = false;
    applyPath('/buffer/7');
    start();
    await nextTick();

    // Cold launch: the route landed before any buffer did.
    expect(h.activate).not.toHaveBeenCalled();

    known('1::#chan', 7);
    h.s.connected = true;
    await nextTick();

    expect(h.activate).toHaveBeenCalledWith(1, '#chan');
    expect(h.toast).not.toHaveBeenCalled();
  });

  it('resolves when the buffers land AFTER the socket connects', async () => {
    // The real cold-start order, and the one that matters: useSocket flips
    // `connected` on open, and only then does the snapshot frame arrive and
    // register any buffers. A resolver that only re-checks when `connected`
    // changes has already missed its one chance by the time the ids exist.
    vi.useFakeTimers();
    h.s.connected = false;
    applyPath('/buffer/7');
    start();
    await nextTick();

    h.s.connected = true; // socket open — no buffers yet
    await nextTick();
    expect(h.activate).not.toHaveBeenCalled();

    known('1::#chan', 7); // snapshot frame lands
    await nextTick();

    expect(h.activate).toHaveBeenCalledWith(1, '#chan');
    expect(h.toast).not.toHaveBeenCalled();
  });

  it('toasts and drops back to / when the buffer never arrives', async () => {
    vi.useFakeTimers();
    h.s.connected = false;
    applyPath('/buffer/7');
    start();
    await nextTick();

    await vi.advanceTimersByTimeAsync(10_000);

    expect(h.toast).toHaveBeenCalledTimes(1);
    expect(h.replace).toHaveBeenCalledWith('/');
    // And NOTHING else navigates. Activating a landing buffer here fired the
    // outbound watcher, which pushed /system before this replace had finalized
    // and cancelled it — leaving the dead /buffer/<id> one Back press away,
    // where it would time out and toast all over again. Choosing where to land
    // is the shell's job (DesktopChat's rule re-runs when the route settles).
    expect(h.activate).not.toHaveBeenCalled();
    expect(h.push).not.toHaveBeenCalled();
  });

  it('does not toast for a stale wait once the user has navigated on', async () => {
    vi.useFakeTimers();
    h.s.connected = false;
    applyPath('/buffer/7');
    start();
    await nextTick();

    // The user reaches a real buffer before the dead id's timeout fires. The
    // superseded wait must not fire its toast on top of a working session.
    known('1::#chan', 8);
    h.s.connected = true;
    applyPath('/buffer/8');
    await nextTick();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(h.activate).toHaveBeenCalledWith(1, '#chan');
    expect(h.toast).not.toHaveBeenCalled();
  });

  it('cancels a dead-id wait when an id-less buffer activates', async () => {
    // Send DM mid-wait: the optimistic buffer cannot move the URL, so the
    // timeout's routeId() guard alone can never suppress the stale toast —
    // the route still names the dead id. The 'pending' branch has to cancel
    // the wait like every other activation does.
    vi.useFakeTimers();
    applyPath('/buffer/999');
    start();
    await nextTick();

    known('1::newpal'); // no id
    await activate('1::newpal');
    await vi.advanceTimersByTimeAsync(10_000);

    expect(h.toast).not.toHaveBeenCalled();
    expect(h.replace).not.toHaveBeenCalled();
  });
});
