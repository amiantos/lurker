// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// #775 lives entirely in the chip handlers and the edit round-trip: which levels
// a click leaves selected, and what `startEdit` reads back out of a saved rule.
// None of that is reachable from outside the SFC — the handlers aren't exported —
// and the bug was precisely that the two disagreed, so a test of either half
// alone would have gone on passing. Mount it and click.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

vi.mock('../../composables/useSocket.js', () => ({
  socketSend: vi.fn<(payload: Record<string, unknown>) => void>(),
}));

import { socketSend } from '../../composables/useSocket.js';
import { useIgnoresStore, type IgnoreEntry } from '../../stores/ignores.js';
import IgnoresPane from './IgnoresPane.vue';

function chip(wrapper: VueWrapper, label: string) {
  const found = wrapper.findAll('.chip').find((c) => c.text() === label);
  if (!found) throw new Error(`no chip labelled ${label}`);
  return found;
}

// The NOHIGHLIGHT modifier is the only checkbox in the "Event types" field.
function noHighlightBox(wrapper: VueWrapper) {
  return wrapper.find('.field .ck input[type="checkbox"]');
}

// The form lives in a modal: its footer button is the form's submit.
function submit(wrapper: VueWrapper) {
  return wrapper.find('.modal form').trigger('submit');
}

// The mask field is the first text input in the form.
function setMask(wrapper: VueWrapper, mask: string) {
  return wrapper.findAll('.rule-form input[type="text"]')[0].setValue(mask);
}

// What actually went to the server, or null if the submit was refused.
function sentRule(): Record<string, unknown> | null {
  const call = vi
    .mocked(socketSend)
    .mock.calls.map(([payload]) => payload)
    .findLast((p) => p.type === 'add-ignore');
  return (call?.rule as Record<string, unknown>) ?? null;
}

function seedEntry(entry: Partial<IgnoreEntry> & { levels: string[] }) {
  const store = useIgnoresStore();
  store.global = [
    {
      id: 7,
      createdAt: '2026-01-01T00:00:00.000Z',
      mask: 'bob!*@*',
      channels: null,
      pattern: null,
      patternKind: 'substr',
      isExcept: false,
      expiresAt: null,
      ...entry,
    } as IgnoreEntry,
  ];
}

