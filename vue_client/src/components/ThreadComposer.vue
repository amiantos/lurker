<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<!--
  The thread panel's own composer (#1225), in the main composer's clothes: the
  same row, padding and bare textarea, so the two line up at the bottom of the
  window. Every line sent from here is a reply in the thread, to the newest
  reply from someone else (threads.replyTarget). Plain on purpose — Enter
  sends, Tab completes nicks from the channel's members with the completion
  suffix the channel uses. A pasted file uploads, and its URL lands here, not
  in the channel's draft; with no status row in the panel, the send button
  turns into a spinner while it goes up, and a failure is a toast. No upload
  button, emoji picker, drafts or slash commands: the channel's composer has
  those, and a /command typed here is refused rather than sent as text.

  One line per send: a send the network would split into several PRIVMSGs
  carries its reply tag on the first only, and the rest would land in the
  channel outside the thread (ircManager.send) — so such a send is refused.
  A network with draft/multiline takes a whole batch under one tag.

  The `nick: ` address goes on at send, as the channel's Reply puts it in the
  draft: it is what a client without reply tags sees. Never for your own line
  or in a DM (privateTarget), and the panel strips it on display.
-->

<template>
  <div class="thread-input">
    <textarea
      ref="inputEl"
      v-model="text"
      rows="1"
      :placeholder="placeholder"
      :disabled="!canSend"
      :aria-label="placeholder"
      @keydown="onKeydown"
      @input="onInput"
      @paste="onPaste"
      @compositionstart="onCompositionStart"
      @compositionend="onCompositionEnd"
    />
    <span
      v-if="uploading"
      class="send-btn uploading"
      role="status"
      :title="uploadLabel"
      :aria-label="uploadLabel"
    >
      <LoaderCircleIcon class="icon-spin" />
    </span>
    <button
      v-else
      type="button"
      class="send-btn"
      :disabled="!canSend || !text.trim()"
      title="send reply"
      aria-label="send reply"
      @mousedown.prevent
      @click="submit"
    >
      <CircleArrowUpIcon />
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { CircleArrowUpIcon, LoaderCircleIcon } from '@lucide/vue';
import { threadKey, useThreadsStore } from '../stores/threads.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useNetworksStore } from '../stores/networks.js';
import { useSettingsStore } from '../stores/settings.js';
import { useToastsStore } from '../stores/toasts.js';
import { useUploadsStore } from '../stores/uploads.js';
import { pastedUploadFile } from '../utils/uploaders.js';
import { insertWithPadding } from '../utils/insertAtCaret.js';
import { socketSendWithAck } from '../composables/useSocket.js';
import { privateTarget, replyTagsGoOut } from '../composables/useMessageActions.js';
import { isImeKey } from '../composables/useImeSafeInput.js';
import { applySpoilerMarkup } from '../utils/spoilerMarkup.js';
import { chunkCountForSay, textBudgetFor } from '../utils/messageSplit.js';

const threads = useThreadsStore();
const buffers = useBuffersStore();
const networks = useNetworksStore();
const settings = useSettingsStore();
const toasts = useToastsStore();
const uploads = useUploadsStore();

const inputEl = ref<HTMLTextAreaElement | null>(null);
const text = ref('');

const view = computed(() => threads.view);
// The buffer by id, never the view's copy of its name: a DM's peer can change
// nick while the panel is up, and the send must follow the buffer.
const buffer = computed(() => (view.value ? buffers.byId(view.value.bufferId) : null));

// A send needs the network up and carrying reply tags: a line sent without
// one would land in the channel as a plain line, outside the thread.
const canSend = computed(() => {
  const v = view.value;
  if (!v || v.loading || !buffer.value) return false;
  return replyTagsGoOut(v.networkId) && threads.replyTarget() != null;
});

const placeholder = computed(() => {
  if (!view.value) return '';
  if (!canSend.value) return 'Can’t reply here right now';
  return 'Reply in thread…';
});

function focus(): void {
  inputEl.value?.focus();
}

defineExpose({ focus });

onMounted(() => autosize());

// Anything typed (or pasted) ends a Tab cycle: the word under the caret is
// the user's again.
function onInput(): void {
  cycle = null;
  autosize();
}

// The main composer's sizing: `field-sizing: content` where the browser has
// it (one layout pass, no transient 'auto' height — which, in the panel's
// column, briefly grew the lines above and cut their scroll position), and
// this measure-and-set only where it doesn't (Firefox).
const supportsFieldSizing =
  typeof CSS !== 'undefined' &&
  typeof CSS.supports === 'function' &&
  CSS.supports('field-sizing', 'content');

function autosize(): void {
  if (supportsFieldSizing) return;
  const el = inputEl.value;
  if (!el) return;
  el.style.height = 'auto';
  // Up to ~6 lines, then it scrolls.
  const line = parseFloat(getComputedStyle(el).lineHeight) || 20;
  el.style.height = `${Math.min(el.scrollHeight, line * 6)}px`;
}

