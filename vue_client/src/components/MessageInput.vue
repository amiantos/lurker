<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: Elastic-2.0
-->

<template>
  <form
    ref="formEl"
    class="input"
    :class="{ 'drag-over': dragOver }"
    @submit.prevent="submit"
    @dragover.prevent="onDragOver"
    @dragleave.prevent="onDragLeave"
    @drop.prevent="onDrop"
  >
    <span class="prompt">{{ promptLabel }}<span v-if="awayLabel" class="away">&nbsp;{{ awayLabel }}</span>&nbsp;&gt;</span>
    <input
      ref="inputEl"
      v-model="text"
      :placeholder="placeholder"
      :disabled="!active"
      autocomplete="off"
      @keydown="onKeydown"
      @paste="onPaste"
      @blur="resetCompletion"
    />
    <input
      ref="fileInputEl"
      type="file"
      accept="image/*"
      class="file-hidden"
      @change="onFileSelected"
    />
    <button
      type="button"
      class="upload-btn"
      :disabled="!sendable"
      title="upload image"
      @click="onPickFile"
    ><i class="fa-solid fa-paperclip"></i></button>
    <NickPicker
      :open="pickerOpen"
      :query="pickerQuery"
      :buffer="buffer"
      :self-nick="ownNick"
      :anchor="formEl"
      @select="onPickerSelect"
      @close="closePicker"
    />
  </form>
</template>

<script setup>
import { ref, computed, watch, onBeforeUnmount, onMounted } from 'vue';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useInputHistoryStore } from '../stores/inputHistory.js';
import { useSettingsStore } from '../stores/settings.js';
import { useUploadsStore, onInsertUrl } from '../stores/uploads.js';
import { useToastsStore } from '../stores/toasts.js';
import { socketSend, socketSendWithAck } from '../composables/useSocket.js';
import { requestScrollToBottom } from '../composables/useScrollState.js';
import { setComposingState } from '../composables/useComposing.js';
import { chunkCountForSay, chunkCountForAction } from '../utils/messageSplit.js';
import NickPicker from './NickPicker.vue';

const networks = useNetworksStore();
const buffers = useBuffersStore();
const inputHistory = useInputHistoryStore();
const settings = useSettingsStore();
const uploads = useUploadsStore();
const toasts = useToastsStore();
const text = ref('');
const inputEl = ref(null);
const formEl = ref(null);
const fileInputEl = ref(null);
const dragOver = ref(false);
const pickerOpen = ref(false);
const pickerQuery = ref('');
let pickerTokenStart = -1;
let pickerTokenEnd = -1;

const active = computed(() => networks.activeBuffer);
const buffer = computed(() => (active.value
  ? buffers.byKey(`${active.value.networkId}::${active.value.target}`)
  : null));
const ownNick = computed(() => {
  const a = active.value;
  if (!a) return '';
  return networks.states[a.networkId]?.nick || '';
});
const isServer = computed(() => active.value?.target?.startsWith(':server:'));
const sendable = computed(() => !!active.value && !isServer.value);
const placeholder = computed(() => {
  if (!active.value) return 'Select a buffer';
  if (isServer.value) return '/raw <line>';
  return 'try /help';
});
// IRC channel prefix priority: q > a > o > h > v. The prompt prepends the
// highest-precedence prefix character we hold in the active channel, so the
// input area communicates "you're an op here" without a separate segment.
const PROMPT_PREFIX = { q: '~', a: '&', o: '@', h: '%', v: '+' };
const PROMPT_PREFIX_RANK = ['q', 'a', 'o', 'h', 'v'];

const channelPrefix = computed(() => {
  const a = active.value;
  if (!a || !a.target?.startsWith('#')) return '';
  const buf = buffer.value;
  const nick = networks.states[a.networkId]?.nick;
  if (!buf || !nick) return '';
  const lc = nick.toLowerCase();
  const me = (buf.members || []).find((m) => ((m.nick || m).toLowerCase()) === lc);
  const modes = me && typeof me === 'object' ? (me.modes || []) : [];
  for (const letter of PROMPT_PREFIX_RANK) {
    if (modes.includes(letter)) return PROMPT_PREFIX[letter];
  }
  return '';
});

