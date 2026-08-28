// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import { useAuthStore } from './stores/auth.js';
import { useConfigStore } from './stores/config.js';
import { useToastsStore } from './stores/toasts.js';
import { isChunkLoadError, safeSessionStorage, shouldReloadFor } from './lib/chunkReload.js';

// ONE lazy loader shared by the three chat routes below. Declaring
// `() => import(...)` three times would make three distinct async wrappers, and
// component reuse across those routes depends on them resolving to the same
// component object.
const chatShell = () => import('./views/Chat.vue');

const routes: RouteRecordRaw[] = [
  { path: '/login', name: 'login', component: () => import('./views/Login.vue') },
  { path: '/invite/:token', name: 'invite', component: () => import('./views/InviteAccept.vue') },
  {
    path: '/recover/:token',
    name: 'recover',
    component: () => import('./views/AccountRecovery.vue'),
  },
  // The three chat locations. All render the same shell; only the params differ.
  //
  // `/buffer/:id` names ONE buffer by its SERVER ID (#744) — never by name. The
  // id is stable across renames (see Buffer.id in stores/buffers.ts) and
  // survives part/rejoin (closing a buffer flips its state server-side, it
  // doesn't delete the row), so a bookmark keeps resolving. Addressing by name
  // would instead mean percent-encoding every `#&+!` sigil into the path, and
  // would leak channel and DM names into browser history, PWA recents and
  // Referer. `/buffer/:id/members` is the mobile member list (#200) — its own
  // entry, so the platform back gesture walks members → buffer → list one step
  // at a time.
  //
  // THREE RECORDS, not one record with aliases. An alias must declare the same
  // params as the record it aliases, so aliasing `/buffer/:id` onto `/` is
  // malformed — vue-router warns R0102 and navigation misbehaves (a push to
  // `/buffer/8` lands back on `/`, and the shell renders a buffer the URL
  // doesn't name). Separate records cost nothing: they share `chatShell` below,
  // so RouterView patches the same component in place instead of remounting —
  // router.test.ts pins that down, since a remount would re-run
  // useChatBootstrap's onMounted on every trip back to the list.
  //
  // The routes only name WHICH buffer; useBufferRoute owns the activation and
  // the reverse (activeKey → URL) direction.
  { path: '/', name: 'chat', component: chatShell, meta: { requiresAuth: true } },
  // The app-scoped system buffer (#355) gets a NAMED path rather than an id.
  // It is the one buffer that exists before the server answers — the store
  // seeds it at boot — so addressing it by row id would make it unreachable
  // exactly when it matters most: while disconnected, which is when the
  // connection log it carries is what you want to read.
  { path: '/system', name: 'system', component: chatShell, meta: { requiresAuth: true } },
  { path: '/buffer/:id', name: 'buffer', component: chatShell, meta: { requiresAuth: true } },
  {
    path: '/buffer/:id/members',
    name: 'buffer-members',
    component: chatShell,
    meta: { requiresAuth: true },
  },
  {
    path: '/settings/:category?',
    name: 'settings',
    component: () => import('./views/Settings.vue'),
    meta: { requiresAuth: true },
  },
  {
    // Dedicated admin panel (Milestone 4), gated on the admin role by the guard
    // below. It is where all instance administration lives; there is no longer a
    // Users category inside Settings.
    path: '/admin/:tab?',
    name: 'admin',
    component: () => import('./views/Admin.vue'),
    meta: { requiresAuth: true, requiresAdmin: true },
  },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

router.beforeEach(async (to) => {
  const auth = useAuthStore();
  if (!auth.checked) await auth.fetchMe();
  if (to.meta.requiresAuth && !auth.user) return { name: 'login', query: { next: to.fullPath } };
  if (to.name === 'login' && auth.user) return { name: 'chat' };

  // Self-heal a failed boot config fetch. The store deliberately leaves `checked`
  // false on failure so a later caller can retry — but App.vue's boot fetch runs
  // exactly once, so without a second caller a single transient /api/config
  // failure would strand the session on the standalone defaults for good, and a
  // hosted tenant would be shown the operator-only surfaces that edition hides.
  // Fire-and-forget: the store coalesces concurrent calls and latches on success,
  // so this is a no-op on every navigation after the first success, and it must
  // not block navigation.
  const config = useConfigStore();
  if (!config.checked) void config.fetch().catch(() => {});

  // Non-admins bounce to Settings rather than render a forbidden shell. Every
  // admin API is requireAdmin-gated regardless — this only decides what renders.
  if (to.meta.requiresAdmin && !auth.isAdmin) return { name: 'settings' };
});

// A lazy-route chunk that fails to load leaves the route permanently dead for
// this document (see lib/chunkReload.ts). Recover by reloading into the target
// so the user gets the page they asked for rather than a button that silently
// does nothing forever (#571).
router.onError((err, to) => {
  if (!isChunkLoadError(err)) return;
  const path = to?.fullPath;
  if (!path) return;
  if (shouldReloadFor(path, Date.now(), safeSessionStorage())) {
    window.location.assign(path);
    return;
  }
  // Already tried reloading for this path — the chunk is genuinely unavailable,
  // so reloading again would boot-loop. Tell the user instead: Lurker runs as a
  // PWA where there is no console to check, so a silent failure here is
  // indistinguishable from the bug we're fixing.
  useToastsStore().push({
    title: "Couldn't open that page",
    body: 'Part of the app failed to load. Reopening Lurker should fix it.',
    kind: 'error',
    ttlMs: 8000,
  });
});

export default router;
