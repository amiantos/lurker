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
    // Dedicated admin panel (Milestone 4). Gated by both LURKER_NEW_ADMIN_PANEL
    // and the admin role via the guard below; the flag defaults off, so this
    // route is a no-op for existing self-hosted installs.
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
  if (to.meta.requiresAdmin) {
    // The admin panel needs the instance flag on AND an admin account. Either
    // missing → bounce to Settings rather than render an empty/forbidden shell.
    // Fetch config on demand so a deep-link/refresh to /admin still resolves it.
    const config = useConfigStore();
    if (!config.checked) await config.fetch();
    if (!config.newAdminPanel || !auth.isAdmin) return { name: 'settings' };
  }
});

export default router;