const promptLabel = computed(() => {
  if (!active.value) return '—';
  const state = networks.states[active.value.networkId];
  const nick = state?.nick;
  if (!nick) return '—';
  const modes = state?.userModes || '';
  const parens = modes ? `(${modes})` : '';
  return `${channelPrefix.value}${nick}${parens}`;
});

const awayLabel = computed(() => {
  if (!active.value) return '';
  // The server keeps `message` populated after /back so the buffer dividers
  // can render the completed pair — gate on `active` so the prompt label
  // disappears when the user is no longer away.
  const away = networks.states[active.value.networkId]?.away;
  return away?.active && away.message ? `(${away.message})` : '';
});

let typingState = null;
let lastActiveSentAt = 0;
let inactivityTimer = null;
let typingTarget = null;

// Outgoing-split awareness. We estimate how many IRC lines the current input
// would split into and push that to the shared composing state so StatusBar
// can render the SPLIT/FLOOD indicator. `pendingSplitConfirm` is set the
// first time the user hits Send on a message that the gate rejects — a
// second press within the same draft proceeds. Editing the text clears it,
// so a fresh draft starts from a clean state.
let pendingSplitConfirm = false;

// Strip a leading slash command (/me, /msg <who>) so chunk counting reflects
// what irc-framework actually has to encode. For /me the relevant bytes are
// the action body, not the slash-command prefix. For /msg the body goes to
// some other target, but the wire chunks are the same. Other slash commands
// (/raw, /join, etc.) don't pass through the splitter — return null to
// signal "no split risk".
function bodyForSplit(text) {
  if (!text) return { body: '', isAction: false };
  if (text[0] !== '/') return { body: text, isAction: false };
  const m = text.match(/^\/(\w+)\s*(.*)$/s);
  if (!m) return { body: '', isAction: false };
  const cmd = m[1].toLowerCase();
  if (cmd === 'me') return { body: m[2], isAction: true };
  if (cmd === 'msg' || cmd === 'query') {
    // /msg <who> <body...> — drop the recipient nick from the body.
    const rest = m[2];
    const sp = rest.indexOf(' ');
    return { body: sp >= 0 ? rest.slice(sp + 1) : '', isAction: false };
  }
  return { body: '', isAction: false };
}

function computeChunks(text) {
  const { body, isAction } = bodyForSplit(text);
  const chunks = isAction ? chunkCountForAction(body) : chunkCountForSay(body);
  return { chunks, isAction };
}

function sendTyping(networkId, target, state) {
  socketSend({ type: 'typing', networkId, target, state });
}

function clearInactivityTimer() {
  if (inactivityTimer) {
    clearTimeout(inactivityTimer);
    inactivityTimer = null;
  }
}

function endTypingTo(target) {
  if (!target) return;
  if (typingState && typingTarget && typingTarget.target === target.target && typingTarget.networkId === target.networkId) {
    sendTyping(target.networkId, target.target, 'done');
  }
  typingState = null;
  typingTarget = null;
  clearInactivityTimer();
}

// Tab completion session — null when no Tab cycle is active. Reset on any
// non-Tab keydown, blur, submit, or buffer change.
let completion = null;
let cycling = false;  // true while we're programmatically rewriting `text`

// Input history walking state. `historyIndex` is null when we're not in a
// recall walk; otherwise it points into the per-buffer history slice.
// `historyDraft` preserves whatever the user had typed before they hit Up,
// so Down past the newest restores the in-progress draft.
let historyIndex = null;
let historyDraft = '';

function resetHistoryNav() {
  historyIndex = null;
  historyDraft = '';
}

function setInputAndCaretEnd(value) {
  cycling = true;
  text.value = value;
  // Hold `cycling` across the watcher microtask so `onInput` sees it set and
  // skips the history-walk reset. Clearing it synchronously loses the walk
  // state on the very next Up/Down because Vue's `watch` runs after we return.
  Promise.resolve().then(() => {
    cycling = false;
    const el = inputEl.value;
    if (!el) return;
    const pos = text.value.length;
    el.setSelectionRange(pos, pos);
  });
}

