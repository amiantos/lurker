<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <form
    ref="formEl"
    class="input"
    :class="{ 'drag-over': dragOver }"
    @dragover.prevent="onDragOver"
    @dragleave.prevent="onDragLeave"
    @drop.prevent="onDrop"
  >
    <span class="prompt"
      ><template v-if="!isMobile"
        >{{ promptLabel }}<span v-if="awayLabel" class="away">&nbsp;{{ awayLabel }}</span
        >&nbsp;</template
      ><span
        v-if="hasHistory"
        ref="promptBtnEl"
        role="button"
        class="prompt-recall"
        title="recall a previous input"
        @mousedown.prevent
        @click="toggleHistory"
        >&gt;</span
      ><template v-else>&gt;</template></span
    >
    <textarea
      ref="inputEl"
      v-model="text"
      rows="1"
      :placeholder="placeholder"
      :disabled="!active || isPaused"
      :spellcheck="systemFeatures.spellcheck"
      :autocorrect="systemFeatures.autocorrect"
      :autocapitalize="systemFeatures.autocapitalize"
      @keydown="onKeydown"
      @paste="onPaste"
      @blur="onBlur"
    ></textarea>
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
    >
      <i class="fa-solid fa-paperclip"></i>
    </button>
    <!-- mIRC color picker trigger. Opt-in via `input.show_format_button`
         (off by default) — the Cmd/Ctrl+B/I/U shortcuts remain active either
         way, so hiding the icon only removes the mouse-driven path.
         mousedown.prevent keeps focus on the textarea so opening the picker
         (or tapping it on iOS) doesn't dismiss the soft keyboard or blur the
         selection we're about to wrap. -->
    <div
      v-if="showFormatButton"
      role="button"
      class="format-btn"
      :class="{ disabled: !sendable }"
      title="mIRC formatting (Cmd/Ctrl+B/I/U for bold/italic/underline)"
      @mousedown.prevent
      @click="onToggleColorPicker"
    >
      <i class="fa-solid fa-palette"></i>
    </div>
    <!-- The nick / emoji suggestion strips and the mIRC colour picker render
         inside StatusBar (they overlay it visually) — see useComposerOverlay
         for the cross-component state contract. Only the desktop @-popup
         lives in the form, because it's a position:fixed popover anchored
         to the form rather than to StatusBar. -->
    <NickPicker
      ref="nickPickerEl"
      :open="pickerOpen"
      :query="pickerQuery"
      :buffer="buffer"
      :self-nick="ownNick"
      :anchor="formEl"
      @select="onPickerSelect"
      @close="closePicker"
    />
    <!-- `#channel` completion. Identical popover on desktop and mobile — there
         is no compact-strip variant for channels (issue #154). Independent of
         the nick picker; refreshPicker keeps the two from being open at once. -->
    <ChannelPicker
      ref="channelPickerEl"
      :open="channelPickerOpen"
      :query="channelPickerQuery"
      :network-id="active?.networkId ?? null"
      :anchor="formEl"
      @select="onChannelPickerSelect"
      @close="closeChannelPicker"
    />
    <!-- Previous-input recall menu, opened by tapping the `>` prompt — the
         pointer path to history for mobile, where Up-arrow is unreachable
         (issue #204). Anchored to the form like the pickers above; `toggle-el`
         is the prompt button so its own taps don't double-dismiss. -->
    <HistoryPicker
      :open="historyPickerOpen"
      :entries="historyEntries"
      :anchor="formEl"
      :toggle-el="promptBtnEl"
      @select="onHistorySelect"
      @close="closeHistoryPicker"
    />
    <Teleport to="body">
      <LongMessageUploadModal
        v-if="longMessageModalOpen"
        :content="longMessageContent"
        :chunks="longMessageChunks"
        :uploading="longMessageUploading"
        @confirm="onLongMessageConfirm"
        @cancel="onLongMessageCancel"
      />
    </Teleport>
  </form>
</template>

<script setup lang="ts">
import { ref, computed, watch, onBeforeUnmount, onMounted } from 'vue';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useAuthStore } from '../stores/auth.js';
import { useInputHistoryStore } from '../stores/inputHistory.js';
import { useDraftStore } from '../stores/drafts.js';
import { useSettingsStore } from '../stores/settings.js';
import { useUploadsStore, onInsertUrl } from '../stores/uploads.js';
import { useToastsStore } from '../stores/toasts.js';
import { useIgnoresStore } from '../stores/ignores.js';
import { useWhoisStore } from '../stores/whois.js';
import { socketSend, socketSendWithAck } from '../composables/useSocket.js';
import { requestScrollToBottom } from '../composables/useScrollState.js';
import { setComposingState } from '../composables/useComposing.js';
import { chunkCountForSay, chunkCountForAction } from '../utils/messageSplit.js';
import { applySpoilerMarkup } from '../utils/spoilerMarkup.js';
import { buildNickCandidates } from '../utils/nickCompletion.js';
import { buildChannelCandidates } from '../utils/channelCompletion.js';
import {
  findActiveShortcode,
  findCompletedShortcode,
  loadEmoji,
} from '../utils/emojiShortcodes.js';
import type { EmojiMatch } from '../utils/emojiData.js';
import NickPicker from './NickPicker.vue';
import ChannelPicker from './ChannelPicker.vue';
import HistoryPicker from './HistoryPicker.vue';
import LongMessageUploadModal from './LongMessageUploadModal.vue';
import { useSelfLabel } from '../composables/useSelfLabel.js';
import { useViewport } from '../composables/useViewport.js';
import {
  useComposerOverlay,
  setComposerOverlayHandlers,
  setNickStrip,
  setEmojiStrip,
  setColorPickerOpen,
  moveEmojiActive,
  confirmEmojiActive,
  hasEmojiCandidates,
  moveNickActive,
  confirmNickActive,
  hasNickCandidates,
  type NickStripItem,
} from '../composables/useComposerOverlay.js';
import { useNickColors } from '../composables/useNickColors.js';
import type { Buffer } from '../stores/buffers.js';

const networks = useNetworksStore();
const buffers = useBuffersStore();
const auth = useAuthStore();
const inputHistory = useInputHistoryStore();
const drafts = useDraftStore();
const settings = useSettingsStore();
const uploads = useUploadsStore();
const toasts = useToastsStore();
const ignores = useIgnoresStore();
const nickColors = useNickColors();
const inputEl = ref<HTMLTextAreaElement | null>(null);
const formEl = ref<HTMLElement | null>(null);
const fileInputEl = ref<HTMLInputElement | null>(null);
const dragOver = ref(false);
const pickerOpen = ref(false);
const pickerQuery = ref('');
const nickPickerEl = ref<InstanceType<typeof NickPicker> | null>(null);
let pickerTokenStart = -1;
let pickerTokenEnd = -1;
// `#channel` picker — a sibling of the nick picker with the same local-state
// shape (open flag, query, replaced-token span). Like the nick picker it's a
// position:fixed popover anchored to the form, not a StatusBar overlay, so its
// state lives here rather than in useComposerOverlay.
const channelPickerOpen = ref(false);
const channelPickerQuery = ref('');
const channelPickerEl = ref<InstanceType<typeof ChannelPicker> | null>(null);
let channelPickerTokenStart = -1;
let channelPickerTokenEnd = -1;
// Previous-input recall menu (issue #204). Unlike the nick/channel pickers it
// isn't tied to a token under the cursor — it's a tap on the `>` prompt that
// lists the whole buffer history. `promptBtnEl` is that toggle, kept here so
// HistoryPicker can exclude it from its outside-tap dismissal.
const historyPickerOpen = ref(false);
const promptBtnEl = ref<HTMLElement | null>(null);
// Suggestion-strip and colour-picker visibility / contents live in
// useComposerOverlay so StatusBar can render them as overlays without prop
// drilling. Token-span book-keeping (which slice of the draft a pick
// replaces) stays here — it's pure MessageInput state.
const overlay = useComposerOverlay();
let stripTokenStart = -1;
let stripTokenEnd = -1;
// Slack-style `:shortcode:` emoji suggester. `emojiToken{Start,End}` mark
// the `:query` span in the draft that a pick or inline auto-convert
// replaces. The ~1,900-entry emoji table is a lazily-loaded chunk (see
// `loadEmoji`), so nothing here pulls it into the initial bundle.
let emojiTokenStart = -1;
let emojiTokenEnd = -1;

const active = computed(() => networks.activeBuffer);

// Input contents are server-side per-buffer drafts — switching channels swaps
// the input bar's body to that buffer's draft (or empty). v-model writes go
// through the setter, which records the optimistic local update and schedules
// a debounced WS flush; the typing-state side effects in onInput run here
// (not in a watch(text)) so remote `draft-updated` echoes from other tabs
// don't fire fake "active" typing notifications.
const text = computed({
  get() {
    const a = active.value;
    return a ? drafts.forBuffer(a.networkId, a.target) : '';
  },
  set(value) {
    const a = active.value;
    if (!a) return;
    drafts.setLocal(a.networkId, a.target, value);
    onInput();
  },
});
const buffer = computed(() =>
  active.value ? buffers.byKey(`${active.value.networkId}::${active.value.target}`) : null,
);
// The active buffer's input history (chronological), surfaced to the `>` recall
// menu. `hasHistory` gates the prompt's tap affordance — no history, no button.
const historyEntries = computed(() =>
  active.value ? inputHistory.forBuffer(active.value.networkId, active.value.target) : [],
);
const hasHistory = computed(() => historyEntries.value.length > 0);
const ownNick = computed(() => {
  const a = active.value;
  if (!a) return '';
  return networks.states[a.networkId]?.nick || '';
});
const isServer = computed(() => active.value?.target?.startsWith(':server:'));
// Paused accounts are read-only — no buffer is sendable. The server also
// rejects any send that slips through, but gating here keeps the affordance
// honest (disabled composer, no optimistic bubble).
const isPaused = computed(() => auth.isPaused);
const sendable = computed(() => !!active.value && !isServer.value && !isPaused.value);
const placeholder = computed(() => {
  if (isPaused.value) return 'Account paused — read only';
  const a = active.value;
  if (!a) return 'Select a buffer';
  // `/raw <line>` was cryptic; `/help` is the discoverable entry point and the
  // server buffer is exactly where someone goes looking for it.
  if (isServer.value) return 'try /help';
  // Mobile shows network/channel in the compact status bar now, so the
  // placeholder carries the self identity (nick + channel-prefix + user modes)
  // instead, with the away marker appended when set — mirroring what the input
  // prompt renders on desktop. Desktop keeps `try /help` since the prompt
  // already shows the identity there.
  if (isMobile.value) {
    const self = promptLabel.value;
    return awayLabel.value ? `${self} ${awayLabel.value}` : self;
  }
  return 'try /help';
});
// Opt-in palette icon. The keyboard shortcuts in onKeydown ignore this gate —
// users can still wrap selections with Cmd/Ctrl+B/I/U even with the icon
// hidden, and the colour picker is just the mouse path for the same codes.
const showFormatButton = computed(() => settings.effective('input.show_format_button') === true);
// HTML attribute values for the system text features. spellcheck is the only
// one the browser parses as a boolean; the others take "on"/"off" or an enum.
// autocapitalize rides on input.autocorrect because Safari silently re-applies
// sentence-start capitalization whenever autocorrect is on, regardless of any
// autocapitalize="off" hint — so toggling autocorrect off has to kill both.
// The mobile-force override OR's in on touch breakpoints regardless of the
// desktop preference, so a user who keeps autocorrect off on their hardware
// keyboard can still get phone-typing assistance back.
const systemFeatures = computed(() => {
  const baseAutocorrect = settings.effective('input.autocorrect') !== false;
  const forceMobile =
    isMobile.value && settings.effective('input.autocorrect_force_mobile') === true;
  const autocorrectOn = baseAutocorrect || forceMobile;
  return {
    spellcheck: settings.effective('input.spellcheck') !== false,
    autocorrect: autocorrectOn ? 'on' : 'off',
    autocapitalize: autocorrectOn ? 'sentences' : 'off',
  };
});
// Prompt identity (nick + channel prefix + user modes) and away marker — see
// useSelfLabel. On mobile we don't render the prompt label inline here (the
// template gates it on !isMobile so the input row stays just `>` + textarea);
// instead it feeds the placeholder above, since the compact status bar now
// shows network/channel rather than the self identity.
const { promptLabel, awayLabel } = useSelfLabel();
const { isMobile } = useViewport();

let typingState: string | null = null;
let lastActiveSentAt = 0;
let inactivityTimer: ReturnType<typeof setTimeout> | null = null;
let typingTarget: { networkId: number; target: string } | null = null;

// Outgoing-split awareness. We estimate how many IRC lines the current input
// would split into and push that to the shared composing state so StatusBar
// can render the SPLIT/FLOOD indicator. `pendingSplitConfirm` is set the
// first time the user hits Send on a message that the gate rejects — a
// second press within the same draft proceeds. Editing the text clears it,
// so a fresh draft starts from a clean state.
let pendingSplitConfirm = false;

// Flood-confirmation modal. Opens when a Send hits the 3+ chunk gate; the
// user either uploads the body as a .txt (URL inserted into the input,
// replacing the typed message) or cancels to fall through to the existing
// send-again override flow on the next Send press.
const longMessageModalOpen = ref(false);
const longMessageContent = ref('');
const longMessageChunks = ref(0);
const longMessageUploading = ref(false);

// Strip a leading slash command (/me, /msg <who>) so chunk counting reflects
// what irc-framework actually has to encode. For /me the relevant bytes are
// the action body, not the slash-command prefix. For /msg the body goes to
// some other target, but the wire chunks are the same. Other slash commands
// (/raw, /join, etc.) don't pass through the splitter — return null to
// signal "no split risk".
function bodyForSplit(raw: string): { body: string; isAction: boolean } {
  if (!raw) return { body: '', isAction: false };
  // // escape: `//foo` is a literal `/foo` message, not a command, so it does
  // pass through PRIVMSG and is subject to the splitter. Plain and //-escaped
  // messages also get the `||spoiler||` rewrite on send, so count the
  // post-rewrite bytes here or the split estimate drifts low.
  if (raw.startsWith('//')) return { body: applySpoilerMarkup(raw.slice(1)), isAction: false };
  if (raw[0] !== '/') return { body: applySpoilerMarkup(raw), isAction: false };
  const m = raw.match(/^\/(\w+)\s*(.*)$/s);
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

function computeChunks(raw: string): { chunks: number; isAction: boolean } {
  const { body, isAction } = bodyForSplit(raw);
  const chunks = isAction ? chunkCountForAction(body) : chunkCountForSay(body);
  return { chunks, isAction };
}

function sendTyping(networkId: number, target: string, state: string): void {
  socketSend({ type: 'typing', networkId, target, state });
}

function clearInactivityTimer(): void {
  if (inactivityTimer) {
    clearTimeout(inactivityTimer);
    inactivityTimer = null;
  }
}

function endTypingTo(target: { networkId: number; target: string } | null | undefined): void {
  if (!target) return;
  if (
    typingState &&
    typingTarget &&
    typingTarget.target === target.target &&
    typingTarget.networkId === target.networkId
  ) {
    sendTyping(target.networkId, target.target, 'done');
  }
  typingState = null;
  typingTarget = null;
  clearInactivityTimer();
}

// Tab completion session — null when no Tab cycle is active. Reset on any
// non-Tab keydown, blur, submit, or buffer change.
interface CompletionState {
  prefix: string;
  tail: string;
  token: string;
  isChannel: boolean;
  atLineStart: boolean;
  matches: string[];
  index: number;
  caret: number;
}
let completion: CompletionState | null = null;
let cycling = false; // true while we're programmatically rewriting `text`

// Input history walking state. `historyIndex` is null when we're not in a
// recall walk; otherwise it points into the per-buffer history slice.
// `historyDraft` preserves whatever the user had typed before they hit Up,
// so Down past the newest restores the in-progress draft.
let historyIndex: number | null = null;
let historyDraft = '';

function resetHistoryNav() {
  historyIndex = null;
  historyDraft = '';
}

function setInputAndCaretEnd(value: string): void {
  cycling = true;
  text.value = value;
  // Hold `cycling` across the watcher microtask so `onInput` sees it set and
  // skips the history-walk reset. Clearing it synchronously loses the walk
  // state on the very next Up/Down because Vue's `watch` runs after we return.
  queueMicrotask(() => {
    cycling = false;
    const el = inputEl.value;
    if (!el) return;
    const pos = text.value.length;
    el.setSelectionRange(pos, pos);
  });
}

// IRCCloud-style edge detection for history nav: Up at the first logical
// line / Down at the last logical line walks history. Otherwise the arrow
// is left alone so it can move the caret between lines within a multi-line
// draft. "Logical line" = explicit \n in the text; visual wrapping is not
// counted (a single long wrapped line still triggers history, which matches
// IRCCloud's behavior).
function atHistoryEdge(key: string): boolean {
  const el = inputEl.value;
  if (!el) return true;
  const value = text.value;
  const caret = el.selectionStart ?? value.length;
  if (key === 'ArrowUp') {
    return !value.slice(0, caret).includes('\n');
  }
  return !value.slice(caret).includes('\n');
}

function handleHistoryNav(e: KeyboardEvent): void {
  if (!active.value) return;
  const { networkId, target } = active.value;
  const list = inputHistory.forBuffer(networkId, target);
  if (!list.length) return;
  e.preventDefault();
  resetCompletion();
  closePicker();
  closeStrip();
  closeChannelPicker();

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

function tokenAtCursor(
  value: string,
  cursor: number,
): { token: string; start: number; end: number } {
  let start = cursor;
  while (start > 0 && !/\s/.test(value[start - 1])) start--;
  let end = cursor;
  while (end < value.length && !/\s/.test(value[end])) end++;
  return { token: value.slice(start, end), start, end };
}

// True when `before` (the text preceding a token) sits at the start of a
// logical line — nothing but whitespace since the last newline, or the very
// start of the input. Callers use this to detect a nick that's being
// *addressed* and so wants an opening ': '. Shared by Tab-completion and both
// @-driven selectors so all three detect line starts identically, including
// on multi-line drafts; what each appends *off* a line start still differs
// (see the call sites).
function isAtLineStart(before: string): boolean {
  return /(^|\n)\s*$/.test(before);
}

function buildNickMatches(buf: Buffer, networkId: number, prefix: string): string[] {
  const own = networks.states[networkId]?.nick || '';
  const isIgnored = (nick: string, userhost: string | null) =>
    ignores.isIgnored(networkId, nick, userhost ?? '');
  return buildNickCandidates(buf, own, prefix, isIgnored).map((c) => c.nick);
}

// Strip-flavored variant: caps at 30 chips and pre-computes the per-nick
// color so the StatusBar chip slot can stay declarative.
function buildNickStripItems(buf: Buffer, networkId: number, prefix: string): NickStripItem[] {
  const own = networks.states[networkId]?.nick || '';
  const isIgnored = (nick: string, userhost: string | null) =>
    ignores.isIgnored(networkId, nick, userhost ?? '');
  return buildNickCandidates(buf, own, prefix, isIgnored)
    .slice(0, 30)
    .map((c) => ({ nick: c.nick, color: nickColors.color(c.nick) }));
}

function buildChannelMatches(networkId: number, prefix: string): string[] {
  return buildChannelCandidates(buffers.forNetwork(networkId), prefix);
}

function applyCompletion() {
  if (!completion || !completion.matches.length) return;
  const pick = completion.matches[completion.index];
  const suffix = completion.atLineStart && !completion.isChannel ? ': ' : '';
  // Tab-completion owns the input now; any open @-picker or mobile suggestion
  // strip would be stale (cycling suppresses onInput → refreshPicker doesn't
  // fire, so they wouldn't close on their own).
  closePicker();
  closeStrip();
  closeChannelPicker();
  cycling = true;
  text.value = completion.prefix + pick + suffix + completion.tail;
  cycling = false;
  // Move caret to just after the inserted nick + suffix.
  const caret = completion.prefix.length + pick.length + suffix.length;
  // Set on the next tick so v-model has propagated.
  queueMicrotask(() => {
    const el = inputEl.value;
    if (!el) return;
    el.setSelectionRange(caret, caret);
    if (completion) completion.caret = caret;
  });
}

function resetCompletion() {
  completion = null;
}

function onBlur() {
  resetCompletion();
  // Dismiss the emoji suggester on focus loss so it doesn't linger over the
  // StatusBar — picking a chip keeps focus (mousedown.prevent) so this never
  // races a selection.
  closeEmojiStrip();
  // Force the active buffer's draft to the server now rather than waiting on
  // the debounce timer — covers refocus into a different tab or mobile
  // app-switch without losing the in-progress text.
  if (active.value) drafts.flushBuffer(active.value.networkId, active.value.target);
}

// mIRC formatting control bytes. These are real bytes on the wire — irc-framework
// passes the message text through verbatim, so anything we insert here is what
// remote clients see (and what splitTextByTokens in nickColor.js parses back out
// for local echo). The chunk-count gate in messageSplit.js counts bytes via
// TextEncoder, so each control char correctly contributes one byte to the
// SPLIT/FLOOD estimate.
const FMT_BOLD = '\x02';
const FMT_ITALIC = '\x1D';
const FMT_UNDERLINE = '\x1F';
const FMT_COLOR = '\x03';
const FMT_RESET = '\x0F';

// Wrap the current selection with `opening`…`closing`, or insert `opening`
// alone at the caret if nothing is selected (mIRC-style: a bare toggle code
// flips state for whatever follows). Routes the new value through the same
// cycling guard that nick completion uses so onInput doesn't reset history
// nav or fire a typing notification mid-write.
function wrapOrInsertFormatting(opening: string, closing: string): void {
  const el = inputEl.value;
  if (!el) return;
  const value = text.value;
  const start = el.selectionStart ?? value.length;
  const end = el.selectionEnd ?? value.length;
  const selected = value.slice(start, end);
  const tail = selected ? closing : '';
  cycling = true;
  text.value = value.slice(0, start) + opening + selected + tail + value.slice(end);
  cycling = false;
  // Selection-aware caret restore: with a selection, re-select the wrapped
  // body so the user can keep applying combinations (bold + italic + colour)
  // without re-highlighting. With no selection, drop the caret just after
  // the inserted code so they can type styled text.
  queueMicrotask(() => {
    const e2 = inputEl.value;
    if (!e2) return;
    e2.focus();
    if (selected) {
      const s = start + opening.length;
      e2.setSelectionRange(s, s + selected.length);
    } else {
      const c = start + opening.length;
      e2.setSelectionRange(c, c);
    }
  });
}

function onToggleColorPicker() {
  if (!sendable.value) return;
  setColorPickerOpen(!overlay.colorPickerOpen);
}

function closeColorPicker() {
  setColorPickerOpen(false);
}

function onApplyColor(fg: string | null, bg: string | null): void {
  // `fg`/`bg` are 2-digit codes ("00".."15") staged in the picker, either of
  // which may be null. Build one \x03 code from them: with both set the text
  // keeps the chosen foreground over the chosen background; a background-only
  // pick emits foreground 99 (mIRC "default") so just the background fills in.
  let opening: string;
  if (fg && bg) opening = `${FMT_COLOR}${fg},${bg}`;
  else if (fg) opening = FMT_COLOR + fg;
  else opening = `${FMT_COLOR}99,${bg}`;
  wrapOrInsertFormatting(opening, FMT_COLOR);
  closeColorPicker();
}

function onPickReset() {
  // \x0F resets every active toggle at once. Useful as the closing marker for
  // a multi-format run, or as a one-shot "go back to default" mid-message.
  // Treated as a single insert (no closing pair) regardless of selection.
  wrapOrInsertFormatting(FMT_RESET, '');
  closeColorPicker();
}

function onKeydown(e: KeyboardEvent): void {
  // Formatting shortcuts (Cmd/Ctrl + B/I/U). preventDefault stops the browser
  // from owning Cmd+B for "bookmarks bar"; stopPropagation keeps the global
  // shortcut handler in useKeyboardShortcuts.js from seeing keys that map to
  // app-level actions when focus is in the input. Bare letters fall through
  // so the user can still type a literal 'b'.
  if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
    const key = e.key.toLowerCase();
    if (key === 'b' || key === 'i' || key === 'u') {
      e.preventDefault();
      e.stopPropagation();
      if (!sendable.value) return;
      const code = key === 'b' ? FMT_BOLD : key === 'i' ? FMT_ITALIC : FMT_UNDERLINE;
      wrapOrInsertFormatting(code, code);
      return;
    }
  }
  if (e.key === 'Escape' && overlay.colorPickerOpen) {
    e.preventDefault();
    closeColorPicker();
    return;
  }
  // While the desktop @-nick picker is open with candidates it owns the
  // navigation keys: arrows move the highlight, Tab or Enter confirm it. This
  // runs ahead of the history-nav, Tab-completion, and Enter-submit handlers
  // below so they don't double-fire. Enter accepts the highlighted nick here
  // (issue #221): typing `@` is an explicit "I'm completing a nick" signal, so
  // unlike the prefix-less nick strip further down, Enter-to-accept is
  // unambiguous — matching Slack/Discord. Shift+Enter still inserts a newline.
  // Escape is left to NickPicker's own document listener. Gated on
  // hasCandidates() so a no-match token like `@zzz` lets Enter/Tab fall through
  // to send / word completion. Skipped entirely during an IME composition so
  // the same arrows/Tab/Enter stay free to drive the IME's candidate window.
  // The picker is desktop-only — the mobile suggestion strip never opens it.
  if (pickerOpen.value && !e.isComposing && nickPickerEl.value?.hasCandidates()) {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      if (!e.altKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        nickPickerEl.value.moveActive(e.key === 'ArrowUp' ? 1 : -1);
        return;
      }
    } else if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
      e.preventDefault();
      nickPickerEl.value.confirmActive();
      return;
    }
  }
  // The `#`-channel picker mirrors the nick picker above: while open with
  // candidates it owns arrows (move highlight) and Tab/Enter (confirm), and
  // Escape is left to ChannelPicker's own document listener. `#` is an explicit
  // prefix, so Enter accepts here too (issue #221); Shift+Enter still newlines.
  // Gated on hasCandidates() so a no-match `#zzz` lets Enter/Tab fall through to
  // send / in-place completion below. refreshPicker keeps this and the nick
  // picker from being open at once, so the two blocks can't both fire.
  if (channelPickerOpen.value && !e.isComposing && channelPickerEl.value?.hasCandidates()) {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      if (!e.altKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        channelPickerEl.value.moveActive(e.key === 'ArrowUp' ? 1 : -1);
        return;
      }
    } else if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
      e.preventDefault();
      channelPickerEl.value.confirmActive();
      return;
    }
  }
  // The mobile/compact nick strip owns navigation keys while open with
  // candidates. All four arrows cycle the highlight (Down/Right next, Up/Left
  // previous), Tab confirms the active chip, Escape closes the strip.
  // refreshPicker ensures the strip and the @-picker are never open at once,
  // so the two blocks can't both fire. Tab here intentionally confirms the
  // highlighted chip rather than falling through to in-place Tab-completion —
  // the strip is the primary completion UI when it's up.
  //
  // Unlike the @/#/: suggesters above and below, Enter is deliberately NOT an
  // accept key here — it always sends (tap a chip or press Tab to accept).
  // This strip is prefix-less: it pops up on any plain word that matches a
  // nick while you type an ordinary message, so a key that means "send" must
  // not quietly mean "complete" (issue #221).
  if (overlay.nickOpen && !e.isComposing && hasNickCandidates()) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeStrip();
      return;
    }
    if (
      e.key === 'ArrowUp' ||
      e.key === 'ArrowDown' ||
      e.key === 'ArrowLeft' ||
      e.key === 'ArrowRight'
    ) {
      if (!e.altKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        const forward = e.key === 'ArrowDown' || e.key === 'ArrowRight';
        moveNickActive(forward ? 1 : -1);
        return;
      }
    } else if (e.key === 'Tab') {
      e.preventDefault();
      confirmNickActive();
      return;
    }
  }
  // The emoji suggester owns the navigation keys while it's open with
  // candidates — all four arrows cycle the highlight (Down/Right step toward
  // the next chip, Up/Left toward the previous), Tab or Enter confirm, Escape
  // closes. Runs ahead of the history-nav and Enter-submit handlers so they
  // don't double-fire. `:shortcode` is an explicit prefix, so Enter accepts the
  // highlighted emoji here (issue #221), matching Slack/Discord; Shift+Enter
  // still newlines, and the hasEmojiCandidates() gate lets a no-match `:zz`
  // fall through to send. Hijacking Left/Right means the caret can't move
  // inside the shortcode while the strip is up — acceptable, since the caret
  // sits at the end of the `:query` anyway and Escape frees it. Bare arrows
  // only: modifier+arrow still does its normal caret jump / buffer-nav. Skipped
  // during an IME composition. The emoji strip and the nick picker are never
  // open at once (refreshPicker closes one before opening the other), so the
  // two blocks can't both fire.
  if (overlay.emojiOpen && !e.isComposing && hasEmojiCandidates()) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeEmojiStrip();
      return;
    }
    if (
      e.key === 'ArrowUp' ||
      e.key === 'ArrowDown' ||
      e.key === 'ArrowLeft' ||
      e.key === 'ArrowRight'
    ) {
      if (!e.altKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        const forward = e.key === 'ArrowDown' || e.key === 'ArrowRight';
        moveEmojiActive(forward ? 1 : -1);
        return;
      }
    } else if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
      e.preventDefault();
      confirmEmojiActive();
      return;
    }
  }
  if (e.key === 'Enter') {
    // Textareas don't submit forms on Enter, so we trigger submission here.
    // Shift+Enter falls through to the default newline insert. e.isComposing
    // guards against IME users — pressing Enter to confirm a composition
    // shouldn't fire a send. The fire-and-forget on submit() is intentional;
    // it owns its own error handling and the sync handler shouldn't await.
    if (e.isComposing) return;
    if (e.shiftKey) return;
    e.preventDefault();
    submit();
    return;
  }
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    // Bare arrows only — Alt+Arrow is buffer navigation (handled globally in
    // useKeyboardShortcuts), so don't hijack it for input history here.
    if (e.altKey || e.metaKey || e.ctrlKey) return;
    // Leave the arrows to an active IME — they navigate its candidate window.
    if (e.isComposing) return;
    // Multi-line textarea: only walk history at the logical-line edges, so
    // arrows still move the caret between newline-separated lines within
    // the draft. Up = at first logical line (no \n before caret).
    // Down = at last logical line (no \n after caret).
    if (!atHistoryEdge(e.key)) return;
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
  if (!buf || !active.value) return;
  const networkId = active.value.networkId;

  const isChannel = token.startsWith('#');
  const stripped = isChannel ? token.slice(1) : token;
  const matches = isChannel
    ? buildChannelMatches(networkId, token)
    : buildNickMatches(buf, networkId, stripped);
  if (!matches.length) return;

  const prefix = value.slice(0, start);
  const tail = value.slice(end);
  const atLineStart = isAtLineStart(prefix);

  completion = { prefix, tail, token, isChannel, atLineStart, matches, index: 0, caret: 0 };
  applyCompletion();
}

