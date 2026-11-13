// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// The ident surface follows the server's ident report. In engine mode ident
// runs on the engine: 'unknown' is the server unable to see it (#1138), and
// the pane must not take that as "off" — hiding the editor from an operator
// whose engine does answer ident was the bug. When the engine does say (#1139),
// "off" has to point at the engine, where the variables go.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

import { useAdminStore, type AdminIdent } from '../../stores/admin.js';
import UsersPane from './UsersPane.vue';

function mountPane(status: AdminIdent['status'], host: AdminIdent['host'] = 'server'): VueWrapper {
  const store = useAdminStore();
  store.users = [
    {
      id: 2,
      username: 'bob',
      role: 'user',
      createdAt: '2026-01-01T00:00:00.000Z',
      ident: null,
      effectiveIdent: 'bob',
      identConflict: true,
    },
  ];
  store.usersLoaded = true;
  store.ident = { status, host };
  store.fetchUsers = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  return mount(UsersPane);
}

const editor = (w: VueWrapper) => w.findAll('button').filter((b) => b.text() === 'ident');
const banner = (w: VueWrapper) => w.text().includes("Networks can't ask this server");
const unconfirmed = (w: VueWrapper) => w.text().includes("which this server can't check");
const onEngine = (w: VueWrapper) => w.text().includes('on the engine');
const notAnswering = (w: VueWrapper) => w.text().includes("isn't answering");

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('UsersPane ident surface (#1138, #1139)', () => {
  it('offers the editor and the tag when ident is running', () => {
    const w = mountPane('on');
    expect(editor(w)).toHaveLength(1);
    expect(w.find('.ident-tag').exists()).toBe(true);
    expect(w.find('.conflict-tag').exists()).toBe(true);
    expect(banner(w)).toBe(false);
    expect(unconfirmed(w)).toBe(false);
    expect(notAnswering(w)).toBe(false);
  });

  it('hides them and says how to turn ident on when nothing answers', () => {
    const w = mountPane('off');
    expect(editor(w)).toHaveLength(0);
    expect(w.find('.ident-tag').exists()).toBe(false);
    expect(w.find('.conflict-tag').exists()).toBe(false);
    expect(banner(w)).toBe(true);
    expect(onEngine(w)).toBe(false);
    expect(unconfirmed(w)).toBe(false);
  });

  // The variables on this server start nothing while an engine is configured.
  it('points at the engine when the engine says ident is off', () => {
    const w = mountPane('off', 'engine');
    expect(editor(w)).toHaveLength(0);
    expect(banner(w)).toBe(true);
    expect(onEngine(w)).toBe(true);
    expect(w.text()).toContain('Setting them on this server does nothing');
  });

  it.each([
    ['server', 'Ident is set up on this server'],
    ['engine', 'Ident is set up on the engine'],
  ] as const)('keeps the editor and says ident is not answering on the %s', (host, says) => {
    const w = mountPane('failed', host);
    expect(editor(w)).toHaveLength(1);
    expect(w.find('.ident-tag').exists()).toBe(true);
    expect(banner(w)).toBe(false);
    expect(unconfirmed(w)).toBe(false);
    expect(w.text()).toContain(says);
    expect(notAnswering(w)).toBe(true);
  });

  it("keeps the editor, and says it can't confirm ident, when the server can't tell", () => {
    const w = mountPane('unknown', 'engine');
    expect(editor(w)).toHaveLength(1);
    expect(w.find('.ident-tag').exists()).toBe(true);
    // A duplicate is still worth flagging: if ident does run, it's ambiguous.
    expect(w.find('.conflict-tag').exists()).toBe(true);
    expect(banner(w)).toBe(false);
    expect(unconfirmed(w)).toBe(true);
    expect(notAnswering(w)).toBe(false);
  });
});