function handleHistoryNav(e) {
  if (!active.value) return;
  const { networkId, target } = active.value;
  const list = inputHistory.forBuffer(networkId, target);
  if (!list.length) return;
  e.preventDefault();
  resetCompletion();
  closePicker();

  if (e.key === 'ArrowUp') {
    if (historyIndex === null) {
      historyDraft = text.value;
      historyIndex = list.length - 1;
    } else if (historyIndex > 0) {
      historyIndex -= 1;
    } else {
      return;
    }
    setInputAndCaretEnd(list[historyIndex]);
    return;
  }

  // ArrowDown
  if (historyIndex === null) return;
  if (historyIndex < list.length - 1) {
    historyIndex += 1;
    setInputAndCaretEnd(list[historyIndex]);
  } else {
    const draft = historyDraft;
    resetHistoryNav();
    setInputAndCaretEnd(draft);
  }
}

function tokenAtCursor(value, cursor) {
  let start = cursor;
  while (start > 0 && !/\s/.test(value[start - 1])) start--;
  let end = cursor;
  while (end < value.length && !/\s/.test(value[end])) end++;
  return { token: value.slice(start, end), start, end };
}

function buildNickMatches(buf, networkId, prefix) {
  const lower = prefix.toLowerCase();
  const seen = new Set();
  // Pre-seed with our own nick so neither the speakers map (defense against
  // pre-fix stale state) nor the members list (which always contains us)
  // surfaces it. Tab-completing your own name is never useful.
  const own = networks.states[networkId]?.nick;
  if (own) seen.add(own.toLowerCase());
  const out = [];
  // Speakers first (reverse-chronological).
  const speakers = Object.values(buf.speakers || {})
    .sort((a, b) => b.lastTime - a.lastTime);
  for (const s of speakers) {
    if (!s.nick.toLowerCase().startsWith(lower)) continue;
    if (seen.has(s.nick.toLowerCase())) continue;
    seen.add(s.nick.toLowerCase());
    out.push(s.nick);
  }
  // Channel members not already represented (alphabetical).
  const memberNames = (buf.members || [])
    .map((m) => (typeof m === 'string' ? m : m.nick))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  for (const n of memberNames) {
    const lc = n.toLowerCase();
    if (seen.has(lc)) continue;
    if (!lc.startsWith(lower)) continue;
    seen.add(lc);
    out.push(n);
  }
  return out;
}

function buildChannelMatches(networkId, prefix) {
  const lower = prefix.toLowerCase();
  return buffers.forNetwork(networkId)
    .map((b) => b.target)
    .filter((t) => t.startsWith('#') && t.toLowerCase().startsWith(lower))
    .sort((a, b) => a.localeCompare(b));
}

function applyCompletion() {
  if (!completion || !completion.matches.length) return;
  const pick = completion.matches[completion.index];
  const suffix = (completion.atLineStart && !completion.isChannel) ? ': ' : '';
  cycling = true;
  text.value = completion.prefix + pick + suffix + completion.tail;
  cycling = false;
  // Move caret to just after the inserted nick + suffix.
  const caret = completion.prefix.length + pick.length + suffix.length;
  // Set on the next tick so v-model has propagated.
  Promise.resolve().then(() => {
    const el = inputEl.value;
    if (!el) return;
    el.setSelectionRange(caret, caret);
    completion.caret = caret;
  });
}

function resetCompletion() {
  completion = null;
}