function closePicker() {
  pickerOpen.value = false;
  pickerQuery.value = '';
  pickerTokenStart = -1;
  pickerTokenEnd = -1;
}

function closeChannelPicker() {
  channelPickerOpen.value = false;
  channelPickerQuery.value = '';
  channelPickerTokenStart = -1;
  channelPickerTokenEnd = -1;
}

function closeHistoryPicker() {
  historyPickerOpen.value = false;
}

function closeStrip() {
  setNickStrip(false);
  stripTokenStart = -1;
  stripTokenEnd = -1;
}

function closeEmojiStrip() {
  setEmojiStrip(false);
  emojiTokenStart = -1;
  emojiTokenEnd = -1;
}

// Open/refresh the emoji suggester for the shortcode under the caret. Async
// because the emoji table is a lazily-loaded chunk; the candidate set is
// re-derived from live text once it resolves, so a fast typist (or an
// out-of-order resolve) still ends up showing the current query's matches.
async function showEmojiStrip() {
  const mod = await loadEmoji().catch(() => null);
  if (!mod) {
    closeEmojiStrip();
    return;
  }
  const el = inputEl.value;
  if (!el) {
    closeEmojiStrip();
    return;
  }
  const value = text.value;
  const sc = findActiveShortcode(value, el.selectionStart ?? value.length);
  if (!sc || sc.name.length < 2) {
    closeEmojiStrip();
    return;
  }
  const matches = mod.searchEmoji(sc.name);
  if (!matches.length) {
    closeEmojiStrip();
    return;
  }
  setEmojiStrip(true, matches);
  emojiTokenStart = sc.start;
  emojiTokenEnd = sc.end;
}

