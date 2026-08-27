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
import { useDraftStore } from '../stores/drafts.js';
import { useComposerOverlay, selectNick, addressNick } from '../composables/useComposerOverlay.js';
import { useViewport } from '../composables/useViewport.js';
import { useSettingsStore } from '../stores/settings.js';
import { useScrollState } from '../composables/useScrollState.js';
import MessageInput from './MessageInput.vue';
import NickPicker from './NickPicker.vue';

// Module-level singleton shared by every consumer, so a test that flips it to
// mobile has to put it back (see the afterEach) or it leaks into the rest of
// the file.
const { isMobile } = useViewport();

// The composer sends typing state / drafts over the socket as you type. There's
// no socket in a test, and none of it is what we're exercising.
// socketSendWithAck carries the real signature rather than `() => null`: it
// returns a promise when the socket is open, and the tests that need a send to
// look like it landed have to be able to say so without cast-fighting the mock.
vi.mock('../composables/useSocket.js', () => ({
  socketSend: vi.fn<() => void>(),
  socketSendWithAck: vi.fn<() => Promise<AckResult> | null>(() => null),
  onSocketOpen: vi.fn<() => () => void>(() => () => {}),
}));

// The mocked socket senders, so the command-dispatch tests can assert the wire
// payload. Which one a command uses is not incidental: `sendOrToast` fires
// socketSend, while anything that wants delivery confirmation (`ackedSend`, and
// so every message-shaped command) goes through socketSendWithAck.
import { socketSend, socketSendWithAck, type AckResult } from '../composables/useSocket.js';

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
// input event the composer listens for — the same sequence a real keystroke
// produces.
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

// Open an IME composition. Everything typed after this and before the matching
// commit is one composing run: the DOM value still updates per keystroke, but
// Vue's v-model stops tracking it (vModelText bails on `el.composing`), so the
// model — and every suggester decision made from it — freezes at whatever the
// draft was when the composition opened. Android soft keyboards do this for
// every word; Firefox on Android is where it was first reported.
function composeStart(el: HTMLTextAreaElement) {
  el.dispatchEvent(new Event('compositionstart', { bubbles: true }));
}

// Close the composing run. Deliberately fires compositionend *alone*, with no
// trailing `input` — that's the case the composer's own compositionend listener
// exists to cover.
async function commitComposition(el: HTMLTextAreaElement) {
  el.dispatchEvent(new Event('compositionend', { bubbles: true }));
  await flush();
}