function onKeydown(e) {
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    // Bare arrows only — Alt+Arrow is buffer navigation (handled globally in
    // useKeyboardShortcuts), so don't hijack it for input history here.
    if (e.altKey || e.metaKey || e.ctrlKey) return;
    handleHistoryNav(e);
    return;
  }
  if (e.key !== 'Tab') {
    if (completion) resetCompletion();
    return;
  }
  if (!sendable.value) return;
  e.preventDefault();
  const el = inputEl.value;
  if (!el) return;

  if (completion) {
    const dir = e.shiftKey ? -1 : 1;
    const n = completion.matches.length;
    if (n === 0) return;
    completion.index = (completion.index + dir + n) % n;
    applyCompletion();
    return;
  }

  const value = text.value;
  const cursor = el.selectionStart ?? value.length;
  const { token, start, end } = tokenAtCursor(value, cursor);
  if (!token) return;

  const buf = buffer.value;
  if (!buf) return;
  const networkId = active.value.networkId;

  const isChannel = token.startsWith('#');
  const stripped = isChannel ? token.slice(1) : token;
  const matches = isChannel
    ? buildChannelMatches(networkId, token)
    : buildNickMatches(buf, networkId, stripped);
  if (!matches.length) return;

  const prefix = value.slice(0, start);
  const tail = value.slice(end);
  const atLineStart = /^\s*$/.test(prefix);

  completion = { prefix, tail, token, isChannel, atLineStart, matches, index: 0, caret: 0 };
  applyCompletion();
}

function closePicker() {
  pickerOpen.value = false;
  pickerQuery.value = '';
  pickerTokenStart = -1;
  pickerTokenEnd = -1;
}

function refreshPicker() {
  const el = inputEl.value;
  if (!el) { closePicker(); return; }
  const value = text.value;
  const cursor = el.selectionStart ?? value.length;
  const { token, start, end } = tokenAtCursor(value, cursor);
  if (!token.startsWith('@')) {
    if (pickerOpen.value) closePicker();
    return;
  }
  pickerOpen.value = true;
  pickerQuery.value = token.slice(1);
  pickerTokenStart = start;
  pickerTokenEnd = end;
}

function onPickerSelect(nick) {
  const value = text.value;
  if (pickerTokenStart < 0) { closePicker(); return; }
  const before = value.slice(0, pickerTokenStart);
  const after = value.slice(pickerTokenEnd);
  cycling = true;
  text.value = before + nick + ' ' + after;
  cycling = false;
  closePicker();
  Promise.resolve().then(() => {
    const el = inputEl.value;
    if (!el) return;
    const caret = before.length + nick.length + 1;
    el.focus();
    el.setSelectionRange(caret, caret);
  });
}

function onInput() {
  if (cycling) return;
  // User edited the recalled line — exit walk mode but keep what they typed.
  // Done before the sendable gate so this still fires on :server: buffers
  // where `/raw` history is just as relevant.
  if (historyIndex !== null) resetHistoryNav();
  // Any edit invalidates the "second press confirms" override — otherwise the
  // user could be holding a flood-confirm token from an entirely different
  // draft. Cheap to clear unconditionally.
  pendingSplitConfirm = false;
  // Republish composing state on every keystroke so StatusBar's SPLIT/FLOOD
  // indicator stays live. We do this even on :server: buffers and slash
  // commands (computeChunks handles both — most return 0 chunks).
  const { chunks, isAction } = computeChunks(text.value);
  setComposingState({ chunks, isAction });
  if (!sendable.value) return;
  if (completion) resetCompletion();
  refreshPicker();
  const { networkId, target } = active.value;
  const trimmed = text.value.trim();

  if (trimmed === '' || text.value.startsWith('/')) {
    if (typingState) {
      sendTyping(networkId, target, 'done');
      typingState = null;
      typingTarget = null;
    }
    clearInactivityTimer();
    return;
  }

  const now = Date.now();
  if (typingState !== 'active' || now - lastActiveSentAt > 3000) {
    sendTyping(networkId, target, 'active');
    typingState = 'active';
    typingTarget = { networkId, target };
    lastActiveSentAt = now;
  }

  clearInactivityTimer();
  const tNet = networkId;
  const tTarget = target;
  inactivityTimer = setTimeout(() => {
    if (typingState === 'active' && text.value.trim() !== '') {
      sendTyping(tNet, tTarget, 'paused');
      typingState = 'paused';
    }
    inactivityTimer = null;
  }, 3000);
}

watch(text, onInput);