// Replace the `:query` token with the picked emoji. No trailing space — emoji
// often run together, and the typed-out auto-convert path can't add one
// either, so the two stay consistent.
function onEmojiSelect(item: EmojiMatch): void {
  const value = text.value;
  // Re-validate the captured span still holds an in-progress shortcode before
  // splicing — the draft could have shifted since the strip opened (edits
  // re-sync the span via refreshPicker, but the async strip refresh leaves a
  // brief window). Mirrors the re-check maybeConvertShortcode already does;
  // on a mismatch, no-op rather than splice blind into the wrong span.
  const sc = emojiTokenStart >= 0 ? findActiveShortcode(value, emojiTokenEnd) : null;
  if (!sc || sc.start !== emojiTokenStart) {
    closeEmojiStrip();
    return;
  }
  const before = value.slice(0, sc.start);
  const after = value.slice(sc.end);
  cycling = true;
  text.value = before + item.emoji + after;
  cycling = false;
  closeEmojiStrip();
  queueMicrotask(() => {
    const el = inputEl.value;
    if (!el) return;
    const caret = before.length + item.emoji.length;
    el.focus();
    el.setSelectionRange(caret, caret);
  });
}

// Inline `:shortcode:` → emoji, fired from onInput when the user types the
// closing `:` of a known shortcode. Async for the same lazy-chunk reason as
// showEmojiStrip; the match is re-validated against live text before the
// rewrite, in case the draft moved on while the chunk loaded.
async function maybeConvertShortcode() {
  const el = inputEl.value;
  if (!el) return;
  const sc = findCompletedShortcode(text.value, el.selectionStart ?? text.value.length);
  if (!sc) return;
  const mod = await loadEmoji().catch(() => null);
  if (!mod) return;
  const emoji = mod.emojiForShortcode(sc.name);
  if (!emoji) return;
  const el2 = inputEl.value;
  if (!el2) return;
  const value = text.value;
  const fresh = findCompletedShortcode(value, el2.selectionStart ?? value.length);
  if (!fresh || fresh.name !== sc.name) return;
  const before = value.slice(0, fresh.start);
  const after = value.slice(fresh.end);
  cycling = true;
  text.value = before + emoji + after;
  cycling = false;
  closeEmojiStrip();
  queueMicrotask(() => {
    const e2 = inputEl.value;
    if (!e2) return;
    const caret = before.length + emoji.length;
    e2.focus();
    e2.setSelectionRange(caret, caret);
  });
}