// ─── Tab completion ───────────────────────────────────────────────────────
// The word before the caret, matched against the channel's members (then the
// thread's speakers, for someone who left). Tab cycles; any other key ends
// the cycle. At the start of the line the nick takes the channel composer's
// addressing suffix (input.completion.nick_suffix); elsewhere a space.
let cycle: { prefix: string; start: number; matches: string[]; index: number } | null = null;

function addressSuffix(): string {
  return `${String(settings.effective('input.completion.nick_suffix') ?? ':').trimEnd()} `;
}

function candidates(prefix: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (nick: string | undefined) => {
    if (!nick) return;
    const lc = nick.toLowerCase();
    if (seen.has(lc) || !lc.startsWith(prefix.toLowerCase())) return;
    seen.add(lc);
    out.push(nick);
  };
  for (const m of buffer.value?.members ?? []) add(m.nick);
  const v = view.value;
  if (v) {
    if (v.root) add(String(v.root.nick ?? ''));
    for (const r of v.replies) add(String(r.nick ?? ''));
  }
  // Your own nick last, as in the channel composer (#1496).
  const own = (nick: string) => networks.isOwnNick(buffer.value?.networkId, nick);
  return [...out.filter((n) => !own(n)), ...out.filter(own)];
}

function completeNick(): void {
  const el = inputEl.value;
  if (!el) return;
  const caret = el.selectionStart ?? text.value.length;
  if (!cycle) {
    const before = text.value.slice(0, caret);
    const start = Math.max(before.lastIndexOf(' '), before.lastIndexOf('\n')) + 1;
    const prefix = before.slice(start);
    if (!prefix) return;
    const matches = candidates(prefix);
    if (matches.length === 0) return;
    cycle = { prefix, start, matches, index: 0 };
  } else {
    cycle.index = (cycle.index + 1) % cycle.matches.length;
  }
  const nick = cycle.matches[cycle.index];
  const atLineStart = cycle.start === 0 || text.value[cycle.start - 1] === '\n';
  const insert = atLineStart ? `${nick}${addressSuffix()}` : `${nick} `;
  const after = text.value.slice(caret);
  text.value = text.value.slice(0, cycle.start) + insert + after;
  const pos = cycle.start + insert.length;
  void nextTick(() => {
    el.setSelectionRange(pos, pos);
    autosize();
  });
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    completeNick();
    return;
  }
  cycle = null;
  // Safari fires the Enter that confirms an IME candidate with isComposing
  // false; isImeKey reads the keyCode it leaves behind (useImeSafeInput).
  if (e.key === 'Enter' && !e.shiftKey && !isImeKey(e)) {
    e.preventDefault();
    void submit();
  }
}

// ─── A pasted file ────────────────────────────────────────────────────────

// Ours, not the store's `current`: the channel's composer may have one going.
const uploading = ref(false);
let unmounted = false;
onBeforeUnmount(() => {
  unmounted = true;
});
const uploadLabel = computed(() => {
  const pct = uploads.current?.progress;
  return pct != null && pct < 100 ? `Uploading ${pct}%` : 'Uploading…';
});

// The channel composer's gate (uploads.paste.enabled), upload and URL
// spacing. The URL comes back to this composer alone (`insert: false`).
async function onPaste(e: ClipboardEvent): Promise<void> {
  if (!canSend.value || settings.effective('uploads.paste.enabled') === false) return;
  const file = pastedUploadFile(e);
  if (!file) return;
  e.preventDefault();
  if (uploads.current) {
    toasts.push({
      title: 'Already uploading',
      body: 'One file goes up at a time. Paste it again once that one is done.',
      kind: 'warn',
      ttlMs: 5000,
    });
    return;
  }
  uploading.value = true;
  try {
    const result = await uploads.upload(file, null, { insert: false });
    if (!result?.url) return;
    // Gone in the meantime (another thread, the panel closed): the reply it
    // was for went with it, as a half-typed one does, but say where the file is.
    if (unmounted) {
      toasts.push({
        title: 'Uploaded',
        body: 'The thread closed before it finished, so it’s in your uploads, not a reply.',
        kind: 'info',
        ttlMs: 6000,
      });
      return;
    }
    insertUrl(result.url);
  } catch (err) {
    toasts.push({
      title: 'Upload failed',
      body: (err as Error)?.message || 'The file didn’t upload.',
      kind: 'error',
      ttlMs: 6000,
    });
  } finally {
    uploading.value = false;
  }
}