describe('MessageInput Tab-completion', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  afterEach(() => {
    for (const wrapper of mounted) wrapper.unmount();
    mounted = [];
    isMobile.value = false;
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

    // The addressing punctuation is a setting (#835). It stores the mark alone
    // and the space is always appended, so the four cases below are the four
    // code paths that seed a line-start session — picker, in-place Tab, strip,
    // Reply — each read through the one helper, and any of them could regress
    // back to the literal on its own.
    it('takes the addressing punctuation from the setting, across the cycle', async () => {
      seedStores('#zebra');
      useSettingsStore().values['input.completion.nick_suffix'] = ',';
      const { el } = await mountComposer();

      await type(el, '@al');
      await tab(el);
      expect(el.value).toBe('alexis, ');

      await tab(el);
      expect(el.value).toBe('alice, ');
    });

    it('addresses with a bare space when the punctuation setting is empty', async () => {
      // In-place Tab (no '@', no picker) is the path that appends nothing
      // mid-line, so it is the one most likely to be handed '' and drop the
      // space too.
      seedStores('#zebra');
      useSettingsStore().values['input.completion.nick_suffix'] = '';
      const { el } = await mountComposer();

      await type(el, 'al');
      await tab(el);
      expect(el.value).toBe('alexis ');
    });

    it('applies the setting to a strip pick at line start', async () => {
      seedStores('#zebra');
      useSettingsStore().values['input.completion.nick_suffix'] = ';';
      isMobile.value = true;
      const { el } = await mountComposer();

      await type(el, 'al');
      selectNick('alexis');
      await flush();
      expect(el.value).toBe('alexis; ');
    });

    it('applies the setting to Reply, and recognises an already-addressed draft', async () => {
      seedStores('#zebra');
      useSettingsStore().values['input.completion.nick_suffix'] = ',';
      const { el } = await mountComposer();

      await type(el, 'sure');
      addressNick('bob');
      await flush();
      expect(el.value).toBe('bob, sure');

      // Already addressed under THIS suffix — a second Reply must not stack a
      // second `bob, ` (the check compares against the configured form, not
      // the old literal).
      addressNick('bob');
      await flush();
      expect(el.value).toBe('bob, sure');
    });

    it('Reply recognises a draft addressed under another form', async () => {
      // The draft can predate a settings change, or come from a client with its
      // own form (iOS still writes `nick: `, and drafts sync) — any punctuation
      // after the nick counts, so this must not become `bob, bob: sure`.
      seedStores('#zebra');
      useSettingsStore().values['input.completion.nick_suffix'] = ',';
      const { el } = await mountComposer();

      await type(el, 'bob: sure');
      addressNick('bob');
      await flush();
      expect(el.value).toBe('bob: sure');
    });

    it('Reply still addresses a draft that merely opens with the nick as a word', async () => {
      // "will" is a nick and a word. Under any non-empty suffix the bare
      // `will ` form is NOT an address, so Reply prepends — the "already
      // addressed" check must demand punctuation, not just the nick.
      seedStores('#zebra');
      const { el } = await mountComposer();

      await type(el, 'will you come?');
      addressNick('will');
      await flush();
      expect(el.value).toBe('will: will you come?');
    });

    it('under an empty suffix, a draft opening with the nick already counts as addressed', async () => {
      // With "space only" the addressed form and the nick-as-a-word form are
      // the same text; that ambiguity is the convention's, and Reply follows
      // it rather than producing `bob bob is wrong`.
      seedStores('#zebra');
      useSettingsStore().values['input.completion.nick_suffix'] = '';
      const { el } = await mountComposer();

      await type(el, 'bob is wrong');
      addressNick('bob');
      await flush();
      expect(el.value).toBe('bob is wrong');
    });

    it('drops trailing whitespace typed into the setting instead of doubling it', async () => {
      // The description shows the form as `nick: `; typing exactly that into
      // the field is the natural mistake, and a quoted " " from /set is the
      // natural way to ask for "space only".
      seedStores('#zebra');
      useSettingsStore().values['input.completion.nick_suffix'] = ', ';
      const { el } = await mountComposer();

      await type(el, '@al');
      await tab(el);
      expect(el.value).toBe('alexis, ');

      useSettingsStore().values['input.completion.nick_suffix'] = ' ';
      await type(el, 'bo');
      await tab(el);
      expect(el.value).toBe('bob ');
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

  // A mobile keyboard types a whole word inside one IME composition, and
  // v-model deliberately drops every input event for its duration — so the
  // model, and everything derived from it, used to freeze until the word was
  // committed. The suggester was the reported symptom (the nick strip never
  // opened; an open `@` picker sat on its unfiltered first page until the
  // keyboard was dismissed), but the Send button, submit(), the typing
  // indicator and the draft sync were all stalled on the same stale model.
  //
  // Note none of these press Enter to accept: a soft-keyboard Enter arrives
  // with `isComposing === true`, which every suggester key handler is gated
  // against on purpose (the IME owns those keys while composing). The real
  // mobile accept path is a tap on a row, which is what these drive.
  describe('IME composition', () => {
    it('keeps the model tracking the textarea', async () => {
      // The root fix. Everything below is a consequence of this holding.
      seedStores('#zebra');
      const { el } = await mountComposer();
      const drafts = useDraftStore();

      composeStart(el);
      await type(el, 'hi');

      expect(drafts.forBuffer(1, '#zebra')).toBe('hi');
    });

    it('leaves the Send button usable during the first composed word', async () => {
      // hasComposerContent reads the model, so a frozen model meant a one-word
      // message could not be sent at all: Send stayed disabled and the
      // soft-keyboard Enter is ignored while composing.
      seedStores('#zebra');
      const { wrapper, el } = await mountComposer();

      composeStart(el);
      await type(el, 'hi');

      expect(wrapper.find('.send-btn').attributes('disabled')).toBeUndefined();
    });

    it('filters the @ picker while a composition is in flight', async () => {
      seedStores('#zebra');
      const { wrapper, el } = await mountComposer();

      // '@' commits on its own — punctuation ends the composing run — so the
      // picker opens here, unfiltered.
      await type(el, '@');
      // …and the nick itself is composed, invisible to v-model.
      composeStart(el);
      await type(el, '@b');

      // The query the picker filters on. Frozen, it stayed '' and the list went
      // on offering the whole channel.
      expect(wrapper.findComponent(NickPicker).props('query')).toBe('b');
    });

    it('opens the mobile nick strip while a composition is in flight', async () => {
      // The strip is the mobile-only path and never opened at all: it is driven
      // purely by refreshPicker, which only ran when the model moved.
      seedStores('#zebra');
      isMobile.value = true;
      const { el } = await mountComposer();
      const overlay = useComposerOverlay();

      composeStart(el);
      await type(el, 'bo');

      expect(overlay.nickOpen).toBe(true);
      expect(overlay.nickItems.map((i) => i.nick)).toEqual(['bob']);
    });

    it('writes a tapped pick through to the textarea mid-composition', async () => {
      // v-model skips its DOM write as hard as its model read while composing,
      // so the splice landed in the model and never appeared on screen — the
      // pre-fix run left the typed '@b' sitting there untouched.
      seedStores('#zebra');
      isMobile.value = true;
      const { el } = await mountComposer();
      const drafts = useDraftStore();

      composeStart(el);
      await type(el, 'hey bo');
      // What tapping a chip on the strip does.
      selectNick('bob');
      await flush();

      expect(el.value).toBe('hey bob ');
      expect(drafts.forBuffer(1, '#zebra')).toBe('hey bob ');
    });

    it('clears the textarea when a message is sent mid-composition', async () => {
      // This PR leaves Send enabled during the first composed word, so the
      // post-send clear has to actually repaint. It used to land in the model
      // only: the sent text stayed on screen, and the next composed keystroke
      // adopted it as the draft again — the message reappearing in the
      // composer after being sent.
      seedStores('#zebra');
      const { wrapper, el } = await mountComposer();
      const drafts = useDraftStore();
      // Once, so the file-wide `() => null` default is back for the next test.
      vi.mocked(socketSendWithAck).mockReturnValueOnce(Promise.resolve({ ok: true }) as never);

      composeStart(el);
      await type(el, 'hi');
      await wrapper.find('.send-btn').trigger('click');
      await flush();

      expect(el.value).toBe('');
      // …and the composition carries on into an empty composer rather than
      // resurrecting what was just sent.
      await type(el, 'x');
      expect(drafts.forBuffer(1, '#zebra')).toBe('x');
    });

    it('does not leak a composed draft into the next buffer on a switch', async () => {
      // The nastiest version: the textarea kept showing the old buffer's text
      // after the switch, and the next composed keystroke wrote it over the
      // buffer we had just moved to — silently destroying that draft.
      seedStores('#zebra');
      const networks = useNetworksStore();
      const drafts = useDraftStore();
      const { el } = await mountComposer();
      drafts.drafts['1::#apple'] = 'apple draft';

      composeStart(el);
      await type(el, 'zebra text');

      networks.activeKey = '1::#apple';
      await flush();

      expect(el.value).toBe('apple draft');
      expect(drafts.forBuffer(1, '#apple')).toBe('apple draft');
      expect(drafts.forBuffer(1, '#zebra')).toBe('zebra text');
    });

    it('keeps tracking after the composition commits', async () => {
      // The commit path: the IME replaces its preedit and fires compositionend.
      // The input events on either side are what normally carry the text, so
      // the commit itself should be a non-event — nothing here changes.
      seedStores('#zebra');
      const { el } = await mountComposer();
      const drafts = useDraftStore();

      composeStart(el);
      await type(el, 'hi');
      await commitComposition(el);

      expect(drafts.forBuffer(1, '#zebra')).toBe('hi');

      await type(el, 'hi there');
      expect(drafts.forBuffer(1, '#zebra')).toBe('hi there');
    });

    it('resyncs on compositionend when the commit fires no input event', async () => {
      // The backstop. v-model used to re-dispatch a synthetic `input` on
      // compositionend; binding :value + @input dropped that, so a commit (or
      // cancel) that rewrites the field without a trailing `input` — engines
      // disagree on whether one is owed — would strand the model on the preedit
      // with nothing left to resync it, and the next Send would ship it.
      seedStores('#zebra');
      const { el } = await mountComposer();
      const drafts = useDraftStore();

      composeStart(el);
      await type(el, 'ami');
      // The IME swaps its preedit for the committed text and fires *only*
      // compositionend.
      el.value = 'amiantos';
      await commitComposition(el);

      expect(drafts.forBuffer(1, '#zebra')).toBe('amiantos');
    });

    it('keeps tracking after a pick, without waiting for the composition to end', async () => {
      // The splice does not forge a compositionend, so v-model stays parked on
      // its stale `composing` flag. Our own listener is what has to keep the
      // model moving afterwards.
      seedStores('#zebra');
      isMobile.value = true;
      const { el } = await mountComposer();
      const drafts = useDraftStore();

      composeStart(el);
      await type(el, 'hey bo');
      selectNick('bob');
      await flush();

      await type(el, 'hey bob !');

      expect(drafts.forBuffer(1, '#zebra')).toBe('hey bob !');
    });

    it('drops a remote draft update aimed at the buffer being composed into', async () => {
      // Dropping v-model also dropped its beforeUpdate write-guard, so a
      // draft-updated fan-out from another device could repaint the focused
      // textarea under a live preedit — the store's composing mark is the
      // replacement guard, and it must hold even though `pending` would have
      // been disarmed by the debounce flush by then.
      seedStores('#zebra');
      const { el } = await mountComposer();
      const drafts = useDraftStore();
      drafts.resetTimers(); // clear any composing mark leaked by earlier tests

      composeStart(el);
      await type(el, 'hei');
      drafts.applyRemoteUpdate(1, '#zebra', 'clobber from another device');
      expect(drafts.forBuffer(1, '#zebra')).toBe('hei');

      // Commit + flush, and remote updates land again — the guard is scoped to
      // the composition, not sticky.
      await commitComposition(el);
      drafts.flushBuffer(1, '#zebra');
      drafts.applyRemoteUpdate(1, '#zebra', 'now it lands');
      expect(drafts.forBuffer(1, '#zebra')).toBe('now it lands');
    });

    it('defers the debounced draft flush until the composition ends', async () => {
      // A >500ms mid-word pause used to ship raw phonetic preedit as the
      // durable cross-device draft (and disarm `pending` with it). The flush
      // must wait for compositionend; the committed text then flushes normally.
      //
      // Mount and helpers run under REAL timers — flush() awaits a setTimeout,
      // which would hang forever under fake ones (and a timed-out test never
      // reaches its finally, leaking frozen timers into every later test). The
      // fake-timer window below contains only synchronous dispatches.
      seedStores('#zebra');
      const { el } = await mountComposer();
      const drafts = useDraftStore();
      drafts.resetTimers();
      vi.mocked(socketSend).mockClear();
      vi.useFakeTimers();
      try {
        el.dispatchEvent(new Event('compositionstart', { bubbles: true }));
        el.value = 'nihongo';
        el.setSelectionRange(7, 7);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        vi.advanceTimersByTime(5000);
        const draftSets = () =>
          vi.mocked(socketSend).mock.calls.filter(([m]) => (m as any)?.type === 'draft-set');
        expect(draftSets()).toHaveLength(0);

        el.dispatchEvent(new Event('compositionend', { bubbles: true }));
        vi.advanceTimersByTime(5000);
        expect(draftSets()).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('ignores the Enter that confirms a composition on Safari (keyCode 229)', async () => {
      // Safari fires compositionend first, THEN the confirming Enter's keydown
      // with isComposing already false but keyCode still 229 — the keydown
      // gate has to catch it or committing a word sends the message.
      seedStores('#zebra');
      const { el } = await mountComposer();
      useDraftStore().resetTimers();
      vi.mocked(socketSendWithAck).mockClear();
      await type(el, 'sent by mistake');

      const enter229 = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
      Object.defineProperty(enter229, 'keyCode', { value: 229 });
      el.dispatchEvent(enter229);
      await flush();

      expect(socketSendWithAck).not.toHaveBeenCalled();
      expect(useDraftStore().forBuffer(1, '#zebra')).toBe('sent by mistake');
    });

    it('keeps Cmd+B from splicing formatting codes under a live preedit', async () => {
      // One of the two branches the scattered per-branch gates had missed —
      // now covered by the single composition gate at the top of onKeydown.
      seedStores('#zebra');
      const { el } = await mountComposer();
      useDraftStore().resetTimers();

      composeStart(el);
      await type(el, 'bo');
      const cmdB = new KeyboardEvent('keydown', { key: 'b', metaKey: true, bubbles: true });
      Object.defineProperty(cmdB, 'isComposing', { value: true });
      el.dispatchEvent(cmdB);
      await flush();

      expect(el.value.includes('\u0002')).toBe(false); // \u0002 = mIRC bold
      expect(useDraftStore().forBuffer(1, '#zebra')).toBe('bo');
      await commitComposition(el);
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
    vi.mocked(socketSendWithAck).mockClear();
    // sendOrToast reads the return value to decide whether to toast a failure; a
    // real open socket returns true, so make the mock say the send landed.
    vi.mocked(socketSend).mockReturnValue(true as never);
    // ackedSend treats a null return as "socket closed" and bails before the
    // payload matters, so hand it a resolved ack.
    vi.mocked(socketSendWithAck).mockReturnValue(Promise.resolve({ ok: true }) as never);
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

  // #809 QA. The clear is optimistic — commitInput runs before the ACK — so a send
  // that comes back not-connected used to leave the composer empty with nothing
  // but a toast and up-arrow. Fine while a failed send was a rarity; the
  // writable-connection gate makes it the ordinary outcome of any outage.
  describe('a failed send comes back to the composer', () => {
    async function failingSend(input: string) {
      seedStores('#zebra');
      vi.mocked(socketSendWithAck).mockReturnValue(
        Promise.resolve({ ok: false, error: 'not-connected' }) as never,
      );
      const drafts = useDraftStore();
      const { el } = await mountComposer();
      await type(el, input);
      await enter(el);
      await flush();
      return drafts;
    }

    it('restores a plain message as the buffer draft', async () => {
      const drafts = await failingSend('hello there');
      expect(drafts.forBuffer(1, '#zebra')).toBe('hello there');
    });

    it('restores the whole typed line for a command, not just its body', async () => {
      // ⚠ `/me waves` and not `waves` — what comes back has to be re-sendable.
      const drafts = await failingSend('/me waves');
      expect(drafts.forBuffer(1, '#zebra')).toBe('/me waves');
    });

    it('restores a /notice to the buffer it was TYPED IN, not to its target', async () => {
      const drafts = await failingSend('/notice bob psst');
      expect(drafts.forBuffer(1, '#zebra')).toBe('/notice bob psst');
      expect(drafts.forBuffer(1, 'bob')).toBe('');
    });

    // ⚠⚠ The rule that keeps this from being a regression of its own: the ACK is
    // late, so the user may already be typing something else. Theirs wins.
    it('never clobbers text typed while the ACK was in flight', async () => {
      seedStores('#zebra');
      let settle: (r: { ok: boolean; error: string }) => void = () => {};
      vi.mocked(socketSendWithAck).mockReturnValue(
        new Promise((r) => {
          settle = r as typeof settle;
        }) as never,
      );
      const drafts = useDraftStore();
      const { el } = await mountComposer();
      await type(el, 'first');
      await enter(el);
      await type(el, 'second thoughts');
      settle({ ok: false, error: 'not-connected' });
      await flush();
      expect(drafts.forBuffer(1, '#zebra')).toBe('second thoughts');
    });
  });

  // #785. `/disconnect` is the word people reach for when a network is stuck in a reconnect
  // loop, and it used to fall through to the raw-line default — so it went out as an unknown
  // IRC verb, and during a backoff nowhere at all. It shares /quit's branch: both route through
  // the intentional-disconnect path, which is what sets irc-framework's requested_disconnect
  // flag so the close doesn't look unexpected and trigger another auto-reconnect.
  it.each([
    ['/quit', undefined],
    ['/disconnect', undefined],
    ['/disconnect back later', 'back later'],
  ])('%s stops the network instead of going out as a raw line', async (input, reason) => {
    seedStores('#zebra');
    const networks = useNetworksStore();
    const disconnect = vi
      .spyOn(networks, 'disconnect')
      .mockResolvedValue(undefined as unknown as void);
    const { el } = await mountComposer();

    await type(el, input);
    await enter(el);

    expect(disconnect).toHaveBeenCalledWith(1, reason);
    // ⚠ And emphatically not as a raw line — that is the shape of the bug.
    expect(socketSend).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'raw' }));
  });

  it('reports a failed /disconnect in the buffer rather than swallowing it', async () => {
    // The one branch the happy-path cases can't reach. It matters here more than for most
    // commands: the whole point of #785 is a user trying to stop a network that won't stop, so
    // "nothing happened" is precisely the wrong feedback if the call fails.
    seedStores('#zebra');
    const networks = useNetworksStore();
    vi.spyOn(networks, 'disconnect').mockRejectedValue(new Error('network is paused'));
    const buffers = useBuffersStore();
    const pushMessage = vi.spyOn(buffers, 'pushMessage');
    const { el } = await mountComposer();

    await type(el, '/disconnect');
    await enter(el);
    await flush();

    expect(pushMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: '/disconnect failed: network is paused' }),
    );
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

  // #652: `||spoiler||` was rewritten on the plain-send path only, so the same input produced a
  // click-to-reveal box when typed and literal pipes when sent through a command. Silent and
  // non-recoverable — the spoiler is on the wire before the user can see it didn't work.
  describe('||spoiler|| markup in commands (#652)', () => {
    const OPEN = '\x0314,14';
    const CLOSE = '\x03';

    it('/me rewrites the spoiler in the ACTION body', async () => {
      seedStores('#zebra');
      const { el } = await mountComposer();

      await type(el, '/me says ||surprise||');
      await enter(el);

      expect(socketSendWithAck).toHaveBeenCalledWith({
        type: 'action',
        networkId: 1,
        target: '#zebra',
        text: `says ${OPEN}surprise${CLOSE}`,
      });
    });

    it('/msg rewrites the spoiler, and never the recipient', async () => {
      seedStores('#zebra');
      const { el } = await mountComposer();

      await type(el, '/msg bob ||surprise||');
      await enter(el);

      expect(socketSendWithAck).toHaveBeenCalledWith({
        type: 'send',
        networkId: 1,
        target: 'bob',
        text: `${OPEN}surprise${CLOSE}`,
      });
    });

    it('/notice rewrites the spoiler in the NOTICE body', async () => {
      seedStores('#zebra');
      const { el } = await mountComposer();

      await type(el, '/notice bob ||surprise||');
      await enter(el);

      expect(socketSendWithAck).toHaveBeenCalledWith({
        type: 'notice',
        networkId: 1,
        target: 'bob',
        text: `${OPEN}surprise${CLOSE}`,
      });
    });

    it('/shrug rewrites the spoiler and keeps the kaomoji', async () => {
      seedStores('#zebra');
      const { el } = await mountComposer();

      await type(el, '/shrug ||surprise||');
      await enter(el);

      expect(socketSendWithAck).toHaveBeenCalledWith({
        type: 'send',
        networkId: 1,
        target: '#zebra',
        text: `${OPEN}surprise${CLOSE} ¯\\_(ツ)_/¯`,
      });
    });

    // ⚠⚠ The reason the rewrite is opt-in per command rather than folded into ackedSend /
    // sendOrToast. These route a raw PRIVMSG to a service, and the body is usually
    // `identify <password>` — rewriting bytes headed for an auth handshake is a bug.
    it('/ns and /cs send their body VERBATIM', async () => {
      seedStores('#zebra');
      const { el } = await mountComposer();

      await type(el, '/ns identify hunter||2||');
      await enter(el);
      expect(socketSend).toHaveBeenCalledWith({
        type: 'raw',
        networkId: 1,
        line: 'PRIVMSG NickServ :identify hunter||2||',
      });

      await type(el, '/cs op #zebra ||x||');
      await enter(el);
      expect(socketSend).toHaveBeenCalledWith({
        type: 'raw',
        networkId: 1,
        line: 'PRIVMSG ChanServ :op #zebra ||x||',
      });
    });

    // The split estimator drives the outgoing-flood GATE, not just the indicator — a body it
    // counts as >1 chunk is held back for split confirmation instead of being sent. So bytes it
    // counts that the send path never puts on the wire can stall a message that would have gone
    // out fine.
    //
    // 150 single-letter words at MESSAGE_MAX_BYTES 350: the send path collapses the separators
    // and puts 299 bytes on the wire (one chunk), while slicing at the first space preserved the
    // doubled runs for 448 (two chunks) — enough to trip the gate on a message that fits.
    it('does not stall a /msg whose extra bytes are whitespace the send path collapses', async () => {
      seedStores('#zebra');
      const { el } = await mountComposer();

      const body = Array.from({ length: 150 }, () => 'a').join('  ');
      await type(el, `/msg bob ${body}`);
      await enter(el);

      expect(socketSendWithAck).toHaveBeenCalledWith({
        type: 'send',
        networkId: 1,
        target: 'bob',
        text: Array.from({ length: 150 }, () => 'a').join(' '),
      });
    });

    // The same collapsing, shown directly on a short body.
    //
    // ⚠ The expected text keeps its TRAILING SPACE, and that is not a typo. `/\s+/` on a string
    // ending in whitespace yields a final empty element, which `join(' ')` turns back into one
    // space. Asserting the tidy form here would be asserting something the composer doesn't send,
    // and the estimator's job is to match the payload byte-for-byte, not to improve it.
    it('counts a /msg body the way the send path builds it', async () => {
      seedStores('#zebra');
      const { el } = await mountComposer();

      await type(el, '/msg bob   hello   world  ');
      await enter(el);

      expect(socketSendWithAck).toHaveBeenCalledWith({
        type: 'send',
        networkId: 1,
        target: 'bob',
        text: 'hello world ',
      });
    });

    // A command with no `||` must be byte-identical to what it was before.
    it('leaves a body without spoiler markup untouched', async () => {
      seedStores('#zebra');
      const { el } = await mountComposer();

      await type(el, '/me waves');
      await enter(el);

      expect(socketSendWithAck).toHaveBeenCalledWith({
        type: 'action',
        networkId: 1,
        target: '#zebra',
        text: 'waves',
      });
    });
  });

  // ⚠ Find the RAW call by its verb rather than taking the last one: the composer also fires
  // typing/draft sends around a submit, so `.at(-1)` is whichever of those landed last.
  const rawLine = (verb: string): string | undefined =>
    vi
      .mocked(socketSend)
      .mock.calls.map(([p]) => p as { type?: string; line?: string })
      .filter((p) => p?.type === 'raw' && p.line?.startsWith(verb))
      .at(-1)?.line;

  // #724: commands whose first argument may be free text can't use the plain prefix test. `#`
  // never starts a sentence, but `+` and `!` do — so the other three prefixes only address a
  // channel when one by that name is actually open.
  describe('channel-vs-free-text arguments (#724)', () => {
    it('/part &local parts that channel when it exists', async () => {
      const { buffers } = seedStores('#zebra');
      buffers.buffers['1::&local'] = {
        networkId: 1,
        target: '&local',
        members: [],
        messages: [],
      } as never;
      const { el } = await mountComposer();

      await type(el, '/part &local');
      await enter(el);

      expect(socketSend).toHaveBeenCalledWith({
        type: 'part',
        networkId: 1,
        channel: '&local',
        reason: '',
      });
    });

    it('/part +brb leaves the CURRENT channel with that reason', async () => {
      // No `+brb` buffer exists, so the argument is prose. Reading it as a channel would part a
      // channel that isn't there and silently leave the user where they were.
      seedStores('#zebra');
      const { el } = await mountComposer();

      await type(el, '/part +brb');
      await enter(el);

      expect(socketSend).toHaveBeenCalledWith({
        type: 'part',
        networkId: 1,
        channel: '#zebra',
        reason: '+brb',
      });
    });

    it('/topic !!! maintenance !!! sets the current channel topic', async () => {
      seedStores('#zebra');
      const { el } = await mountComposer();

      await type(el, '/topic !!! maintenance !!!');
      await enter(el);

      expect(rawLine('TOPIC')).toBe('TOPIC #zebra :!!! maintenance !!!');
    });

    it('/mode +local +m targets the channel, not the current buffer flags', async () => {
      // `+local` satisfies the leading-sign flag heuristic AND is a channel name. With an open
      // buffer by that name the channel reading wins; without one it is flags (next case).
      const { buffers } = seedStores('#zebra');
      buffers.buffers['1::+local'] = {
        networkId: 1,
        target: '+local',
        members: [],
        messages: [],
      } as never;
      const { el } = await mountComposer();

      await type(el, '/mode +local +m');
      await enter(el);

      expect(rawLine('MODE')).toBe('MODE +local +m');
    });

    it('/mode +m still applies flags to the current channel', async () => {
      // The positive control: no buffer is ever named `+m`, so real flags keep working.
      seedStores('#zebra');
      const { el } = await mountComposer();

      await type(el, '/mode +m');
      await enter(el);

      expect(rawLine('MODE')).toBe('MODE #zebra +m');
    });

    it('/kick &local bob still takes the channel-first form', async () => {
      // Unambiguous by shape: /kick's first argument is a nick or a channel, never prose, so it
      // uses the plain prefix test and needs no open buffer.
      seedStores('#zebra');
      const { el } = await mountComposer();

      await type(el, '/kick &local bob rude');
      await enter(el);

      expect(rawLine('KICK')).toBe('KICK &local bob :rude');
    });
  });

  // #412. Worth real coverage rather than trusting the switch: an unknown command
  // falls through to `default:`, which ships it as a RAW IRC line — so before this
  // existed, `/p cya` didn't fail loudly, it sent the server a bogus `p cya`.
  it('/p is an alias for /part, reason parsing and all', async () => {
    seedStores('#zebra');
    const { el } = await mountComposer();

    await type(el, '/p heading out');
    await enter(el);

    expect(socketSend).toHaveBeenCalledWith({
      type: 'part',
      networkId: 1,
      channel: '#zebra',
      reason: 'heading out',
    });
  });

  // The reason is sliced with `line.slice(1 + cmd.length)`, so a shorter alias
  // would silently eat or keep the wrong characters if that were hardcoded.
  it('/p <#chan> [reason] retargets like /part does', async () => {
    seedStores('#zebra');
    const { el } = await mountComposer();

    await type(el, '/p #mango cya');
    await enter(el);

    expect(socketSend).toHaveBeenCalledWith({
      type: 'part',
      networkId: 1,
      channel: '#mango',
      reason: 'cya',
    });
  });

  // A channel NOT in the seeded set: joinOrActivate short-circuits to a plain
  // activate() for a buffer that's already open and joined, so asserting the
  // JOIN went out needs a channel the user isn't in.
  it('/j is an alias for /join', async () => {
    seedStores('#zebra');
    const { el } = await mountComposer();

    await type(el, '/j #brandnew');
    await enter(el);

    expect(socketSend).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'join', networkId: 1, channel: '#brandnew' }),
    );
  });

  it('/j applies the same #-prefix normalization as /join', async () => {
    seedStores('#zebra');
    const { el } = await mountComposer();

    await type(el, '/j brandnew');
    await enter(el);

    expect(socketSend).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'join', channel: '#brandnew' }),
    );
  });

  // #532. A plain message, not an ACTION — /shrug SAYS the kaomoji.
  it('/shrug says the kaomoji after your text', async () => {
    seedStores('#zebra');
    const { el } = await mountComposer();

    await type(el, '/shrug no idea');
    await enter(el);

    expect(socketSendWithAck).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'send',
        networkId: 1,
        target: '#zebra',
        text: 'no idea ¯\\_(ツ)_/¯',
      }),
    );
  });

  // /shrug produces a real PRIVMSG body, so it has to face the same split gate a
  // plain message does. Without teaching bodyForSplit about it, the estimator
  // reported 0 chunks and the identical text went straight out unconfirmed just
  // because it was typed behind a slash command.
  it('gates a long /shrug behind the split confirmation, like plain text', async () => {
    seedStores('#zebra');
    const { el } = await mountComposer();

    await type(el, `/shrug ${'x'.repeat(900)}`);
    await enter(el);
    expect(socketSendWithAck).not.toHaveBeenCalled();

    // Send again to confirm — the gate is a confirmation, not a refusal.
    await enter(el);
    expect(socketSendWithAck).toHaveBeenCalledTimes(1);
  });

  it('a bare /shrug sends the kaomoji alone, with no leading space', async () => {
    seedStores('#zebra');
    const { el } = await mountComposer();

    await type(el, '/shrug');
    await enter(el);

    expect(socketSendWithAck).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'send', text: '¯\\_(ツ)_/¯' }),
    );
  });
});