describe('IgnoresPane — the ALL chip and the NOHIGHLIGHT-only rule (#775)', () => {
  let wrapper: VueWrapper;

  beforeEach(async () => {
    setActivePinia(createPinia());
    vi.mocked(socketSend).mockClear();
    // The modal teleports to body; stubbed, it renders in place. Opened on
    // "add", as someone building a rule would; the edit tests open it again
    // from a row's pen.
    wrapper = mount(IgnoresPane, { global: { stubs: { Teleport: true } } });
    await wrapper.find('.add-row button').trigger('click');
  });

  it('starts on ALL, which is what an unqualified /ignore means', async () => {
    await setMask(wrapper, 'bob');
    await submit(wrapper);
    expect(sentRule()?.levels).toEqual(['ALL']);
  });

  // ⚠⚠ The heart of it. ALL was switch-on-only, and the granular chips snapped
  // back to it whenever the last one was cleared — so "no hide levels" was a
  // state the form could not be in, and a NOHIGHLIGHT-only rule could not be
  // built. It is the rule that suppresses a nick's highlights without hiding
  // anything, and /ignore bob NOHIGHLIGHT makes one happily.
  it('builds a NOHIGHLIGHT-only rule when ALL is switched off', async () => {
    await setMask(wrapper, 'bob');
    await noHighlightBox(wrapper).setValue(true);
    await chip(wrapper, 'ALL').trigger('click');
    await submit(wrapper);
    expect(sentRule()?.levels).toEqual(['NOHIGHLIGHT']);
  });

  it('refuses a rule with nothing selected at all, instead of quietly meaning ALL', async () => {
    // buildLevels used to fall back to ['ALL'], which turned "hide nothing" into
    // "hide everything" on the way out — silently, and in the one case where an
    // empty selection is what the user meant.
    await setMask(wrapper, 'bob');
    await chip(wrapper, 'ALL').trigger('click');
    await submit(wrapper);
    expect(sentRule()).toBeNull();
    expect(wrapper.find('.form-error').text()).toContain('Suppress highlights only');
  });

  it('keeps a granular selection selectable and clearable', async () => {
    await setMask(wrapper, 'bob');
    await chip(wrapper, 'JOINS').trigger('click');
    await chip(wrapper, 'PARTS').trigger('click');
    expect(chip(wrapper, 'ALL').attributes('aria-pressed')).toBe('false');
    await chip(wrapper, 'PARTS').trigger('click');
    await submit(wrapper);
    expect(sentRule()?.levels).toEqual(['JOINS']);
  });

  // ⚠⚠ toggleLevel used to snap back to ALL when the last granular chip was cleared, which is
  // half of why the empty state was unreachable. The "selectable and clearable" case above never
  // clears the LAST chip, so it goes on passing with the snap-back re-added — this is the one
  // that pins its removal.
  it('does not snap back to ALL when the last granular chip is cleared', async () => {
    await setMask(wrapper, 'bob');
    await chip(wrapper, 'JOINS').trigger('click');
    await chip(wrapper, 'JOINS').trigger('click');
    expect(chip(wrapper, 'ALL').attributes('aria-pressed')).toBe('false');
    await submit(wrapper);
    expect(sentRule()).toBeNull();
  });

  // ⚠⚠ The footgun this change newly made reachable. A modifier-only rule with no who/where/what
  // matches everyone and, being non-hiding, is unbounded — it kills every highlight on every
  // network while the list shows it as nothing but `*  NOHIGHLIGHT`. The pane already refuses
  // the ALL-shaped version of the same mistake.
  it('refuses an unscoped highlight-suppression rule', async () => {
    await noHighlightBox(wrapper).setValue(true);
    await chip(wrapper, 'ALL').trigger('click');
    await submit(wrapper);
    expect(sentRule()).toBeNull();
    expect(wrapper.find('.form-error').text()).toContain('silence every highlight');
  });

  it('combines hide levels with the modifier — the pairing the fix must not lose', async () => {
    await setMask(wrapper, 'bob');
    await chip(wrapper, 'JOINS').trigger('click');
    await noHighlightBox(wrapper).setValue(true);
    await submit(wrapper);
    expect(sentRule()?.levels).toEqual(['JOINS', 'NOHIGHLIGHT']);
  });

  // ⚠⚠ The other half, and the destructive one: `lv.every(l => l === 'NOHIGHLIGHT')`
  // is true for ['NOHIGHLIGHT'], so opening one of these rules lit ALL — and
  // saving wrote back ['ALL','NOHIGHLIGHT'], turning "don't highlight me for bob"
  // into "hide bob entirely". Rules made with /ignore were rewritten by the act of
  // looking at them in the GUI.
  it('round-trips a NOHIGHLIGHT-only rule through edit without adding ALL', async () => {
    seedEntry({ levels: ['NOHIGHLIGHT'] });
    await wrapper.vm.$nextTick();
    await wrapper.find('.device .btn-bar button').trigger('click');
    expect(chip(wrapper, 'ALL').attributes('aria-pressed')).toBe('false');
    await submit(wrapper);
    expect(sentRule()?.levels).toEqual(['NOHIGHLIGHT']);
  });

  it('round-trips a mixed rule through edit', async () => {
    seedEntry({ levels: ['JOINS', 'NOHIGHLIGHT'] });
    await wrapper.vm.$nextTick();
    await wrapper.find('.device .btn-bar button').trigger('click');
    expect(chip(wrapper, 'ALL').attributes('aria-pressed')).toBe('false');
    expect(chip(wrapper, 'JOINS').attributes('aria-pressed')).toBe('true');
    await submit(wrapper);
    expect(sentRule()?.levels).toEqual(['JOINS', 'NOHIGHLIGHT']);
  });

  it('round-trips an ALL rule through edit', async () => {
    seedEntry({ levels: ['ALL'] });
    await wrapper.vm.$nextTick();
    await wrapper.find('.device .btn-bar button').trigger('click');
    expect(chip(wrapper, 'ALL').attributes('aria-pressed')).toBe('true');
    await submit(wrapper);
    expect(sentRule()?.levels).toEqual(['ALL']);
  });
});