watch(active, (newActive, oldActive) => {
  resetCompletion();
  closePicker();
  resetHistoryNav();
  // A switch between buffers carries the draft along (text is component-
  // level, not per-buffer) but any unused split-confirm token doesn't
  // transfer — a fresh buffer is a fresh consent decision.
  pendingSplitConfirm = false;
  if (oldActive && (!newActive || oldActive.target !== newActive.target || oldActive.networkId !== newActive.networkId)) {
    endTypingTo(oldActive);
  }
});

onBeforeUnmount(() => {
  if (active.value) endTypingTo(active.value);
  if (unsubInsert) { unsubInsert(); unsubInsert = null; }
});

function insertUrlAtCaret(url) {
  const el = inputEl.value;
  const current = text.value;
  if (!el) {
    text.value = current ? `${current} ${url}` : url;
    return;
  }
  const start = el.selectionStart ?? current.length;
  const end = el.selectionEnd ?? current.length;
  const before = current.slice(0, start);
  const after = current.slice(end);
  const padLeft = before.length > 0 && !/\s$/.test(before) ? ' ' : '';
  const padRight = after.length > 0 && !/^\s/.test(after) ? ' ' : '';
  const inserted = `${padLeft}${url}${padRight}`;
  cycling = true;
  text.value = `${before}${inserted}${after}`;
  cycling = false;
  Promise.resolve().then(() => {
    const e2 = inputEl.value;
    if (!e2) return;
    const caret = before.length + inserted.length;
    e2.focus();
    e2.setSelectionRange(caret, caret);
  });
}

let unsubInsert = null;
onMounted(() => {
  unsubInsert = onInsertUrl(insertUrlAtCaret);
});

function blobFromClipboardItem(item) {
  if (!item || !item.type || !item.type.startsWith('image/')) return null;
  const file = item.getAsFile();
  return file || null;
}

function onPaste(e) {
  if (!sendable.value) return;
  if (settings.effective('uploads.paste.enabled') === false) return;
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    const file = blobFromClipboardItem(item);
    if (file) {
      e.preventDefault();
      uploads.upload(file).catch(() => { /* failure visible via status bar */ });
      return;
    }
  }
}

function onPickFile() {
  fileInputEl.value?.click();
}

function onFileSelected(e) {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file || !sendable.value) return;
  uploads.upload(file, file.name).catch(() => {});
}

function onDragOver(e) {
  if (!sendable.value) return;
  if (!Array.from(e.dataTransfer?.types || []).includes('Files')) return;
  dragOver.value = true;
}
function onDragLeave() {
  dragOver.value = false;
}
function onDrop(e) {
  dragOver.value = false;
  if (!sendable.value) return;
  const file = e.dataTransfer?.files?.[0];
  if (!file || !file.type.startsWith('image/')) return;
  uploads.upload(file, file.name).catch(() => {});
}

defineExpose({
  focus: () => inputEl.value?.focus(),
});

function toastSendFailure(error, body) {
  // Translate the small set of ack/error strings into something a person can
  // act on. We keep the failed text in the toast body so the user can copy
  // it; up-arrow also recalls it from local input history.
  const title = error === 'disconnected'
    ? 'Disconnected — message not sent'
    : error === 'timeout'
      ? 'Send timed out — message may not have been delivered'
      : error === 'not-connected'
        ? 'Network offline — message not sent'
        : error === 'unknown-network'
          ? 'Network not available — message not sent'
          : 'Message not sent';
  toasts.push({ title, body, kind: 'error', ttlMs: 8000 });
}

// Optimistically clear, but only AFTER we've confirmed the send actually
// hit the wire. Anything we'd otherwise have lost (the typed text, the
// history slot) is still recoverable via up-arrow if delivery later fails.
function commitInput(raw, networkId, target) {
  inputHistory.add(networkId, target, raw);
  socketSend({ type: 'input-history-add', networkId, target, text: raw });
  text.value = '';
  pendingSplitConfirm = false;
  setComposingState({ chunks: 0, isAction: false });
  resetHistoryNav();
  // Re-pin to the bottom so a user who was scrolled up reading history sees
  // their own send land — and the live-append watcher in MessageList keeps
  // following once stickToBottom flips back on.
  requestScrollToBottom();
}

