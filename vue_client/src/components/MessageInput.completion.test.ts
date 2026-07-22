// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// Keystroke-level coverage of the composer's Tab-completion. This is the one
// corner of the client where the logic is genuinely intricate — three selection
// UIs (`@` picker, `#` picker, mobile strip), an in-place cycle, and a shared
// session that has to survive a commit — and all of it only runs in response to
// real key events, so a pure unit test of the candidate builders can't see it.
// Two shipped bugs hid in exactly that gap: a picker prop nothing bound, and a
// Tab cycle that dead-ended on the first match because the commit appended a
// space that terminated the token.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useRecentBuffersStore } from '../stores/recentBuffers.js';
import MessageInput from './MessageInput.vue';

// The composer sends typing state / drafts over the socket as you type. There's
// no socket in a test, and none of it is what we're exercising.
vi.mock('../composables/useSocket.js', () => ({
  socketSend: vi.fn<() => void>(),
  socketSendWithAck: vi.fn<() => null>(() => null),
  onSocketOpen: vi.fn<() => () => void>(() => () => {}),
}));

// The mocked socketSend, so the command-dispatch tests can assert the wire payload.
import { socketSend } from '../composables/useSocket.js';

const CHANNELS = ['#apple', '#mango', '#zebra'];
// `mallory` exists so the self-exclusion test has a positive control: without a
// second m-nick, "your own nick isn't offered" and "completion did nothing at
// all" produce identical text and the assertion can't tell them apart.
const MEMBERS = ['alice', 'alexis', 'bob', 'mallory', 'me'];

function seedStores(activeTarget = '#zebra', recent: string[] = []) {
  const networks = useNetworksStore();
  const buffers = useBuffersStore();
  const recentBuffers = useRecentBuffersStore();

  networks.networks = [{ id: 1, name: 'testnet' }] as never;
  networks.states = { 1: { nick: 'me' } } as never;

  for (const target of CHANNELS) {
    buffers.buffers[`1::${target}`] = {
      networkId: 1,
      target,
      members: MEMBERS.map((nick) => ({ nick, modes: [], away: false })),
      messages: [],
    } as never;
  }
  networks.activeKey = `1::${activeTarget}`;
  // The MRU trail the real store would have built from activeKey activations:
  // most-recent first, and the buffer you're in is always at the front.
  recentBuffers.keys = [`1::${activeTarget}`, ...recent.map((t) => `1::${t}`)];
  return { networks, buffers, recentBuffers };
}

// Mounted composers are torn down in afterEach: MessageInput's onMounted adds a
// window listener and registers itself with setComposerOverlayHandlers — module
// singletons — so a leaked mount would leave the *previous* test's composer
// wired to the overlay handlers.
let mounted: VueWrapper[] = [];

async function mountComposer() {
  const wrapper = mount(MessageInput, { attachTo: document.body });
  mounted.push(wrapper);
  await flush();
  const textarea = wrapper.find('textarea');
  expect(textarea.exists()).toBe(true);
  return { wrapper, textarea, el: textarea.element as HTMLTextAreaElement };
}

// Let Vue's render flush and applyCompletion's queueMicrotask (which parks the
// caret and records it on the session) run before the next keystroke.
async function flush() {
  await new Promise((r) => setTimeout(r, 0));
}

// Type `value` into the composer: set it, put the caret at the end, and fire the
// input event v-model listens for — the same sequence a real keystroke produces.
async function type(el: HTMLTextAreaElement, value: string) {
  el.value = value;
  el.setSelectionRange(value.length, value.length);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  await flush();
}

async function tab(el: HTMLTextAreaElement, opts: { shift?: boolean } = {}) {
  el.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Tab', shiftKey: !!opts.shift, bubbles: true }),
  );
  await flush();
}

