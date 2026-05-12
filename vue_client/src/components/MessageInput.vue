<template>
  <form ref="formEl" class="input" @submit.prevent="submit">
    <span class="prompt">{{ promptLabel }}<span v-if="awayLabel" class="away">&nbsp;{{ awayLabel }}</span>&nbsp;&gt;</span>
    <input
      ref="inputEl"
      v-model="text"
      :placeholder="placeholder"
      :disabled="!active"
      autocomplete="off"
      spellcheck="false"
      @keydown="onKeydown"
      @blur="resetCompletion"
    />
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
import { ref, computed, watch, onBeforeUnmount } from 'vue';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useInputHistoryStore } from '../stores/inputHistory.js';
import { socketSend } from '../composables/useSocket.js';
import NickPicker from './NickPicker.vue';

const networks = useNetworksStore();
const buffers = useBuffersStore();
const inputHistory = useInputHistoryStore();
const text = ref('');
const inputEl = ref(null);
const formEl = ref(null);
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
  if (oldActive && (!newActive || oldActive.target !== newActive.target || oldActive.networkId !== newActive.networkId)) {
    endTypingTo(oldActive);
  }
});

onBeforeUnmount(() => {
  if (active.value) endTypingTo(active.value);
});

defineExpose({
  focus: () => inputEl.value?.focus(),
});

function submit() {
  resetCompletion();
  closePicker();
  const raw = text.value;
  if (!raw.trim() || !active.value) return;
  const { networkId, target } = active.value;

  if (raw.startsWith('/')) {
    handleCommand(raw, networkId, target);
  } else if (sendable.value) {
    socketSend({ type: 'send', networkId, target, text: raw });
    typingState = null;
    typingTarget = null;
    clearInactivityTimer();
  } else {
    return;
  }
  // Record after the early-return so we don't log plain text typed into a
  // :server: buffer that we refused to send. The optimistic local add keeps
  // up-arrow immediate; the server fans out to other tabs only (exceptWs).
  inputHistory.add(networkId, target, raw);
  socketSend({ type: 'input-history-add', networkId, target, text: raw });
  text.value = '';
  resetHistoryNav();
}

function handleCommand(line, networkId, target) {
  const [cmd, ...rest] = line.slice(1).split(/\s+/);
  const argLine = line.slice(1 + cmd.length).trim();
  switch (cmd.toLowerCase()) {
    case 'me':
      socketSend({ type: 'action', networkId, target, text: argLine });
      break;
    case 'msg':
    case 'query': {
      const [who, ...msgParts] = rest;
      if (!who) return;
      const body = msgParts.join(' ');
      if (body) socketSend({ type: 'send', networkId, target: who, text: body });
      buffers.activate(networkId, who);
      break;
    }
    case 'join':
      if (rest[0]) {
        const ch = rest[0].startsWith('#') ? rest[0] : `#${rest[0]}`;
        socketSend({ type: 'join', networkId, channel: ch });
      }
      break;
    case 'part':
    case 'leave': {
      // /part leaves the channel but KEEPS the buffer so the user can scroll
      // history and rejoin later. The buffer just renders dimmed in the
      // sidebar. Use /close to actually drop a buffer.
      const channel = rest[0] || target;
      const reason = rest.slice(1).join(' ');
      socketSend({ type: 'part', networkId, channel, reason });
      break;
    }
    case 'close':
      // Close the current buffer. For channels this also PARTs; for DMs it
      // just hides the buffer. Server pseudo-buffers can't be closed.
      socketSend({ type: 'close-buffer', networkId, target });
      break;
    case 'raw':
    case 'quote':
      socketSend({ type: 'raw', networkId, line: argLine });
      break;
    case 'away':
      // Empty arg → clear away. Server treats it the same as /back.
      socketSend({ type: 'away', message: argLine });
      break;
    case 'back':
      socketSend({ type: 'back' });
      break;
    case 'help':
      alert('Commands: /me, /msg <nick> <text>, /join #chan, /part [#chan] [reason], /close, /away [message], /back, /raw <line>');
      break;
    default:
      socketSend({ type: 'raw', networkId, line: line.slice(1) });
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
.prompt {
  color: var(--accent);
  white-space: pre;
  user-select: none;
}
.prompt .away { color: var(--warn); }
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