async function submit() {
  resetCompletion();
  closePicker();
  const raw = text.value;
  if (!raw.trim() || !active.value) return;
  const { networkId, target } = active.value;

  // Outgoing-split gate. irc-framework will break anything past ~350 bytes
  // into multiple PRIVMSGs on the wire, which on a busy channel reads as a
  // flood. Three tiers:
  //   - /me with 2+ chunks: hard block (CTCP ACTION can't reasonably split)
  //   - 3+ chunks: always require a second Send press (flood)
  //   - 2 chunks: gated by chat.allow_split_messages (off → require second
  //     press; on → send silently)
  // computeChunks() returns 0 for slash commands we don't route through
  // PRIVMSG, so /join, /raw, etc. fall right through.
  const { chunks, isAction } = computeChunks(raw);
  if (isAction && chunks > 1) {
    toasts.push({
      title: 'Action message too long',
      body: "Actions can't be split across IRC lines — shorten it and try again.",
      kind: 'error',
      ttlMs: 6000,
    });
    return;
  }
  if (chunks > 1) {
    const flood = chunks >= 3;
    const allowSplit = !!settings.effective('chat.allow_split_messages');
    const blocked = flood || !allowSplit;
    if (blocked && !pendingSplitConfirm) {
      pendingSplitConfirm = true;
      toasts.push({
        title: flood
          ? `Will flood ${chunks} lines — Send again to confirm`
          : `Will split into ${chunks} lines — Send again to confirm`,
        body: !flood && !allowSplit
          ? 'Enable "Allow auto-split messages" in Settings to send splits without confirming.'
          : 'Lines will arrive back-to-back in the channel.',
        kind: 'warn',
        ttlMs: 7000,
      });
      return;
    }
  }
  pendingSplitConfirm = false;

  if (raw.startsWith('/')) {
    // Slash commands cover a lot of ground (joins, raws, /me, etc.). Treat
    // /me with the same ACK path as a normal send since it visibly fans out
    // as a chat message; the rest stay best-effort but at least bail out
    // synchronously if the socket is closed so we don't silently swallow
    // them either.
    const handled = await handleCommand(raw, networkId, target);
    if (!handled) return;
    commitInput(raw, networkId, target);
    return;
  }

  if (!sendable.value) return;

  const pending = socketSendWithAck({ type: 'send', networkId, target, text: raw });
  if (!pending) {
    // Socket isn't open — don't clear the input, don't pollute history. The
    // user can edit and retry, or wait for the auto-reconnect.
    toastSendFailure('disconnected', raw);
    return;
  }
  typingState = null;
  typingTarget = null;
  clearInactivityTimer();
  commitInput(raw, networkId, target);
  const result = await pending;
  if (!result.ok) toastSendFailure(result.error, raw);
}

// Drop a synthetic, non-persisted info line into the current buffer so the
// user sees the output of client-resolved commands like /help or argument
// validation errors. id-less so pushMessage's replay guard doesn't trip.
function localInfo(networkId, target, text) {
  buffers.pushMessage({
    networkId,
    target,
    type: 'motd',
    text,
    time: new Date().toISOString(),
  });
}

const HELP_LINES = [
  'commands:',
  '  /me <text>             — emote in the current buffer',
  '  /msg <nick> <text>     — open a DM and send (alias: /query)',
  '  /join <#chan>          — join a channel',
  '  /part [#chan] [reason] — leave channel (keeps buffer; alias: /leave)',
  '  /close                 — close current buffer (parts if channel)',
  '  /away [message]        — set away across every network (no arg clears)',
  '  /back                  — clear away',
  '  /whois <nick>          — query user info (renders in server buffer)',
  '  /kick <nick> [reason]  — kick from current channel',
  '  /mode <target> <flags> — set modes (target defaults to current channel)',
  '  /topic [text]          — set/clear topic on current channel',
  '  /nick <newnick>        — change your nick',
  '  /quit [reason]         — disconnect from current network',
  '  /list                  — list channels on current network',
  '  /jitsi                 — start a video call (alias: /talk)',
  '  /raw <line>            — send a raw IRC line (alias: /quote)',
  '  /help                  — this list',
];

