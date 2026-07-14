// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import { useAuthStore } from './stores/auth.js';
import { useConfigStore } from './stores/config.js';

const routes: RouteRecordRaw[] = [
  { path: '/login', name: 'login', component: () => import('./views/Login.vue') },
  { path: '/invite/:token', name: 'invite', component: () => import('./views/InviteAccept.vue') },
  {
    path: '/',
    name: 'chat',
    component: () => import('./views/Chat.vue'),
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

export default router;