// Mid-composition (an IME, an Android keyboard's word), v-model holds the DOM
// back and then copies it over the model at compositionend, which would drop
// the URL: it waits for the composition to end. A Tab cycle ends with it, as
// any edit ends one. The caret moves only if the reader is still here — they
// may have gone to the channel's composer while the file went up.
let composing = false;
let urlAfterComposition: string | null = null;
function onCompositionStart(): void {
  composing = true;
}
function onCompositionEnd(): void {
  composing = false;
  const url = urlAfterComposition;
  urlAfterComposition = null;
  // After v-model has taken the composed text.
  if (url) void nextTick(() => insertUrl(url));
}

function insertUrl(url: string): void {
  if (composing) {
    urlAfterComposition = url;
    return;
  }
  cycle = null;
  const el = inputEl.value;
  const current = text.value;
  const next = insertWithPadding(
    current,
    el?.selectionStart ?? current.length,
    el?.selectionEnd ?? current.length,
    url,
  );
  text.value = next.text;
  void nextTick(() => {
    if (!el) return;
    if (document.activeElement === el) el.setSelectionRange(next.caret, next.caret);
    autosize();
  });
}

// ─── Sending ──────────────────────────────────────────────────────────────

async function submit(): Promise<void> {
  const v = view.value;
  const buf = buffer.value;
  const raw = text.value;
  const body = raw.trim();
  if (!v || !buf || !body || !canSend.value) return;
  // Its file is still going up: Enter waits for the URL rather than sending
  // the words without it.
  if (uploading.value) return;
  // A /command would go out as a line in the thread (`/msg bob password`
  // included). The channel's composer runs commands; this one doesn't.
  if (body.startsWith('/') && !body.startsWith('//')) {
    toasts.push({
      title: 'Commands don’t run in a thread',
      body: 'Type it in the channel’s composer instead.',
      kind: 'warn',
      ttlMs: 5000,
    });
    return;
  }
  const target = threads.replyTarget();
  if (!target) return;
  const line = body.startsWith('//') ? body.slice(1) : body;
  // The address a client without reply tags reads the reply by — unless the
  // line is ours (nobody to address) or the thread is in a DM.
  const own = target.self || networks.isOwnNick(v.networkId, target.nick);
  const addressed =
    own || !target.nick || privateTarget(buf.target) ? line : `${target.nick}: ${line}`;
  const wire = applySpoilerMarkup(addressed);
  // One PRIVMSG, or one draft/multiline batch: anything else leaves the thread.
  const net = networks.states[v.networkId];
  if (!net?.multilineLimits && chunkCountForSay(wire, textBudgetFor(net, buf.target)) > 1) {
    toasts.push({
      title: 'Too long for one line',
      body: 'A reply that splits would leave the thread. Shorten it, or send it in the channel.',
      kind: 'warn',
      ttlMs: 6000,
    });
    return;
  }
  const key = threadKey(v.bufferId, v.rootMsgid);
  const sent = socketSendWithAck({
    type: 'send',
    networkId: v.networkId,
    target: buf.target,
    text: wire,
    replyTo: target.messageId,
  });
  if (!sent) {
    toasts.push({
      title: 'Not connected',
      body: 'Your reply wasn’t sent. Try again once Lurker reconnects.',
      kind: 'error',
      ttlMs: 6000,
    });
    return;
  }
  text.value = '';
  await nextTick();
  autosize();
  const result = await sent;
  if (!result.ok) {
    toasts.push({
      title: 'Reply not sent',
      body: result.error ?? 'The server refused it.',
      kind: 'error',
      ttlMs: 6000,
    });
    // Give the words back — to the same thread, with nothing new typed since.
    const now = threads.view;
    if (now && threadKey(now.bufferId, now.rootMsgid) === key && !text.value) text.value = raw;
  }
}
</script>

<style scoped>
/* The main composer's row (MessageInput .input): same padding, bare textarea. */
.thread-input {
  display: flex;
  align-items: flex-start;
  padding: var(--space-4) var(--space-6);
  min-width: 0;
}
textarea {
  flex: 1;
  min-width: 0;
  background: transparent;
  border: none;
  padding: 0;
  color: var(--fg);
  font: inherit;
  line-height: 1.4;
  resize: none;
  overflow-y: auto;
  /* Up to six lines, then it scrolls (the JS fallback caps the same). */
  field-sizing: content;
  min-height: 1.4em;
  max-height: calc(1.4em * 6);
}
textarea:focus {
  outline: none;
}
textarea:disabled {
  opacity: 0.6;
}
textarea::placeholder {
  color: var(--fg-muted);
}
.send-btn {
  background: none;
  border: none;
  color: var(--accent);
  cursor: pointer;
  padding: 0 var(--space-1);
  line-height: 1.4;
  align-self: flex-end;
}
.send-btn.uploading {
  color: var(--fg-muted);
  cursor: default;
}
button.send-btn:hover:not(:disabled) {
  color: var(--fg);
}
.send-btn:disabled {
  opacity: 0.4;
  color: var(--fg-muted);
  cursor: default;
}
</style>