function refreshPicker() {
  const el = inputEl.value;
  if (!el) {
    closePicker();
    closeStrip();
    closeEmojiStrip();
    closeChannelPicker();
    return;
  }
  const value = text.value;
  const cursor = el.selectionStart ?? value.length;

  // An in-progress `:shortcode:` owns the suggester slot — it isn't a nick
  // token, and the emoji strip and the nick picker/strip share one slot over
  // the StatusBar. Min length 2 keeps the strip from flashing on a lone `:x`.
  const shortcode = findActiveShortcode(value, cursor);
  if (shortcode && shortcode.name.length >= 2) {
    closePicker();
    closeStrip();
    closeChannelPicker();
    void showEmojiStrip();
    return;
  }
  closeEmojiStrip();

  const { token, start, end } = tokenAtCursor(value, cursor);

  // `#channel` token → the channel picker, on every platform (no compact-strip
  // variant; see issue #154). It's a standalone popover, so the nick picker
  // and both StatusBar strips close while it's up. Opens as soon as `#` is
  // typed so you get the full joined-channel list; the picker self-hides when
  // nothing matches (its v-if gates on candidate count), so a stray `#5` or a
  // channel you're not in just shows no popover.
  if (token.startsWith('#')) {
    closePicker();
    closeStrip();
    channelPickerOpen.value = true;
    channelPickerQuery.value = token;
    channelPickerTokenStart = start;
    channelPickerTokenEnd = end;
    return;
  }
  // Any other token means a channel isn't being edited — tear down a picker the
  // previous keystroke may have opened before routing to the nick UIs below.
  closeChannelPicker();

  // Slash commands never trigger nick completion in either UI.
  if (token.startsWith('/')) {
    closePicker();
    closeStrip();
    return;
  }

  // Both UIs are concurrent wherever the strip is enabled — `@`-prefix is the
  // explicit opt-in to the vertical picker, anything else routes to the
  // horizontal strip. Mobile always has the strip; desktop opts in via the
  // setting. With the setting off on desktop there is no strip, so non-`@`
  // tokens get no completion UI and `@`-tokens still drive the picker.
  const stripEnabled = isMobile.value || !!settings.effective('input.suggestion_strip_on_desktop');
  const useStrip = stripEnabled && !token.startsWith('@');

  if (useStrip) {
    // On mobile both UIs are live, so dropping the `@` (which switched us
    // from the picker branch to here) needs to actively close the picker
    // — the picker branch below never runs to do it for us.
    if (pickerOpen.value) closePicker();
    // Strip replaces the @-popup with an always-on suggestion row.
    // Leading '@' is tolerated as muscle-memory but stripped from the query
    // so the prefix matches plain typing. Min length 2 keeps the strip from
    // flashing on every single-letter word.
    const prefix = token.startsWith('@') ? token.slice(1) : token;
    if (prefix.length >= 2) {
      const buf = buffer.value;
      const items =
        buf && active.value ? buildNickStripItems(buf, active.value.networkId, prefix) : [];
      if (items.length > 0) {
        setNickStrip(true, items);
        stripTokenStart = start;
        stripTokenEnd = end;
      } else {
        closeStrip();
      }
    } else {
      closeStrip();
    }
    return;
  }

  if (!token.startsWith('@')) {
    if (pickerOpen.value) closePicker();
    return;
  }
  // Symmetric mobile case — typing `@` after a bare prefix should close the
  // strip the previous keystroke opened.
  if (overlay.nickOpen) closeStrip();
  pickerOpen.value = true;
  pickerQuery.value = token.slice(1);
  pickerTokenStart = start;
  pickerTokenEnd = end;
}