// Where the composer leaves the viewport after a send (#628). Driven through
// real keystrokes for the same reason the completion tests are: the rule reads
// three sources — the setting, whether the draft is a message or a command, and
// whether the buffer is detached — and only submit() assembles all three.
//
// The observable is useScrollState's token rather than a spy on the composable:
// it's the same thing MessageList watches, so a test that passes here is
// asserting the signal the list actually acts on.
describe('scroll position on send (#628)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  afterEach(() => {
    for (const wrapper of mounted) wrapper.unmount();
    mounted = [];
    vi.mocked(socketSendWithAck).mockReturnValue(null);
  });

  async function enter(el: HTMLTextAreaElement) {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush();
  }

  function keepPosition(on: boolean) {
    useSettingsStore().values['chat.keep_position_on_send'] = on;
  }

  // submit() bails before commitInput when the ack send reports a closed
  // socket, and the shared mock returns null. Every message-shaped case needs
  // delivery to look like it happened.
  function allowSend() {
    vi.mocked(socketSendWithAck).mockReturnValue(Promise.resolve({ ok: true }));
  }

  const token = () => useScrollState().scrollToBottomToken.value;

  it('re-pins to the bottom by default', async () => {
    seedStores('#zebra');
    allowSend();
    const { el } = await mountComposer();

    await type(el, 'hello');
    const before = token();
    await enter(el);

    expect(token()).toBeGreaterThan(before);
  });

  it('leaves the viewport alone when the setting is on', async () => {
    seedStores('#zebra');
    keepPosition(true);
    allowSend();
    const { el } = await mountComposer();

    await type(el, 'hello');
    const before = token();
    await enter(el);

    expect(token()).toBe(before);
    // The send itself is unaffected — this is a scroll rule, not a send gate.
    expect(socketSendWithAck).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'send', text: 'hello' }),
    );
  });

  it('re-pins for a command even with the setting on', async () => {
    // /commands answers with 40-odd localInfo lines, and those rows are id-less
    // so the "N new ↓" badge never counts them. Keeping your place would put
    // the answer below the fold with nothing to say it arrived.
    seedStores('#zebra');
    keepPosition(true);
    const { el } = await mountComposer();

    await type(el, '/commands');
    const before = token();
    await enter(el);

    expect(token()).toBeGreaterThan(before);
  });

  // One case per shape of message-producing command, because the first cut of
  // this classified by parsing the verb and only knew the four that bodyForSplit
  // knows for split-gating — so /slap and /jitsi jumped to the bottom while /me
  // and /shrug stayed put. Now it's whether the command actually put something
  // on the wire, and these are the three ways that happens.
  it.each([
    ['/me waves', 'action'],
    ['/slap bob', 'action'],
    ['/jitsi', 'send'],
  ])('treats %s as the send it is, not a command', async (draft, wireType) => {
    seedStores('#zebra');
    keepPosition(true);
    allowSend();
    const { el } = await mountComposer();

    await type(el, draft);
    const before = token();
    await enter(el);

    expect(token()).toBe(before);
    // Positive control: without this, a command that never reached commitInput
    // would produce the same unchanged token and pass for the wrong reason.
    expect(socketSendWithAck).toHaveBeenCalledWith(expect.objectContaining({ type: wireType }));
  });

  it('rejoins live when the send came from a detached slice', async () => {
    // The message goes to the live tail, which a detached buffer holds out of
    // the log — so staying put, setting or no setting, would show a stretch of
    // history the message can never appear in.
    const { buffers } = seedStores('#zebra');
    buffers.buffers['1::#zebra'].detached = true;
    keepPosition(true);
    allowSend();
    const reattach = vi.spyOn(buffers, 'reattachToLive').mockReturnValue(true);
    const { el } = await mountComposer();

    await type(el, 'hello');
    const before = token();
    await enter(el);

    expect(reattach).toHaveBeenCalledWith(1, '#zebra');
    expect(token()).toBeGreaterThan(before);
  });

  it('does not rejoin live for a command run from a detached slice', async () => {
    // A command isn't a send: nothing of the user's went to the live tail, so
    // throwing away the history slice they deliberately jumped to would be a
    // change they never asked for — and this path is on by default.
    const { buffers } = seedStores('#zebra');
    buffers.buffers['1::#zebra'].detached = true;
    const reattach = vi.spyOn(buffers, 'reattachToLive').mockReturnValue(true);
    const { el } = await mountComposer();

    await type(el, '/commands');
    await enter(el);

    expect(reattach).not.toHaveBeenCalled();
  });

  it('stays put when the rejoin request could not go out', async () => {
    // reattachToLive returns false while another history page is in flight. The
    // buffer is still detached and the message still isn't loaded, so scrolling
    // would claim an arrival that hasn't happened; "Return ↓" stays the way back.
    const { buffers } = seedStores('#zebra');
    buffers.buffers['1::#zebra'].detached = true;
    allowSend();
    const reattach = vi.spyOn(buffers, 'reattachToLive').mockReturnValue(false);
    const { el } = await mountComposer();

    await type(el, 'hello');
    const before = token();
    await enter(el);

    expect(token()).toBe(before);
    // Positive control, as above: proves the send got as far as the detached
    // branch rather than falling out of submit() somewhere earlier.
    expect(reattach).toHaveBeenCalled();
  });
});
