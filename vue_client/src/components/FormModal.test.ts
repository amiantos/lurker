// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// Cancel is disabled while a save is out, but Escape and the header's X are
// closes too. A close in that window drops the form the answer belongs to: a
// refusal has nowhere to show, and a success can close whatever form was opened
// since.

import { describe, it, expect, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import FormModal from './FormModal.vue';

function mountModal(busy: boolean) {
  return mount(FormModal, {
    props: { word: 'x', title: 'a form', busy },
    slots: { default: '<input class="field" />' },
    global: { stubs: { Teleport: true } },
  });
}

describe('FormModal', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('closes on Escape and on the header X', async () => {
    const w = mountModal(false);
    await w.find('.modal').trigger('keydown', { key: 'Escape' });
    await w.find('.close-btn').trigger('click');
    expect(w.emitted('close')).toHaveLength(2);
  });

  it('does not close by either while a save is out', async () => {
    const w = mountModal(true);
    await w.find('.modal').trigger('keydown', { key: 'Escape' });
    await w.find('.close-btn').trigger('click');
    expect(w.emitted('close')).toBeUndefined();
  });

  it('submits the form, and not while busy from its button', async () => {
    const w = mountModal(false);
    await w.find('form').trigger('submit');
    expect(w.emitted('submit')).toHaveLength(1);
    expect(mountModal(true).find('button[type="submit"]').attributes('disabled')).toBeDefined();
  });
});