function onPickerSelect(nick: string): void {
  const value = text.value;
  if (pickerTokenStart < 0) {
    closePicker();
    return;
  }
  const before = value.slice(0, pickerTokenStart);
  const after = value.slice(pickerTokenEnd);
  // A nick at the start of a line is being addressed → ': '; mid-sentence
  // gets a bare space. Identical to the mobile strip (onStripSelect). Tab-
  // completion shares the isAtLineStart() check but appends nothing
  // mid-sentence, since it cycles the completion in place.
  const suffix = isAtLineStart(before) ? ': ' : ' ';
  cycling = true;
  text.value = before + nick + suffix + after;
  cycling = false;
  closePicker();
  queueMicrotask(() => {
    const el = inputEl.value;
    if (!el) return;
    const caret = before.length + nick.length + suffix.length;
    el.focus();
    el.setSelectionRange(caret, caret);
  });
}

function onChannelPickerSelect(channel: string): void {
  const value = text.value;
  if (channelPickerTokenStart < 0) {
    closeChannelPicker();
    return;
  }
  const before = value.slice(0, channelPickerTokenStart);
  const after = value.slice(channelPickerTokenEnd);
  // Channels just get a trailing space — there's no "addressing" form like
  // nicks' ': ', and the '#' is already part of the inserted name. The sent
  // `#channel` renders as a clickable join link for the recipient
  // (RenderSegments → openChannel), which is the whole point (issue #154).
  cycling = true;
  text.value = before + channel + ' ' + after;
  cycling = false;
  closeChannelPicker();
  queueMicrotask(() => {
    const el = inputEl.value;
    if (!el) return;
    const caret = before.length + channel.length + 1;
    el.focus();
    el.setSelectionRange(caret, caret);
  });
}

function onStripSelect(nick: string): void {
  const value = text.value;
  if (stripTokenStart < 0) {
    closeStrip();
    return;
  }
  const before = value.slice(0, stripTokenStart);
  const after = value.slice(stripTokenEnd);
  // A nick at the start of a line is being addressed → ': '; mid-sentence
  // gets a bare space (what the old @-menu was missing — task #198). Shares
  // isAtLineStart() with Tab-completion and the desktop picker.
  const suffix = isAtLineStart(before) ? ': ' : ' ';
  cycling = true;
  text.value = before + nick + suffix + after;
  cycling = false;
  closeStrip();
  queueMicrotask(() => {
    const el = inputEl.value;
    if (!el) return;
    const caret = before.length + nick.length + suffix.length;
    el.focus();
    el.setSelectionRange(caret, caret);
  });
}

