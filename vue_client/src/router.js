// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: Elastic-2.0

import { createRouter, createWebHistory } from 'vue-router';
import { useAuthStore } from './stores/auth.js';

const routes = [
  { path: '/login', name: 'login', component: () => import('./views/Login.vue') },
  { path: '/invite/:token', name: 'invite', component: () => import('./views/InviteAccept.vue') },
  { path: '/', name: 'chat', component: () => import('./views/Chat.vue'), meta: { requiresAuth: true } },
  { path: '/settings/:category?', name: 'settings', component: () => import('./views/Settings.vue'), meta: { requiresAuth: true } },
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
});

export default router;
