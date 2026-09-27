// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { onBeforeUnmount, watch } from 'vue';
import { useRoute, useRouter, type Router } from 'vue-router';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore, bufferKey } from '../stores/buffers.js';
import { useToastsStore } from '../stores/toasts.js';
import { SYSTEM_KEY } from '../lib/virtualBuffers.js';
import { connected } from './useSocket.js';
import { whenReady } from './deferredReady.js';
import { shouldPushBuffer } from '../utils/bufferNav.js';

// Two-way binding between the active buffer and the URL (#744), so every buffer
// has a direct link and browser back/forward walks between them. On an installed
// PWA that is also what makes the platform's back gesture work — the iOS
// left-edge swipe and the Android system back both just call history.back() —
// which is why #200 needs no gesture code of its own.
//
// This sits alongside navHistory (#309, Cmd+[ / ]) rather than replacing it. The
// two are deliberately independent: navHistory is a BUFFER trail with its own
// cursor, dead-buffer skipping and a 100-entry cap; browser history is the
// LOCATION stack. Neither reads the other, and neither needs the other to
// agree: a hop driven from here lands in navHistory as an ordinary visit —
// which, like any visit recorded from a back position, truncates navHistory's
// forward branch (recordVisit's contract) — and navHistory's own
// back()/forward() go through activate() and so push a URL like any other
// navigation, which is right, since a nav-history hop IS a navigation.

// The buffer id of a navigation we've started but that hasn't landed yet.
//
// router.push resolves ASYNCHRONOUSLY, so `route.params.id` still reports the
// old buffer for a tick after a push is issued — long enough for the activeKey
// watcher below to check the route, see a stale id, and push the same buffer a
// second time. Opening a buffer has two legitimate callers (the watcher, and
// MobileChat's list tap, which has to cover re-tapping the buffer that is
// already active), so both go through here and the guard is this synchronous
// value rather than the lagging route.
let inFlightId: number | null = null;

/** The buffer id the CURRENT route names, or null. Only the buffer route counts:
 *  `/buffer/7/members` carries id 7 too, and treating that as "already there"
 *  would strand a jump to the buffer you're on behind the member list. */
function currentRouteBufferId(router: Router): number | null {
  const current = router.currentRoute.value;
  if (current.name !== 'buffer') return null;
  const raw = current.params.id;
  if (typeof raw !== 'string') return null;
  const n = Number(raw);
  return Number.isInteger(n) ? n : null;
}

/** Navigate to a buffer, unless we're already there or already on the way. */
export function pushBuffer(router: Router, id: number): Promise<void> {
  // The SAME predicate the watcher uses, deliberately. This function used to
  // re-check the route unconditionally, which quietly overrode it: with a push
  // to another buffer in flight, shouldPushBuffer correctly says "navigate" and
  // this said "already there" off the stale route — so the user's last
  // activation was dropped and the in-flight one landed instead. Two independent
  // guards for one decision is what made that possible; now the predicate is
  // shared. The route READER is not: this one name-gates to 'buffer' (a
  // deliberate push from the member list must leave it), where the watcher's
  // routeId() counts the members route as "already there" — see its comment.
  if (!shouldPushBuffer(id, currentRouteBufferId(router), inFlightId)) return Promise.resolve();
  inFlightId = id;
  return router
    .push(`/buffer/${id}`)
    .then(() => undefined)
    .finally(() => {
      if (inFlightId === id) inFlightId = null;
    });
}