describe('MessageInput Tab-completion', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  afterEach(() => {
    for (const wrapper of mounted) wrapper.unmount();
    mounted = [];
  });

  describe('channels', () => {
    it('offers the channel you are in first, not the alphabetical first', async () => {
      seedStores('#zebra');
      const { el } = await mountComposer();

      await type(el, '#');
      await tab(el);

      // Alphabetically #apple would lead; recency puts the buffer you're in first.
      expect(el.value).toBe('#zebra ');
    });

    it('cycles through the candidates on repeat Tab', async () => {
      // The bug this whole file exists for: the commit appends a trailing space,
      // so a second Tab found no token under the caret and dead-ended here.
      seedStores('#zebra');
      const { el } = await mountComposer();

      await type(el, '#');
      await tab(el);
      expect(el.value).toBe('#zebra ');

      await tab(el);
      expect(el.value).toBe('#apple ');

      await tab(el);
      expect(el.value).toBe('#mango ');

      // …and wraps.
      await tab(el);
      expect(el.value).toBe('#zebra ');
    });

    it('walks backwards on Shift+Tab', async () => {
      seedStores('#zebra');
      const { el } = await mountComposer();

      await type(el, '#');
      await tab(el);
      await tab(el, { shift: true });

      expect(el.value).toBe('#mango ');
    });

    it('orders the cycle by recency, then alphabetically', async () => {
      // In #zebra, was just in #mango; #apple is unvisited this session.
      seedStores('#zebra', ['#mango']);
      const { el } = await mountComposer();

      await type(el, '#');
      await tab(el);
      expect(el.value).toBe('#zebra ');
      await tab(el);
      expect(el.value).toBe('#mango ');
      await tab(el);
      expect(el.value).toBe('#apple ');
    });

    it('completes mid-sentence without disturbing the surrounding text', async () => {
      seedStores('#zebra');
      const { el } = await mountComposer();

      await type(el, 'join #a');
      await tab(el);

      expect(el.value).toBe('join #apple ');
      // Cycling replaces only the completed token — #apple is the sole match for
      // the "#a" prefix, so it stays put rather than walking into #mango.
      await tab(el);
      expect(el.value).toBe('join #apple ');
    });
  });

  describe('nicks', () => {
    it('cycles nicks picked through the @ picker', async () => {
      seedStores('#zebra');
      const { el } = await mountComposer();

      await type(el, 'hey @al');
      await tab(el);
      expect(el.value).toBe('hey alexis ');

      await tab(el);
      expect(el.value).toBe('hey alice ');
    });

    it('keeps the addressing colon across a cycle at line start', async () => {
      // A nick at line start is being addressed, so it gets ': ' — and every Tab
      // in the cycle has to keep reproducing it. The suffix rides on the session
      // for exactly this reason; re-deriving it per cycle dropped it.
      seedStores('#zebra');
      const { el } = await mountComposer();

      await type(el, '@al');
      await tab(el);
      expect(el.value).toBe('alexis: ');

      await tab(el);
      expect(el.value).toBe('alice: ');
    });

    it('never offers your own nick', async () => {
      // Both m-nicks match "@m"; only mallory may be offered. The positive half
      // of this assertion matters as much as the negative one — with `me` as the
      // sole m-nick, "self was correctly skipped" and "completion did nothing"
      // would leave identical text.
      seedStores('#zebra');
      const { el } = await mountComposer();

      await type(el, '@m');
      await tab(el);

      expect(el.value).toBe('mallory: ');
    });

    it('completes an @-token in place once the picker is dismissed', async () => {
      // The picker owns Tab only while it's open. Escape closes it, and Tab then
      // falls through to in-place completion — which used to match nothing,
      // because it stripped the '#' sigil off channels but left the '@' on
      // nicks, then asked for nicks beginning with '@'.
      seedStores('#zebra');
      const { el } = await mountComposer();

      await type(el, 'hey @al');
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await flush();

      await tab(el);
      expect(el.value).toBe('hey alexis');
    });
  });

  describe('session staleness', () => {
    it('does not rewrite the wrong span after the caret moves', async () => {
      // A click or tap inside the textarea moves the caret with no keydown to
      // reset the session. Applying it then would splice the pick in at the old
      // prefix/tail offsets, mangling the text.
      seedStores('#zebra');
      const { el } = await mountComposer();

      await type(el, '#');
      await tab(el);
      expect(el.value).toBe('#zebra ');

      // Caret jumps to the very start, as if clicked there. There's no token
      // under it, so Tab has nothing to complete and must leave the text alone.
      el.setSelectionRange(0, 0);
      await tab(el);

      expect(el.value).toBe('#zebra ');
    });
  });
});

// The command dispatcher (handleCommand) had no coverage; this locks the /part
// parsing the PR changed. `/part [reason]` must leave the CURRENT channel with
// that reason (not read the first word as a channel), and a leading #chan must
// still retarget.
describe('MessageInput command dispatch', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(socketSend).mockClear();
    // sendOrToast reads the return value to decide whether to toast a failure; a
    // real open socket returns true, so make the mock say the send landed.
    vi.mocked(socketSend).mockReturnValue(true as never);
  });

  afterEach(() => {
    for (const wrapper of mounted) wrapper.unmount();
    mounted = [];
  });

  // Press Enter to submit, then let submit()'s async body reach socketSend.
  async function enter(el: HTMLTextAreaElement) {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush();
  }

  it('/part [reason] leaves the current channel with that reason', async () => {
    seedStores('#zebra');
    const { el } = await mountComposer();

    await type(el, '/part heading out');
    await enter(el);

    expect(socketSend).toHaveBeenCalledWith({
      type: 'part',
      networkId: 1,
      channel: '#zebra',
      reason: 'heading out',
    });
  });

  it('/part <#chan> [reason] retargets the named channel', async () => {
    seedStores('#zebra');
    const { el } = await mountComposer();

    await type(el, '/part #mango cya');
    await enter(el);

    expect(socketSend).toHaveBeenCalledWith({
      type: 'part',
      networkId: 1,
      channel: '#mango',
      reason: 'cya',
    });
  });

  it('a bare /part leaves the current channel with no reason', async () => {
    seedStores('#zebra');
    const { el } = await mountComposer();

    await type(el, '/part');
    await enter(el);

    expect(socketSend).toHaveBeenCalledWith({
      type: 'part',
      networkId: 1,
      channel: '#zebra',
      reason: '',
    });
  });
});