// Reply action from the message list's action bar: prepend `nick: ` to the
// current draft (unless it's already addressed to them) and focus the
// composer. Mirrors the history-recall focus dance — setInputAndCaretEnd owns
// the `cycling` guard, and the focus()-in-a-microtask matches onHistorySelect
// so iOS raises the keyboard from the originating tap.
function addressInComposer(nick: string): void {
  if (!active.value || !nick) return;
  // A Reply click bypasses the keystroke handlers that normally clear these,
  // and setInputAndCaretEnd suppresses onInput (its `cycling` guard) — so clear
  // them here or a stale Tab-completion / Up-Down history walk would act on the
  // old text afterward. Same reset onHistorySelect does for the same reason.
  resetCompletion();
  resetHistoryNav();
  const prefix = `${nick}: `;
  const cur = text.value;
  const next = cur.startsWith(prefix) ? cur : cur ? `${prefix}${cur}` : prefix;
  setInputAndCaretEnd(next);
  queueMicrotask(() => inputEl.value?.focus());
}

// Tap on the `>` prompt: toggle the recall menu. Opening it closes the other
// suggesters so only one overlay is ever up (mirrors how they close each
// other). Gated on history existing — the prompt button only renders when
// `hasHistory`, but guard anyway in case the list emptied between render and tap.
function toggleHistory(): void {
  if (historyPickerOpen.value) {
    closeHistoryPicker();
    return;
  }
  if (!hasHistory.value) return;
  closePicker();
  closeStrip();
  closeChannelPicker();
  closeEmojiStrip();
  closeColorPicker();
  historyPickerOpen.value = true;
}

// Pick a row: replace the composer outright and drop the caret at the end —
// identical to an Up-arrow recall (reuses setInputAndCaretEnd). The current
// draft is discarded, not stashed; the menu is a deliberate "jump to this past
// line", not a reversible walk. `cycling` inside setInputAndCaretEnd keeps the
// resulting onInput from firing a typing notification or resetting state.
function onHistorySelect(entry: string): void {
  closeHistoryPicker();
  // The menu opens on a tap, bypassing the keystroke handlers that normally
  // clear these — so a pick can land on top of a live Tab-completion session
  // or an in-progress Up/Down walk. setInputAndCaretEnd suppresses onInput
  // (its cycling guard), so clear them here or they'd act on the old text:
  // Tab would keep cycling a stale completion, Down would restore a stale draft.
  resetCompletion();
  resetHistoryNav();
  setInputAndCaretEnd(entry);
  queueMicrotask(() => inputEl.value?.focus());
}

function onInput() {
  if (cycling) return;
  // User edited the recalled line — exit walk mode but keep what they typed.
  // Done before the sendable gate so this still fires on :server: buffers
  // where `/raw` history is just as relevant.
  if (historyIndex !== null) resetHistoryNav();
  // Same rationale: a keystroke dismisses the tap-opened recall menu, and it
  // must fire before the sendable gate so it also closes on :server: buffers
  // (editable but not "sendable"), where the menu can be open over /raw history.
  closeHistoryPicker();
  // Any edit invalidates the "second press confirms" override — otherwise the
  // user could be holding a flood-confirm token from an entirely different
  // draft. Cheap to clear unconditionally.
  pendingSplitConfirm = false;
  // Republish composing state on every keystroke so StatusBar's SPLIT/FLOOD
  // indicator stays live. We do this even on :server: buffers and slash
  // commands (computeChunks handles both — most return 0 chunks).
  const { chunks, isAction } = computeChunks(text.value);
  setComposingState({ chunks, isAction });
  if (!sendable.value || !active.value) return;
  if (completion) resetCompletion();
  // Inline-convert a just-completed `:shortcode:`, then refresh the suggester
  // for whatever shortcode (if any) is still in progress at the caret.
  void maybeConvertShortcode();
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

watch(active, (newActive, oldActive) => {
  resetCompletion();
  closePicker();
  closeStrip();
  closeChannelPicker();
  closeEmojiStrip();
  closeColorPicker();
  closeHistoryPicker();
  resetHistoryNav();
  // A switch between buffers swaps the draft text via the `text` computed,
  // but any unused split-confirm token doesn't transfer — a fresh buffer is
  // a fresh consent decision.
  pendingSplitConfirm = false;
  // Drain any pending debounced flush for the buffer we're leaving so the
  // server's row reflects the latest body before the next tab sees us
  // switching away. flushBuffer is a no-op if nothing is pending.
  if (oldActive) drafts.flushBuffer(oldActive.networkId, oldActive.target);
  if (
    oldActive &&
    (!newActive ||
      oldActive.target !== newActive.target ||
      oldActive.networkId !== newActive.networkId)
  ) {
    endTypingTo(oldActive);
  }
  // Re-evaluate the outgoing-split estimate for the new buffer's draft. The
  // setter-driven onInput path handles this for keystrokes, but a bare
  // switch doesn't run the setter, so StatusBar's SPLIT/FLOOD indicator
  // would otherwise carry over stale state from the previous buffer.
  if (newActive) {
    const { chunks, isAction } = computeChunks(text.value);
    setComposingState({ chunks, isAction });
  } else {
    setComposingState({ chunks: 0, isAction: false });
  }
});

function onPagehide() {
  // Tab close / navigate-away — the WS may already be tearing down, so ship
  // any un-flushed drafts through sendBeacon instead. Idempotent on the
  // server, so a stray pagehide that doesn't actually unload is harmless.
  drafts.flushAllForBeacon();
}

onBeforeUnmount(() => {
  if (active.value) endTypingTo(active.value);
  if (unsubInsert) {
    unsubInsert();
    unsubInsert = null;
  }
  if (typeof window !== 'undefined') window.removeEventListener('pagehide', onPagehide);
  // Overlay state lives in a module-level singleton, so an unmounted
  // MessageInput would otherwise leak its last open strip/picker into the
  // next instance (e.g. switching to system console and back).
  closeStrip();
  closeEmojiStrip();
  closeColorPicker();
});

function insertUrlAtCaret(url: string): void {
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
  queueMicrotask(() => {
    const e2 = inputEl.value;
    if (!e2) return;
    const caret = before.length + inserted.length;
    e2.focus();
    e2.setSelectionRange(caret, caret);
  });
}

let unsubInsert: (() => boolean) | null = null;
onMounted(() => {
  unsubInsert = onInsertUrl(insertUrlAtCaret);
  if (typeof window !== 'undefined') window.addEventListener('pagehide', onPagehide);
  // Route picks from StatusBar's overlay-rendered popovers back to the
  // textarea-mutation logic that owns the draft. Re-registered on every
  // mount so closures bind to the live `text`/`inputEl`.
  setComposerOverlayHandlers({
    onNickSelect: onStripSelect,
    onEmojiSelect,
    onColorApply: onApplyColor,
    onColorReset: onPickReset,
    onColorClose: closeColorPicker,
    onAddress: addressInComposer,
  });
});

function blobFromClipboardItem(item: DataTransferItem): File | null {
  if (!item || !item.type || !item.type.startsWith('image/')) return null;
  const file = item.getAsFile();
  return file || null;
}

function onPaste(e: ClipboardEvent): void {
  if (!sendable.value) return;
  if (settings.effective('uploads.paste.enabled') === false) return;
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    const file = blobFromClipboardItem(item);
    if (file) {
      e.preventDefault();
      uploads.upload(file).catch(() => {
        /* failure visible via status bar */
      });
      return;
    }
  }
}

function onPickFile() {
  fileInputEl.value?.click();
}

function onFileSelected(e: Event): void {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file || !sendable.value) return;
  uploads.upload(file, file.name).catch(() => {});
}

function onDragOver(e: DragEvent): void {
  if (!sendable.value) return;
  if (!Array.from(e.dataTransfer?.types || []).includes('Files')) return;
  dragOver.value = true;
}
function onDragLeave() {
  dragOver.value = false;
}
function onDrop(e: DragEvent): void {
  dragOver.value = false;
  if (!sendable.value) return;
  const file = e.dataTransfer?.files?.[0];
  if (!file || !file.type.startsWith('image/')) return;
  uploads.upload(file, file.name).catch(() => {});
}

defineExpose({
  focus: () => inputEl.value?.focus(),
});

