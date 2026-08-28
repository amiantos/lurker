// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

import { describe, it, expect } from 'vitest';
import { defineComponent, h, onMounted } from 'vue';
import { mount } from '@vue/test-utils';
import { createRouter, createMemoryHistory, RouterView } from 'vue-router';
import router from './router.js';

// Shape assertions run against the REAL route table, not a copy. An earlier
// version of this file rebuilt the table by hand, which is how it managed to
// pass while the real one was malformed: `/buffer/:id` was declared as an ALIAS
// of `/`, and an alias must carry the same params as the record it aliases.
// vue-router warned (R0102) and navigation misbehaved — pushes landed back on
// `/` — but resolve() still worked, so a hand-copied table looked fine.

describe('public routes', () => {
  it('serves account recovery without an auth requirement', () => {
    // A recovery link is redeemed by someone who by definition cannot sign in,
    // so a requiresAuth here would bounce every visitor to /login.
    const recover = router.getRoutes().find((r) => r.name === 'recover');
    expect(recover?.path).toBe('/recover/:token');
    expect(recover?.meta?.requiresAuth).toBeUndefined();
    expect(router.resolve('/recover/tok123').params).toEqual({ token: 'tok123' });
  });
});

describe('chat routes', () => {
  it('gives each chat screen its own named record', () => {
    const byName = new Map(router.getRoutes().map((r) => [r.name, r.path]));
    expect(byName.get('chat')).toBe('/');
    expect(byName.get('buffer')).toBe('/buffer/:id');
    expect(byName.get('buffer-members')).toBe('/buffer/:id/members');
    // Named, not id-addressed: the app-scoped console has to be reachable
    // before the server has handed out any row ids.
    expect(byName.get('system')).toBe('/system');
  });

  it('resolves a buffer path to its id param', () => {
    expect(router.resolve('/buffer/42').params).toEqual({ id: '42' });
    expect(router.resolve('/buffer/42').name).toBe('buffer');
  });

  it('leaves the id param empty at /', () => {
    expect(router.resolve('/').params.id).toBeUndefined();
    expect(router.resolve('/').name).toBe('chat');
  });

  it('distinguishes the members screen by name, not by path sniffing', () => {
    expect(router.resolve('/buffer/42/members').name).toBe('buffer-members');
    expect(router.resolve('/buffer/42/members').params.id).toBe('42');
  });

  it('keeps /system out of the id-addressed space', () => {
    expect(router.resolve('/system').name).toBe('system');
    expect(router.resolve('/system').params.id).toBeUndefined();
  });

  it('does not swallow other routes', () => {
    expect(router.resolve('/settings/appearance').name).toBe('settings');
    expect(router.resolve('/admin/users').name).toBe('admin');
  });

  it('routes every chat screen to the same component', () => {
    // What lets RouterView patch in place instead of remounting the shell (see
    // below) — they must be the same component object, which is why router.ts
    // declares one shared lazy loader rather than three inline imports.
    const comp = (name: string) =>
      router.getRoutes().find((r) => r.name === name)?.components?.default;
    expect(comp('buffer')).toBe(comp('chat'));
    expect(comp('buffer-members')).toBe(comp('chat'));
  });
});

describe('chat shell lifetime', () => {
  it('does NOT remount moving between /, a buffer, and members', async () => {
    // A remount re-runs useChatBootstrap's onMounted — a fresh networks.fetchAll
    // on every mobile trip back to the buffer list. Uses a local router because
    // the real one's auth guard would try to fetch on navigation; the property
    // under test is the shared component, which the suite above pins to the real
    // table.
    let mounts = 0;
    const Counted = defineComponent({
      setup() {
        onMounted(() => {
          mounts += 1;
        });
        return () => null;
      },
    });
    const local = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', name: 'chat', component: Counted },
        { path: '/buffer/:id', name: 'buffer', component: Counted },
        { path: '/buffer/:id/members', name: 'buffer-members', component: Counted },
      ],
    });
    const app = mount(defineComponent({ render: () => h(RouterView) }), {
      global: { plugins: [local] },
    });
    await local.isReady();

    await local.push('/buffer/7');
    await local.push('/buffer/7/members');
    await local.push('/buffer/8');
    await local.push('/');
    await local.push('/buffer/7');

    expect(mounts).toBe(1);
    app.unmount();
  });
});