export function useBufferRoute(): void {
  const router = useRouter();
  const route = useRoute();
  const networks = useNetworksStore();
  const buffers = useBuffersStore();
  const toasts = useToastsStore();

  // Cleanup for the deferred cold-start resolver below. Only ever one in
  // flight: a new route supersedes whatever the last one was waiting for.
  // Null out BEFORE invoking so a cancel that navigates (the timeout path
  // replaces to `/`) can't re-enter this and cancel its own successor.
  let cancelPending: (() => void) | null = null;
  function clearPending(): void {
    const cancel = cancelPending;
    cancelPending = null;
    cancel?.();
  }

  // The id currently in the URL, or null at `/`. Params are strings; anything
  // non-numeric (a hand-typed /buffer/foo) is treated as "no buffer" rather
  // than parsed to NaN, which would silently match nothing downstream.
  //
  // Deliberately NOT name-gated, unlike pushBuffer's currentRouteBufferId:
  // `/buffer/7/members` answers 7 here. The outbound watcher is the only
  // caller, and for it the members route IS "already there" — an activation
  // echoing back onto its own members entry (Back onto one, or a members deep
  // link resolving) must not push the chat screen over the member list. The
  // name-gated twin exists for the opposite case; unifying the two re-breaks
  // whichever side the merge favours.
  function routeId(): number | null {
    const raw = route.params.id;
    if (typeof raw !== 'string' || raw === '') return null;
    const n = Number(raw);
    return Number.isInteger(n) ? n : null;
  }

  // --- Outbound: active buffer -> URL -------------------------------------
  //
  // Watches the (key, id) PAIR, not activeKey alone. A buffer created
  // optimistically — the profile modal's "Send DM" to a nick never DM'd before
  // — has no id until the server answers (see Buffer.id), and there is no URL
  // to name it with until then. So we hold: the URL stays on the previous
  // buffer, and the moment the id lands this watcher re-fires and pushes. Push,
  // not replace: the buffer we came from has to keep its history entry, or
  // back/swipe would skip straight past it.
  watch(
    // Three distinct states, not two: 'none' (nothing active) and 'pending' (a
    // buffer is active but has no server id yet) must not collapse into one
    // value, or the transition between them wouldn't fire the watcher and the
    // URL would be left naming a buffer that is gone.
    (): 'none' | 'pending' | 'system' | number => {
      const key = networks.activeKey;
      if (!key) return 'none';
      const buf = buffers.byKey(key);
      if (!buf) return 'pending';
      // App-scoped (networkId null) — addressable by name, and deliberately not
      // by row id, which it may not have yet. See the /system route.
      if (buf.networkId == null) return 'system';
      return buf.id ?? 'pending';
    },
    (id) => {
      if (id === 'none') {
        // The active buffer went away (closed, or its network was removed) —
        // activeKey only nulls in those cases. Replace rather than push: this
        // is involuntary, and a dead buffer must not stay reachable by pressing
        // Forward.
        clearPending();
        if (route.path !== '/') void router.replace('/');
        return;
      }
      if (id === 'pending') {
        // No server id yet — see above. But the ACTIVATION is real, so it
        // cancels a pending resolution like every other branch: without this,
        // opening an optimistic DM while a dead /buffer/<id> was still waiting
        // left its 10s timer armed, and the timeout's routeId() guard can't
        // suppress it — an id-less buffer can't move the URL, so the route
        // still names the dead id — landing a spurious "couldn't open" toast
        // and a replace('/') on top of the user's composing session.
        clearPending();
        return;
      }
      if (id === 'system') {
        clearPending();
        // Push, not replace. Opening the console is a navigation like any other
        // buffer switch, and replacing swallows the entry the user came from —
        // read a channel, tap the logo, press Back, and the channel is gone.
        // It also beats MobileChat's own push (this watcher flushes first), so
        // making it a replace here overrode the correct behaviour there.
        if (route.name !== 'system') void router.push('/system');
        return;
      }
      if (!shouldPushBuffer(id, routeId(), inFlightId)) return;
      clearPending();
      pushBuffer(router, id);
    },
  );

  // --- Inbound: URL -> active buffer --------------------------------------
  //
  // Resolution goes through the store's `byId` getter, NOT the module-level
  // bufferKeyForId index: that Map is invisible to Vue, so a watcher built on
  // it would never re-fire when the ids finally land — and on a cold launch
  // they land after the socket connects, which is the one case this whole
  // deferral exists for.
  function open(id: number): boolean {
    const buf = buffers.byId(id);
    if (!buf) return false;
    const key = bufferKey(buf.networkId, buf.target);
    if (key !== networks.activeKey) {
      // A thread's URL shows the thread, not the buffer's lines: don't read them.
      if (route.name === 'buffer-thread')
        buffers.activate(buf.networkId, buf.target, { thread: true });
      else buffers.activate(buf.networkId, buf.target);
    }
    return true;
  }

  watch(
    // Name AND id: `/`, `/system` and `/buffer/:id` are three destinations, and
    // two of them carry no id at all. A string rather than an array because the
    // callback only needs to know that something moved.
    () => `${String(route.name)}|${String(route.params.id ?? '')}`,
    () => {
      if (route.name === 'system') {
        clearPending();
        if (networks.activeKey !== SYSTEM_KEY) buffers.activate(null, SYSTEM_KEY);
        return;
      }
      const id = routeId();
      clearPending();
      // At `/` (see the note below on not deactivating) — or at a hand-typed
      // `/buffer/nonsense`, which names no buffer we could ever resolve. Drop
      // that back to `/` rather than leaving the address bar asserting a buffer
      // the shell isn't showing; an unknown NUMERIC id already ends the same
      // way, via the timeout below.
      if (id == null) {
        if (route.params.id != null) {
          void router.replace('/');
          return;
        }
        // At `/`. An id-ADDRESSABLE active buffer stays active (see the note
        // below on not deactivating) — but an id-LESS one (an optimistic DM)
        // cannot be named by any URL, so the mobile shell shows it on every
        // route via activeLacksId. Landing on `/` while it is active therefore
        // means the user backed out of it (the platform gesture, or goList
        // normalizing) — hold it and the shell is pinned on the DM screen with
        // a dead back button. Deactivate, exactly as if the buffer had closed;
        // it stays in the store and the list.
        const activeKey = networks.activeKey;
        const active = activeKey ? buffers.byKey(activeKey) : null;
        if (active && active.networkId != null && active.id == null) networks.clearActive();
        return;
      }

      if (open(id)) return;
      // Unknown id. Either a cold start where buffers haven't arrived over the
      // WS yet, or a link to a buffer this account no longer has. Wait for the
      // first, time out into the second.
      cancelPending = whenReady(
        () => connected.value && buffers.byId(id) != null,
        () => open(id),
        () => {
          // Say so rather than leaving the user on an empty shell wondering,
          // and drop the URL back to `/` so it stops claiming a buffer we can't
          // show. Guarded on the id still being the one in the URL: by now the
          // user may have navigated somewhere that works.
          if (routeId() !== id) return;
          toasts.push({
            kind: 'info',
            title: 'Couldn’t open that conversation',
            body: '',
            ttlMs: 5000,
          });
          // Drop the dead URL. Nothing is activated here on purpose: doing so
          // fired the outbound watcher, which pushed /system before this
          // replace had finalized and cancelled it — leaving the dead
          // /buffer/<id> one Back press away, where it would time out and toast
          // all over again. Landing somewhere is the shell's business, and
          // DesktopChat re-runs its rule when the route settles at `/`.
          void router.replace('/');
        },
      );
    },
    // The first render has to honor whatever the launch URL named — that IS the
    // cold-start deep link — not just later changes.
    //
    // Default 'pre' flush, deliberately: it runs the callback before the
    // component re-renders in the same flush, so the activation is always in
    // place by the time anything paints. A 'sync' flush was tried while chasing
    // a reported flash, and would put activate()'s mark-read, socket sends and
    // hydration inside the route mutation itself — real cost, and the flash
    // turned out to be Safari compositing a cached snapshot during its back
    // gesture, which no flush timing can touch.
    { immediate: true },
  );

  // Navigating to `/` deliberately does NOT deactivate. `/` means "not looking
  // at a buffer" (the mobile list screen), not "no buffer selected": clearing
  // activeKey would run activate()'s mark-read, divider snapshot and detached
  // cleanup for what is only a change of screen.

  onBeforeUnmount(clearPending);
}