function toastSendFailure(error: string, body: string): void {
  // Translate the small set of ack/error strings into something a person can
  // act on. We keep the failed text in the toast body so the user can copy
  // it; up-arrow also recalls it from local input history.
  const title =
    error === 'disconnected'
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
function commitInput(raw: string, networkId: number, target: string): void {
  inputHistory.add(networkId, target, raw);
  socketSend({ type: 'input-history-add', networkId, target, text: raw });
  // Clear the draft for the buffer the send came FROM, addressed explicitly
  // rather than through `text.value` (whose setter targets whatever buffer is
  // active *now*). A command like `/msg nick text` calls buffers.activate()
  // before we reach here, so writing through `text.value` would clear the new
  // DM's draft and strand the command in the channel's input. See issue #4.
  drafts.setLocal(networkId, target, '');
  // Empty the draft on the server immediately rather than waiting on the
  // debounce — otherwise a quick send + buffer-close race could leave the
  // row with the old body. flushBuffer drains the pending timer.
  drafts.flushBuffer(networkId, target);
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
  closeStrip();
  closeChannelPicker();
  closeEmojiStrip();
  closeColorPicker();
  closeHistoryPicker();
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
      if (flood) {
        // 3+ chunks: offer the upload-as-.txt modal. If they cancel, the
        // already-set pendingSplitConfirm makes the next Send press the
        // override (matching the prior send-again-to-confirm behavior).
        longMessageContent.value = raw;
        longMessageChunks.value = chunks;
        longMessageModalOpen.value = true;
      } else {
        // 2 chunks with chat.allow_split_messages=off: keep the existing
        // toast confirmation — uploading would be overkill for a one-line
        // overflow.
        toasts.push({
          title: `Will split into ${chunks} lines — Send again to confirm`,
          body: 'Enable "Allow auto-split messages" in Settings to send splits without confirming.',
          kind: 'warn',
          ttlMs: 7000,
        });
      }
      return;
    }
  }
  pendingSplitConfirm = false;

  // `//foo` escapes the slash and sends literal `/foo` as a normal message.
  // History keeps the typed `//foo` form so up-arrow round-trips identically.
  const escapedSlash = raw.startsWith('//');
  if (raw.startsWith('/') && !escapedSlash) {
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

  // Rewrite `||spoiler||` into IRC spoiler codes on the way out. History keeps
  // the typed `||…||` form (commitInput is given `raw`), so up-arrow
  // round-trips the editable text rather than raw control codes.
  const wireText = applySpoilerMarkup(escapedSlash ? raw.slice(1) : raw);
  const pending = socketSendWithAck({ type: 'send', networkId, target, text: wireText });
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
  if (!result.ok) toastSendFailure(result.error ?? 'unknown', raw);
}

async function onLongMessageConfirm() {
  if (longMessageUploading.value) return;
  const snapshot = longMessageContent.value;
  longMessageUploading.value = true;
  // Clear input first so the URL emitted by the upload pipeline lands in an
  // empty field — replacing the typed message rather than appending after
  // it. emitInsert → insertUrlAtCaret writes into whatever's currently
  // there, so the clear has to happen before the upload completes.
  text.value = '';
  try {
    await uploads.uploadText(snapshot);
    longMessageModalOpen.value = false;
    // The input is short again (just the URL), so the gate is no longer
    // tripped — clear the override flag so the user's next Send goes
    // through normally.
    pendingSplitConfirm = false;
  } catch (_err) {
    // Restore so the user doesn't lose their typed message. Failure detail
    // is already surfaced via the status bar's upload-failed segment.
    text.value = snapshot;
  } finally {
    longMessageUploading.value = false;
  }
}

function onLongMessageCancel() {
  longMessageModalOpen.value = false;
  // pendingSplitConfirm was set when the modal opened, so a subsequent
  // Send press goes through via the existing send-again override path.
}

// Drop a synthetic, non-persisted info line into the current buffer so the
// user sees the output of client-resolved commands like /help or argument
// validation errors. id-less so pushMessage's replay guard doesn't trip.
function localInfo(networkId: number, target: string, lineText: string): void {
  buffers.pushMessage({
    networkId,
    target,
    type: 'motd',
    text: lineText,
    time: new Date().toISOString(),
  });
}

const HELP_LINES = [
  'commands:',
  '  /me <text>             — emote in the current buffer',
  '  /msg <nick> <text>     — open a DM and send (alias: /query)',
  '  /ns <text>             — message NickServ (e.g. identify <pass>)',
  '  /cs <text>             — message ChanServ',
  '  /join <#chan>          — join a channel',
  '  /part [#chan] [reason] — leave channel (keeps buffer; alias: /leave)',
  '  /close                 — close current buffer (parts if channel)',
  '  /clear [off]           — hide buffer up to now (off = undo, show again)',
  '  /away [message]        — set away across every network (no arg clears)',
  '  /back                  — clear away',
  '  /whois <nick>          — query user info (renders in server buffer)',
  '  /kick <nick> [reason]  — kick from current channel',
  '  /mode <target> <flags> — set modes (target defaults to current channel)',
  '  /topic [text]          — set/clear topic on current channel',
  '  /nick <newnick>        — change your nick',
  '  /quit [reason]         — disconnect from current network',
  '  /reconnect             — reconnect to current network',
  '  /list                  — list channels on current network',
  '  /jitsi                 — start a video call (alias: /talk)',
  '  /ignore [mask]         — list current ignores, or add (nick or nick!user@host)',
  '  /unignore <mask>       — remove an ignore entry',
  '  /raw <line>            — send a raw IRC line (alias: /quote)',
  '  /help                  — this list',
  '  //text                 — send literal "/text" as a message (escape)',
];

function isChannelTarget(t: string): boolean {
  return typeof t === 'string' && t.startsWith('#');
}