function isChannelTarget(t) {
  return typeof t === 'string' && t.startsWith('#');
}

function randomRoomId() {
  const buf = new Uint8Array(6);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

// Best-effort send for control commands (/join, /raw, /away, ...). Returns
// false if the socket isn't open — so the caller can keep the typed text in
// the input rather than silently swallowing it.
function sendOrToast(payload, body) {
  const ok = socketSend(payload);
  if (!ok) toastSendFailure('disconnected', body);
  return ok;
}

// ACK-tracked send used by anything that puts a visible message into a
// channel/DM (/me, /msg <body>, /jitsi). Same shape as the main submit path:
// returns false synchronously if the socket is closed; otherwise kicks off
// the await and toasts asynchronously on a non-ok ACK.
function ackedSend(payload, body) {
  const pending = socketSendWithAck(payload);
  if (!pending) { toastSendFailure('disconnected', body); return false; }
  pending.then((result) => { if (!result.ok) toastSendFailure(result.error, body); });
  return true;
}

function handleCommand(line, networkId, target) {
  const [cmd, ...rest] = line.slice(1).split(/\s+/);
  const argLine = line.slice(1 + cmd.length).trim();
  switch (cmd.toLowerCase()) {
    case 'me':
      return ackedSend({ type: 'action', networkId, target, text: argLine }, argLine);
    case 'msg':
    case 'query': {
      const [who, ...msgParts] = rest;
      if (!who) return true;
      const body = msgParts.join(' ');
      if (body) {
        if (!ackedSend({ type: 'send', networkId, target: who, text: body }, body)) return false;
      }
      buffers.activate(networkId, who);
      return true;
    }
    case 'join':
      if (rest[0]) {
        const ch = rest[0].startsWith('#') ? rest[0] : `#${rest[0]}`;
        return sendOrToast({ type: 'join', networkId, channel: ch }, line);
      }
      return true;
    case 'part':
    case 'leave': {
      // /part leaves the channel but KEEPS the buffer so the user can scroll
      // history and rejoin later. The buffer just renders dimmed in the
      // sidebar. Use /close to actually drop a buffer.
      const channel = rest[0] || target;
      const reason = rest.slice(1).join(' ');
      return sendOrToast({ type: 'part', networkId, channel, reason }, line);
    }
    case 'close':
      // Close the current buffer. For channels this also PARTs; for DMs it
      // just hides the buffer. Server pseudo-buffers can't be closed.
      return sendOrToast({ type: 'close-buffer', networkId, target }, line);
    case 'raw':
    case 'quote':
      return sendOrToast({ type: 'raw', networkId, line: argLine }, line);
    case 'away':
      // Empty arg → clear away. Server treats it the same as /back.
      return sendOrToast({ type: 'away', message: argLine }, line);
    case 'back':
      return sendOrToast({ type: 'back' }, line);
    case 'whois': {
      const who = rest[0];
      if (!who) { localInfo(networkId, target, 'usage: /whois <nick>'); return true; }
      return sendOrToast({ type: 'raw', networkId, line: `WHOIS ${who}` }, line);
    }
    case 'kick': {
      // /kick <nick> [reason]            (in a channel buffer)
      // /kick <#chan> <nick> [reason]    (anywhere)
      let channel; let nick; let reason;
      if (rest[0] && rest[0].startsWith('#')) {
        channel = rest[0]; nick = rest[1]; reason = rest.slice(2).join(' ');
      } else {
        channel = isChannelTarget(target) ? target : null;
        nick = rest[0]; reason = rest.slice(1).join(' ');
      }
      if (!channel) { localInfo(networkId, target, 'usage: /kick [#chan] <nick> [reason] — no channel context'); return true; }
      if (!nick) { localInfo(networkId, target, 'usage: /kick [#chan] <nick> [reason]'); return true; }
      const trailer = reason ? ` :${reason}` : '';
      return sendOrToast({ type: 'raw', networkId, line: `KICK ${channel} ${nick}${trailer}` }, line);
    }
    case 'topic': {
      // /topic                        — request current topic (server buffer)
      // /topic <text>                 — set on current channel
      // /topic <#chan> [text]         — set/get on another channel
      let channel; let body;
      if (rest[0] && rest[0].startsWith('#')) {
        channel = rest[0];
        body = line.slice(1 + cmd.length).trim().slice(channel.length).trim();
      } else {
        channel = isChannelTarget(target) ? target : null;
        body = argLine;
      }
      if (!channel) { localInfo(networkId, target, 'usage: /topic [#chan] [text] — no channel context'); return true; }
      const trailer = body ? ` :${body}` : '';
      return sendOrToast({ type: 'raw', networkId, line: `TOPIC ${channel}${trailer}` }, line);
    }
    case 'nick': {
      const newNick = rest[0];
      if (!newNick) { localInfo(networkId, target, 'usage: /nick <newnick>'); return true; }
      return sendOrToast({ type: 'raw', networkId, line: `NICK ${newNick}` }, line);
    }
    case 'mode': {
      // /mode <flags>                  — apply to current channel
      // /mode <target> <flags...>      — apply to target (channel or self)
      if (!rest.length) { localInfo(networkId, target, 'usage: /mode [target] <flags> [args]'); return true; }
      const looksLikeFlagsOnly = /^[+-]/.test(rest[0]);
      if (looksLikeFlagsOnly && isChannelTarget(target)) {
        return sendOrToast({ type: 'raw', networkId, line: `MODE ${target} ${rest.join(' ')}` }, line);
      }
      return sendOrToast({ type: 'raw', networkId, line: `MODE ${argLine}` }, line);
    }
    case 'quit': {
      // Route through the intentional-disconnect path (POST .../disconnect →
      // ircManager.stopNetwork → client.quit()), which sets irc-framework's
      // requested_disconnect flag. Sending a raw QUIT line instead leaves that
      // flag unset, so the socket close looks unexpected and auto-reconnects.
      const reason = argLine || 'lurker';
      networks.disconnect(networkId, reason).catch((err) => {
        localInfo(networkId, target, `/quit failed: ${err.message || 'could not disconnect'}`);
      });
      return true;
    }
    case 'list':
      return sendOrToast({ type: 'raw', networkId, line: argLine ? `LIST ${argLine}` : 'LIST' }, line);
    case 'jitsi':
    case 'talk': {
      if (isServer.value) { localInfo(networkId, target, 'usage: /jitsi — run inside a channel or DM'); return true; }
      const url = `https://meet.jit.si/lurker-${randomRoomId()}`;
      return ackedSend({ type: 'send', networkId, target, text: url }, url);
    }
    case 'help':
      for (const text of HELP_LINES) localInfo(networkId, target, text);
      return true;
    default:
      return sendOrToast({ type: 'raw', networkId, line: line.slice(1) }, line);
  }
}
</script>

<style scoped>
.input {
  display: flex;
  align-items: center;
  gap: 1ch;
  padding: 8px 12px;
}
.input.drag-over {
  outline: 1px dashed var(--accent);
  outline-offset: -4px;
}
.prompt {
  color: var(--accent);
  white-space: pre;
  user-select: none;
}
.prompt .away { color: var(--warn); }
.upload-btn {
  background: none;
  border: none;
  color: var(--fg-muted);
  cursor: pointer;
  padding: 0 2px;
  font-size: inherit;
}
.upload-btn:hover:not(:disabled) { color: var(--accent); }
.upload-btn:disabled { opacity: 0.4; cursor: default; }
.file-hidden { display: none; }
input {
  flex: 1;
  min-width: 0;
  background: transparent;
  border: none;
  padding: 0;
  color: var(--fg);
}
input:focus { outline: none; }
input::placeholder { color: var(--fg-muted); font-style: italic; }

/* iOS Safari auto-zooms when focusing any input with computed font-size
   below 16px, and the global 14px would otherwise trigger it. Force 16px
   on mobile widths only — desktop keeps the denser typography. */
@media (max-width: 768px) {
  input { font-size: 16px; }
}
</style>