function randomRoomId(): string {
  const buf = new Uint8Array(6);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

// Best-effort send for control commands (/join, /raw, /away, ...). Returns
// false if the socket isn't open — so the caller can keep the typed text in
// the input rather than silently swallowing it.
function sendOrToast(payload: Record<string, unknown>, body: string): boolean {
  const ok = socketSend(payload);
  if (!ok) toastSendFailure('disconnected', body);
  return ok;
}

// ACK-tracked send used by anything that puts a visible message into a
// channel/DM (/me, /msg <body>, /jitsi). Same shape as the main submit path:
// returns false synchronously if the socket is closed; otherwise kicks off
// the await and toasts asynchronously on a non-ok ACK.
function ackedSend(payload: Record<string, unknown>, body: string): boolean {
  const pending = socketSendWithAck(payload);
  if (!pending) {
    toastSendFailure('disconnected', body);
    return false;
  }
  pending.then((result) => {
    if (!result.ok) toastSendFailure(result.error ?? 'unknown', body);
    return result;
  });
  return true;
}

function handleCommand(line: string, networkId: number, target: string): boolean {
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
    case 'ns':
    case 'cs': {
      // /ns and /cs are the near-universal shortcuts for messaging NickServ
      // and ChanServ. Route as a raw PRIVMSG rather than a `send` so the body
      // (often `identify <password>`) is never echoed into a buffer and no
      // service DM buffer is forced open.
      const service = cmd.toLowerCase() === 'ns' ? 'NickServ' : 'ChanServ';
      if (!argLine) {
        localInfo(networkId, target, `usage: /${cmd.toLowerCase()} <text> — message ${service}`);
        return true;
      }
      return sendOrToast({ type: 'raw', networkId, line: `PRIVMSG ${service} :${argLine}` }, line);
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
    case 'clear': {
      // /clear            — hide everything currently in the buffer up to now;
      //                     a "cleared at …" divider and an undo affordance
      //                     replace the hidden region.
      // /clear off|undo   — drop the marker so hidden messages reappear.
      const arg = argLine.trim().toLowerCase();
      if (arg === 'off' || arg === 'undo') {
        return sendOrToast({ type: 'unclear-buffer', networkId, target }, line);
      }
      return sendOrToast({ type: 'clear-buffer', networkId, target }, line);
    }
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
      if (!who) {
        localInfo(networkId, target, 'usage: /whois <nick>');
        return true;
      }
      // openViewer kicks the WHOIS itself (issue #92) so we don't double-fire.
      // The modal renders whatever's cached immediately and replaces it when
      // the new whois_result lands.
      useWhoisStore().openViewer(networkId, who);
      return true;
    }
    case 'kick': {
      // /kick <nick> [reason]            (in a channel buffer)
      // /kick <#chan> <nick> [reason]    (anywhere)
      let channel;
      let nick;
      let reason;
      if (rest[0] && rest[0].startsWith('#')) {
        channel = rest[0];
        nick = rest[1];
        reason = rest.slice(2).join(' ');
      } else {
        channel = isChannelTarget(target) ? target : null;
        nick = rest[0];
        reason = rest.slice(1).join(' ');
      }
      if (!channel) {
        localInfo(networkId, target, 'usage: /kick [#chan] <nick> [reason] — no channel context');
        return true;
      }
      if (!nick) {
        localInfo(networkId, target, 'usage: /kick [#chan] <nick> [reason]');
        return true;
      }
      const trailer = reason ? ` :${reason}` : '';
      return sendOrToast(
        { type: 'raw', networkId, line: `KICK ${channel} ${nick}${trailer}` },
        line,
      );
    }
    case 'topic': {
      // /topic                        — request current topic (server buffer)
      // /topic <text>                 — set on current channel
      // /topic <#chan> [text]         — set/get on another channel
      let channel;
      let body;
      if (rest[0] && rest[0].startsWith('#')) {
        channel = rest[0];
        body = line
          .slice(1 + cmd.length)
          .trim()
          .slice(channel.length)
          .trim();
      } else {
        channel = isChannelTarget(target) ? target : null;
        body = argLine;
      }
      if (!channel) {
        localInfo(networkId, target, 'usage: /topic [#chan] [text] — no channel context');
        return true;
      }
      const trailer = body ? ` :${body}` : '';
      return sendOrToast({ type: 'raw', networkId, line: `TOPIC ${channel}${trailer}` }, line);
    }
    case 'nick': {
      const newNick = rest[0];
      if (!newNick) {
        localInfo(networkId, target, 'usage: /nick <newnick>');
        return true;
      }
      return sendOrToast({ type: 'raw', networkId, line: `NICK ${newNick}` }, line);
    }
    case 'mode': {
      // /mode <flags>                  — apply to current channel
      // /mode <target> <flags...>      — apply to target (channel or self)
      if (!rest.length) {
        localInfo(networkId, target, 'usage: /mode [target] <flags> [args]');
        return true;
      }
      const looksLikeFlagsOnly = /^[+-]/.test(rest[0]);
      if (looksLikeFlagsOnly && isChannelTarget(target)) {
        return sendOrToast(
          { type: 'raw', networkId, line: `MODE ${target} ${rest.join(' ')}` },
          line,
        );
      }
      return sendOrToast({ type: 'raw', networkId, line: `MODE ${argLine}` }, line);
    }
    case 'quit': {
      // Route through the intentional-disconnect path (POST .../disconnect →
      // ircManager.stopNetwork → client.quit()), which sets irc-framework's
      // requested_disconnect flag. Sending a raw QUIT line instead leaves that
      // flag unset, so the socket close looks unexpected and auto-reconnects.
      // With no reason given, send none so the server falls back to its
      // default quit message (DEFAULT_QUIT_MESSAGE) — the same line used for
      // an auto-disconnect.
      const reason = argLine || undefined;
      networks.disconnect(networkId, reason).catch((err) => {
        localInfo(networkId, target, `/quit failed: ${err.message || 'could not disconnect'}`);
      });
      return true;
    }
    case 'reconnect':
      // restartNetwork is idempotent: it works whether the network is still
      // connected, mid-reconnect, or fully stopped after /quit.
      networks.reconnect(networkId).catch((err) => {
        localInfo(networkId, target, `/reconnect failed: ${err.message || 'could not reconnect'}`);
      });
      return true;
    case 'list':
      return sendOrToast(
        { type: 'raw', networkId, line: argLine ? `LIST ${argLine}` : 'LIST' },
        line,
      );
    case 'ignore': {
      // No-arg form: dump the current network's ignore list into the active
      // buffer as system messages. The store already has the list (seeded
      // from the snapshot, kept fresh by ignore-list-updated), so this is a
      // purely client-side read — no server roundtrip.
      const mask = argLine.trim();
      if (!mask) {
        const list = ignores.masksFor(networkId);
        if (!list.length) {
          localInfo(networkId, target, 'ignore list is empty on this network.');
        } else {
          localInfo(networkId, target, `ignore list (${list.length}):`);
          for (const entry of list) localInfo(networkId, target, `  ${entry.mask}`);
        }
        return true;
      }
      ignores.addMask(networkId, mask);
      return true;
    }
    case 'unignore': {
      const mask = argLine.trim();
      if (!mask) {
        localInfo(networkId, target, 'usage: /unignore <mask>');
        return true;
      }
      ignores.removeMask(networkId, mask);
      return true;
    }
    case 'jitsi':
    case 'talk': {
      if (isServer.value) {
        localInfo(networkId, target, 'usage: /jitsi — run inside a channel or DM');
        return true;
      }
      const url = `https://meet.jit.si/lurker-${randomRoomId()}`;
      return ackedSend({ type: 'send', networkId, target, text: url }, url);
    }
    case 'help':
      for (const helpLine of HELP_LINES) localInfo(networkId, target, helpLine);
      return true;
    default:
      return sendOrToast({ type: 'raw', networkId, line: line.slice(1) }, line);
  }
}
</script>

<style scoped>
.input {
  display: flex;
  /* flex-start so the prompt label and upload button stay pinned to the
     first line as the textarea grows downward across multiple lines. */
  align-items: flex-start;
  gap: 1ch;
  padding: var(--space-4) var(--space-6);
  /* Containing block for the desktop NickPicker's anchor logic — the
     position:fixed picker still reads coordinates off the form. */
  position: relative;
}
.input.drag-over {
  outline: 1px dashed var(--accent);
  outline-offset: -4px;
}
.prompt {
  color: var(--accent);
  white-space: pre;
  user-select: none;
  /* Matches the textarea's intrinsic single-row height so the prompt and
     the first text line baseline-align before any growth. */
  line-height: 1.4;
}
.prompt .away {
  color: var(--warn);
}
/* The `>` glyph doubles as the recall-menu toggle (issue #204). It stays a
   bare glyph visually; the tap target is enlarged by a pseudo-element so the
   hit box grows without any negative-margin reflow that could nudge the input
   row height or the first-line baseline. */
.prompt-recall {
  position: relative;
  cursor: pointer;
  /* Disables the iOS double-tap-zoom heuristic and its ~300ms click delay. */
  touch-action: manipulation;
}
.prompt-recall::before {
  content: '';
  position: absolute;
  /* Expand the hittable area on all sides. The rightward bleed lands under the
     textarea (a later sibling that paints on top), so it never steals caret
     taps; the upward bleed sits below the StatusBar's suggestion strip, which
     is z-raised and wins any overlap. */
  top: -10px;
  bottom: -10px;
  left: -10px;
  right: -8px;
}
.upload-btn {
  background: none;
  border: none;
  color: var(--fg-muted);
  cursor: pointer;
  padding: 0 var(--space-1);
  font-size: inherit;
  line-height: 1.4;
}
.upload-btn:hover:not(:disabled) {
  color: var(--accent);
}
.upload-btn:disabled {
  opacity: 0.4;
  cursor: default;
}
.format-btn {
  color: var(--fg-muted);
  cursor: pointer;
  padding: 0 var(--space-1);
  line-height: 1.4;
  user-select: none;
  /* Avoids iOS double-tap-zoom delay so the picker opens promptly on touch. */
  touch-action: manipulation;
}
.format-btn:hover:not(.disabled) {
  color: var(--accent);
}
.format-btn.disabled {
  opacity: 0.4;
  cursor: default;
}
.file-hidden {
  display: none;
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
  /* Native content-driven sizing: the browser grows/shrinks the textarea
     in a single layout pass with content height baked in, so siblings
     (the message-list) never see a transient 'auto' state. max-height
     caps growth at 16 rows; beyond that it scrolls internally. min-height
     locks the empty/initial size to exactly one rendered line at this
     line-height so the row doesn't shift the moment a first character
     lands — `field-sizing: content` otherwise switches from the browser's
     intrinsic `rows="1"` height to the content-derived height on first
     keystroke, and the two can disagree by ~1px. */
  field-sizing: content;
  min-height: 1.4em;
  max-height: calc(1.4em * 16);
}
textarea:focus {
  outline: none;
}
textarea::placeholder {
  color: var(--fg-muted);
  font-style: italic;
}
</style>
