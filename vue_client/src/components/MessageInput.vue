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
        >{{ promptLabelNoModes }}<span v-if="promptModes" class="modes">{{ promptModes }}</span
        ><span v-if="awayLabel" class="away">&nbsp;{{ awayLabel }}</span
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
      :disabled="(!active && !isSystemBuffer) || isPaused"
      :spellcheck="systemFeatures.spellcheck"
      :autocorrect="systemFeatures.autocorrect"
      :autocapitalize="systemFeatures.autocapitalize"
      @keydown="onKeydown"
      @paste="onPaste"
      @blur="onBlur"
    ></textarea>
    <button
      type="button"
      class="send-btn"
      :disabled="!canCompose || !hasComposerContent"
      title="send message"
      @mousedown.prevent
      @click="submit"
    >
      <i class="fa-solid fa-circle-arrow-up"></i>
    </button>
    <input
      ref="fileInputEl"
      type="file"
      accept="image/*"
      class="file-hidden"
      @change="onFileSelected"
    />
    <input
      ref="e2eImportInputEl"
      type="file"
      accept=".json,application/json"
      class="file-hidden"
      @change="onE2eImportFile"
    />
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
      ref="historyPickerEl"
      :open="historyPickerOpen"
      :entries="historyEntries"
      :anchor="formEl"
      :toggle-el="promptBtnEl"
      @select="onHistorySelect"
      @close="closeHistoryPicker"
    />
    <!-- Desktop `:shortcode:` emoji panel (issue #348). The vertical-popover
         counterpart to the mobile emoji strip — refreshPicker opens this on
         desktop and the StatusBar strip on mobile. Opens on a bare `:` with a
         frequently-used set, then filters as you type. -->
    <EmojiPicker
      ref="emojiPickerEl"
      :open="emojiPickerOpen"
      :query="emojiPickerQuery"
      :anchor="formEl"
      @select="onEmojiSelect"
      @close="closeEmojiPicker"
    />
    <Teleport to="body">
      <LongMessageUploadModal
        v-if="longMessageModalOpen"
        :content="longMessageContent"
        :chunks="longMessageChunks"
        :multiline="longMessageMultiline"
        :uploading="longMessageUploading"
        @confirm="onLongMessageConfirm"
        @cancel="onLongMessageCancel"
      />
    </Teleport>
  </form>
</template>

<script setup lang="ts">
import { ref, computed, watch, onBeforeUnmount, onMounted, nextTick } from 'vue';
import { useNetworksStore, type Network } from '../stores/networks.js';
import { SYSTEM_KEY } from '../lib/virtualBuffers.js';
import { parseNetworkCommand } from '../lib/commands/network.js';
import { splitSetArgs, coerceSettingValue, formatSettingValue } from '../lib/commands/settings.js';
import { parseRelayCommand } from '../lib/commands/relay.js';
import { parseDccCommand } from '../lib/commands/dcc.js';
import { formatColumns } from '../lib/commands/output.js';
import { REGISTRY, getOption, optionVisible, CATEGORIES } from '../utils/settingsRegistry.js';
import type { SettingOption } from '../../../shared/settingsRegistry.js';
import { useConfigStore } from '../stores/config.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useAuthStore } from '../stores/auth.js';
import { useInputHistoryStore } from '../stores/inputHistory.js';
import { useDraftStore } from '../stores/drafts.js';
import { useSettingsStore } from '../stores/settings.js';
import { useUploadsStore, onInsertUrl } from '../stores/uploads.js';
import { useDccStore, percentReceived, type DccTransfer } from '../stores/dcc.js';
import { useToastsStore } from '../stores/toasts.js';
import { useIgnoresStore, type IgnoreEntry } from '../stores/ignores.js';
import { useRelayBotsStore } from '../stores/relayBots.js';
import { useHighlightRulesStore, type HighlightRule } from '../stores/highlightRules.js';
import { parseIgnoreArgs } from '../../../shared/parseIgnore.js';
import { parseHighlightArgs } from '../../../shared/parseHighlight.js';
import { highlightRuleDetailParts } from '../utils/highlightFormat.js';
import { useWhoisStore } from '../stores/whois.js';
import { useChanlistStore } from '../stores/chanlist.js';
import { useChannelListModal } from '../composables/useChannelListModal.js';
import { socketSend, socketSendWithAck } from '../composables/useSocket.js';
import { requestScrollToBottom } from '../composables/useScrollState.js';
import { setComposingState } from '../composables/useComposing.js';
import {
  chunkCountForSay,
  chunkCountForAction,
  multilineMessageCount,
  type MultilineLimits,
} from '../utils/messageSplit.js';
import { applySpoilerMarkup } from '../utils/spoilerMarkup.js';
import { buildNickCandidates } from '../utils/nickCompletion.js';
import { buildChannelCandidates } from '../utils/channelCompletion.js';
import { ensureChannelPrefix } from '../utils/channelTarget.js';
import {
  findActiveShortcode,
  findCompletedShortcode,
  loadEmoji,
} from '../utils/emojiShortcodes.js';
import type { EmojiMatch } from '../utils/emojiData.js';
import NickPicker from './NickPicker.vue';
import ChannelPicker from './ChannelPicker.vue';
import HistoryPicker from './HistoryPicker.vue';
import EmojiPicker from './EmojiPicker.vue';
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
const config = useConfigStore();
const uploads = useUploadsStore();
const dcc = useDccStore();
const toasts = useToastsStore();
const ignores = useIgnoresStore();
const relayBots = useRelayBotsStore();
const highlightRules = useHighlightRulesStore();
const chanlist = useChanlistStore();
const channelListModal = useChannelListModal();
const nickColors = useNickColors();

// The ignore rules visible from this network, in /ignore-listing order: globals
// first (scope null), then this network's own (scope = networkId). The index a
// user sees in /ignore maps 1:1 to this array, so /unignore <n> resolves the
// right rule and its scope.
function combinedIgnores(networkId: number | null): { entry: IgnoreEntry; scope: number | null }[] {
  const globals = ignores.global.map((entry) => ({ entry, scope: null as number | null }));
  // The app-scoped system buffer has no network, so only global rules are
  // visible there.
  if (networkId == null) return globals;
  const own = ignores
    .masksFor(networkId)
    .map((entry) => ({ entry, scope: networkId as number | null }));
  return [...globals, ...own];
}

// Highlight rules visible from this network, in /highlight-listing order: globals
// first (scope null), then this network's own (scope = networkId). Mirrors
// combinedIgnores so /unhighlight <n> maps 1:1 to the listed index. Auto-managed
// (network-nick) rules are network-scoped, so they appear in the own section.
function combinedHighlights(
  networkId: number | null,
): { entry: HighlightRule; scope: number | null }[] {
  const globals = highlightRules.rules
    .filter((r) => r.networkIds.length === 0)
    .map((entry) => ({ entry, scope: null as number | null }));
  if (networkId == null) return globals;
  const own = highlightRules.rules
    .filter((r) => r.networkIds.includes(networkId))
    .map((entry) => ({ entry, scope: networkId as number | null }));
  return [...globals, ...own];
}
const inputEl = ref<HTMLTextAreaElement | null>(null);
const formEl = ref<HTMLElement | null>(null);
const fileInputEl = ref<HTMLInputElement | null>(null);
const e2eImportInputEl = ref<HTMLInputElement | null>(null);
const e2eImportNetworkId = ref<number | null>(null);
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
const historyPickerEl = ref<InstanceType<typeof HistoryPicker> | null>(null);
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
// Desktop `:` emoji picker (issue #348) — the vertical-popover counterpart to
// the mobile strip. Like the nick/channel pickers it's a position:fixed popover
// anchored to the form, so its open/query state lives here; the mobile strip
// keeps using the useComposerOverlay emoji state. refreshPicker routes to one or
// the other by platform, and both share the emojiToken{Start,End} span above.
const emojiPickerOpen = ref(false);
const emojiPickerQuery = ref('');
const emojiPickerEl = ref<InstanceType<typeof EmojiPicker> | null>(null);

const active = computed(() => networks.activeBuffer);

// The app-scoped system buffer (issue #355) has no network, so networks
// .activeBuffer reports null for it. It accepts slash commands, not chat, so it
// gets a local-only input ref rather than a server-synced per-buffer draft (no
// network to key a draft row to, and command typing needn't sync cross-device).
const isSystemBuffer = computed(() => networks.activeKey === SYSTEM_KEY);
const systemText = ref('');

// Input contents are server-side per-buffer drafts — switching channels swaps
// the input bar's body to that buffer's draft (or empty). v-model writes go
// through the setter, which records the optimistic local update and schedules
// a debounced WS flush; the typing-state side effects in onInput run here
// (not in a watch(text)) so remote `draft-updated` echoes from other tabs
// don't fire fake "active" typing notifications. The system buffer routes to
// its local ref instead.
const text = computed({
  get() {
    if (isSystemBuffer.value) return systemText.value;
    const a = active.value;
    return a ? drafts.forBuffer(a.networkId, a.target) : '';
  },
  set(value) {
    if (isSystemBuffer.value) {
      systemText.value = value;
      return;
    }
    const a = active.value;
    if (!a) return;
    drafts.setLocal(a.networkId, a.target, value);
    onInput();
  },
});
// Firefox (desktop + mobile) doesn't support CSS `field-sizing: content` (#336),
// so the native content-driven grow leaves the composer stuck at rows="1". Wire
// a JS measure-and-set fallback ONLY where it's needed — Chrome/Safari keep the
// native single-pass path and register nothing, so there's no per-keystroke
// microtask on the browsers that don't need it.
const supportsFieldSizing =
  typeof CSS !== 'undefined' &&
  typeof CSS.supports === 'function' &&
  CSS.supports('field-sizing', 'content');

if (!supportsFieldSizing) {
  const autosizeInput = (): void => {
    const el = inputEl.value;
    if (!el) return;
    // Reset, then lock to the content height — done synchronously so the browser
    // never paints the transient one-row state. CSS max-height + overflow-y:auto
    // cap growth at 16 rows and scroll beyond it.
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  };
  // Re-measure whenever the visible text changes — typing (the v-model setter),
  // programmatic edits (history recall, send-clear), and buffer switches that
  // swap in a different draft (the getter changes without firing the setter).
  watch(text, () => nextTick(autosizeInput));
  onMounted(() => nextTick(autosizeInput));
}

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
// `sendable` gates network sends (PRIVMSG, typing). The system buffer takes
// commands with no network, so it's never `sendable` — gate the composer's
// enabled state on this instead, which also lights up for the system buffer
// (unless the account is paused / read-only).
const canCompose = computed(() => sendable.value || (isSystemBuffer.value && !isPaused.value));
// #366: the Send button stays disabled until there's something to send — any
// non-whitespace in the composer (slash commands count). Mirrors submit()'s own
// `!raw.trim()` bail; canCompose gates buffer/pause state on top of this.
const hasComposerContent = computed(() => text.value.trim().length > 0);
const placeholder = computed(() => {
  if (isPaused.value) return 'Account paused — read only';
  if (isSystemBuffer.value) return 'try /commands';
  const a = active.value;
  if (!a) return 'Select a buffer';
  // `/raw <line>` was cryptic; `/commands` is the discoverable entry point and
  // the server buffer is exactly where someone goes looking for it.
  if (isServer.value) return 'try /commands';
  // Mobile shows network/channel in the compact status bar now, so the
  // placeholder carries the self identity (nick + channel-prefix) instead, with
  // the away marker appended when set. User modes are dropped here to match the
  // compact status bar hiding channel modes on narrow screens; the desktop
  // prompt still renders them. Desktop keeps `try /commands` since the prompt
  // already shows the identity there.
  if (isMobile.value) {
    const self = promptLabelNoModes.value;
    return awayLabel.value ? `${self} ${awayLabel.value}` : self;
  }
  return 'try /commands';
});
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
// Prompt identity (nick + channel prefix, then user modes) and away marker —
// see useSelfLabel. The nick and the user-mode parens come back separately so
// the prompt can accent-colour the nick but mute the modes (issue #415). On
// mobile we don't render the prompt label inline here (the template gates it on
// !isMobile so the input row stays just `>` + composer); instead the modeless
// variant feeds the placeholder above, since the compact status bar now shows
// network/channel rather than the self identity.
const { promptLabelNoModes, promptModes, awayLabel } = useSelfLabel();
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
// Whether the flooding draft will go as draft/multiline batches (messages) vs
// raw wire lines — flips the modal's wording. (#381)
const longMessageMultiline = ref(false);
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

// Whether the active network advertised draft/multiline limits. Drives the
// multiline-aware split gating below. (#381)
function currentMultilineLimits(): MultilineLimits | null {
  const nid = active.value?.networkId;
  if (nid == null) return null;
  return networks.states[nid]?.multilineLimits ?? null;
}

// How many draft/multiline messages `raw` will become on this network: 0 when
// it won't be a multiline send (a slash command, /me, no newline, or the
// network lacks the cap), 1 for a single batch, ≥2 for that many logical
// messages. Mirrors the server partition in ircManager.send so the indicator
// and the upload-as-.txt gate count messages-the-channel-sees, not raw wire
// lines. (#381)
function multilineCountFor(raw: string): number {
  const isPlainSend = !raw.startsWith('/') || raw.startsWith('//');
  if (!isPlainSend) return 0;
  const wireBody = applySpoilerMarkup(raw.startsWith('//') ? raw.slice(1) : raw);
  return multilineMessageCount(wireBody, currentMultilineLimits());
}

// Recompute and broadcast the composing state (drives StatusBar). Single source
// for the live keystroke path and the bare buffer-switch so both stay in sync.
// On a multiline network `chunks` carries the batch (message) count and
// `multiline` is set; otherwise it's the legacy wire-PRIVMSG estimate.
function publishComposing(raw: string): void {
  const batches = multilineCountFor(raw);
  if (batches > 0) {
    setComposingState({ chunks: batches, isAction: false, multiline: true });
    return;
  }
  const { chunks, isAction } = computeChunks(raw);
  setComposingState({ chunks, isAction, multiline: false });
}

function sendTyping(networkId: number, target: string, state: string): void {
  if (!settings.effective('chat.send_typing_notifications')) return;
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

// Walk input history. Called only after the browser's native arrow move left
// the caret unchanged (nothing above it for Up / below it for Down — see the
// arrow handling in onKeydown), so within a multi-line OR a soft-wrapped draft
// the arrows move the caret between rows first and only fall through to history
// at the true top/bottom (#367). No preventDefault: the native move already ran
// and didn't move the caret, so we just swap the draft.
function walkHistory(key: 'ArrowUp' | 'ArrowDown'): void {
  if (!active.value) return;
  const { networkId, target } = active.value;
  const list = inputHistory.forBuffer(networkId, target);
  if (!list.length) return;
  resetCompletion();
  closePicker();
  closeStrip();
  closeChannelPicker();

  if (key === 'ArrowUp') {
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
  closeEmojiPicker();
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

// Soft-wrapped composer treated as a paragraph editor — see the Home/End block
// in onKeydown (issue #234). Pure string math: the logical line is the run of
// text between newlines surrounding `pos`.
function logicalLineStart(value: string, pos: number): number {
  // lastIndexOf with fromIndex -1 (pos === 0) returns -1, so this lands on 0.
  return value.lastIndexOf('\n', pos - 1) + 1;
}
function logicalLineEnd(value: string, pos: number): number {
  const nl = value.indexOf('\n', pos);
  return nl === -1 ? value.length : nl;
}

// Detection mirrors KeyboardHelpModal.vue — used to gate the Cmd+←/→ caret keys
// to macOS so we don't hijack Super/Win+Arrow on other platforms.
const isMac =
  typeof navigator !== 'undefined' &&
  /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent || '');

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
        nickPickerEl.value.moveActive(e.key === 'ArrowUp' ? -1 : 1);
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
        channelPickerEl.value.moveActive(e.key === 'ArrowUp' ? -1 : 1);
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
  // Desktop emoji picker (issue #348): while open with candidates it owns the
  // nav keys — arrows move the highlight, Tab/Enter confirm; Escape is left to
  // the popover's own document listener. Mobile uses the emoji-strip block
  // above instead (the two are never open at once). Shift+Enter still newlines.
  if (emojiPickerOpen.value && !e.isComposing && emojiPickerEl.value?.hasCandidates()) {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      if (!e.altKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        emojiPickerEl.value.moveActive(e.key === 'ArrowUp' ? -1 : 1);
        return;
      }
    } else if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
      e.preventDefault();
      emojiPickerEl.value.confirmActive();
      return;
    }
  }
  // The previous-input recall menu (the `>` prompt's popover) owns the nav keys
  // while it's open with entries: arrows move the highlighted line, Tab or Enter
  // recall it into the composer, Escape is left to the popover's own document
  // listener. This runs ahead of the inline Up/Down history walk and Enter-
  // submit below, so an open menu takes precedence over walking history in
  // place. Gated on hasCandidates() like the nick/channel pickers; skipped
  // mid-IME. Shift+Enter still newlines.
  if (historyPickerOpen.value && !e.isComposing && historyPickerEl.value?.hasCandidates()) {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      if (!e.altKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        historyPickerEl.value.moveActive(e.key === 'ArrowUp' ? -1 : 1);
        return;
      }
    } else if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
      e.preventDefault();
      historyPickerEl.value.confirmActive();
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
    // Bare arrows only — Alt+Arrow is buffer navigation (useKeyboardShortcuts),
    // and Shift+Arrow extends the selection; neither should hijack history.
    if (e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
    // Leave the arrows to an active IME — they navigate its candidate window.
    if (e.isComposing) return;
    const el = inputEl.value;
    // Only consider history with a collapsed caret (no selection). Don't
    // preventDefault — let the browser move the caret natively first. That
    // handles soft-wrapped rows AND \n lines correctly, with no fragile mirror
    // measurement. On the next frame, if the caret didn't move (nothing above it
    // for Up / below it for Down), walk input history (#367).
    if (el && el.selectionStart === el.selectionEnd) {
      const before = el.selectionStart ?? 0;
      const key = e.key;
      requestAnimationFrame(() => {
        if (el.isConnected && el.selectionStart === before && el.selectionEnd === before) {
          walkHistory(key);
        }
      });
    }
    return;
  }
  // Home / End — and the macOS Cmd+←/→ equivalents — jump the caret to the
  // logical-line edge (text between newlines), not the visual wrap row the
  // browser picks by default. A chat message is the unit of thought, so landing
  // at the start/end of *your line* beats landing at an incidental soft-wrap
  // (issue #234). The two only differ when one logical line wraps; short
  // messages are unaffected. Shift extends from the existing anchor. Mac-gated
  // for the Cmd variant so we don't grab Super/Win+Arrow. Only *bare* Home/End
  // are remapped (Shift still extends) — Ctrl/Alt/Meta+Home/End stay native so
  // Ctrl+Home/End still jumps to the document ends on Windows/Linux, alongside
  // Cmd+↑/↓ (whole draft) and Option/Ctrl+arrows (word / emacs). Skipped mid-IME
  // so the keys keep driving the candidate window.
  const bareHomeEnd =
    (e.key === 'Home' || e.key === 'End') && !e.ctrlKey && !e.altKey && !e.metaKey;
  const macCmdArrow =
    isMac &&
    e.metaKey &&
    !e.altKey &&
    !e.ctrlKey &&
    (e.key === 'ArrowLeft' || e.key === 'ArrowRight');
  if (!e.isComposing && (bareHomeEnd || macCmdArrow)) {
    const el = inputEl.value;
    if (el) {
      e.preventDefault();
      // Caret moved — drop any in-progress Tab-completion cycle.
      if (completion) resetCompletion();
      const toStart = e.key === 'Home' || e.key === 'ArrowLeft';
      const value = el.value;
      const dir = el.selectionDirection;
      const selStart = el.selectionStart ?? 0;
      const selEnd = el.selectionEnd ?? 0;
      // The edge that moves is the active one; for a collapsed caret both ends
      // coincide. selectionDirection is 'backward' only after a leftward grow.
      const activeEdge = dir === 'backward' ? selStart : selEnd;
      const target = toStart
        ? logicalLineStart(value, activeEdge)
        : logicalLineEnd(value, activeEdge);
      if (e.shiftKey) {
        // Extend: pin the non-active anchor, move the active edge to target —
        // flipping direction if the active edge crosses the anchor.
        const anchor = dir === 'backward' ? selEnd : selStart;
        el.setSelectionRange(
          Math.min(anchor, target),
          Math.max(anchor, target),
          target < anchor ? 'backward' : 'forward',
        );
      } else {
        el.setSelectionRange(target, target);
      }
    }
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

function closeEmojiPicker() {
  emojiPickerOpen.value = false;
  emojiPickerQuery.value = '';
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
    closeEmojiPicker();
    return;
  }
  const before = value.slice(0, sc.start);
  const after = value.slice(sc.end);
  cycling = true;
  text.value = before + item.emoji + after;
  cycling = false;
  closeEmojiStrip();
  closeEmojiPicker();
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
  // token, and both emoji UIs and the nick picker/strip share one slot over the
  // StatusBar. Both the desktop EmojiPicker (issue #348) and the mobile strip
  // wait for a 2+ character query before opening, so a lone `:` or a one-char
  // emoticon like `:D` / `:P` never pops the suggester — and Enter never
  // silently swaps it for an emoji (issue #402).
  const emojiOnStrip = isMobile.value;
  const shortcode = findActiveShortcode(value, cursor);
  if (shortcode && shortcode.name.length >= 2) {
    closePicker();
    closeStrip();
    closeChannelPicker();
    if (emojiOnStrip) {
      closeEmojiPicker();
      void showEmojiStrip();
    } else {
      closeEmojiStrip();
      emojiPickerOpen.value = true;
      emojiPickerQuery.value = shortcode.name;
      emojiTokenStart = shortcode.start;
      emojiTokenEnd = shortcode.end;
    }
    return;
  }
  closeEmojiStrip();
  closeEmojiPicker();

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
  closeEmojiPicker();
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
  publishComposing(text.value);
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
  closeEmojiPicker();
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
    publishComposing(text.value);
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
  closeEmojiPicker();
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
    onPickFile,
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

// `/e2e import` flow: read the chosen export file, confirm (it's destructive and
// can change the account identity), then ship the JSON for the cell to validate
// and replace the keyring. The networkId is carried from the command invocation.
function onE2eImportFile(e: Event): void {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  const networkId = e2eImportNetworkId.value;
  e2eImportNetworkId.value = null;
  if (!file || networkId == null) return;
  // Reject an oversized file before reading it (the server enforces the same cap;
  // this just fails fast without freezing the tab on a huge/wrong file).
  if (file.size > 4 * 1024 * 1024) {
    toasts.push({
      kind: 'error',
      title: 'E2E import failed',
      body: 'that file is too large to be a keyring export',
    });
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const json = String(reader.result ?? '');
    const ok = window.confirm(
      'Import E2E keyring?\n\n' +
        'This REPLACES this network’s encryption keyring (peers, sessions, settings) ' +
        'and resets your account identity on ALL networks. It cannot be undone.',
    );
    if (!ok) return;
    sendOrToast({ type: 'e2e-import', networkId, json }, 'e2e import');
  };
  reader.onerror = () => {
    toasts.push({ kind: 'error', title: 'E2E import failed', body: 'could not read the file' });
  };
  reader.readAsText(file);
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
  closeEmojiPicker();
  closeColorPicker();
  closeHistoryPicker();
  const raw = text.value;
  if (!raw.trim()) return;

  // System buffer (issue #355): app-scoped, no network. It's a command surface,
  // not a chat target — slash commands run through the same dispatcher with a
  // null network, plain text has nowhere to send. Handled before the
  // network-bound path below (which needs active.value).
  if (isSystemBuffer.value && !active.value) {
    if (isPaused.value) return;
    const escaped = raw.startsWith('//');
    if (raw.startsWith('/') && !escaped) {
      handleCommand(raw, null, SYSTEM_KEY);
    } else {
      localInfo(null, SYSTEM_KEY, 'Not a command — type /commands to see what you can run here.');
    }
    systemText.value = '';
    resetHistoryNav();
    requestScrollToBottom();
    return;
  }

  if (!active.value) return;
  const { networkId, target } = active.value;

  // Outgoing-flood gate, measured in messages-the-channel-sees: on a multiline
  // network that's the draft/multiline batch count (a big paste is N logical
  // messages, not N raw lines); elsewhere it's the wire-PRIVMSG split estimate.
  // Three tiers:
  //   - /me over one line: hard block (CTCP ACTION can't reasonably split)
  //   - 3+ messages: offer the upload-as-.txt modal (flood)
  //   - 2 messages: gated by chat.allow_split_messages (off → require a second
  //     Send press; on → send silently)
  // computeChunks()/multilineCountFor() return 0 for slash commands we don't
  // route through PRIVMSG, so /join, /raw, etc. fall right through. A draft that
  // fits one multiline batch is exactly one message and skips the gate. (#381)
  const { chunks: wireChunks, isAction } = computeChunks(raw);
  const batches = multilineCountFor(raw);
  const multiline = batches > 0;
  const count = multiline ? batches : wireChunks;
  if (isAction && wireChunks > 1) {
    toasts.push({
      title: 'Action message too long',
      body: "Actions can't be split across IRC lines — shorten it and try again.",
      kind: 'error',
      ttlMs: 6000,
    });
    return;
  }
  if (count > 1) {
    const flood = count >= 3;
    const allowSplit = !!settings.effective('chat.allow_split_messages');
    const blocked = flood || !allowSplit;
    if (blocked && !pendingSplitConfirm) {
      pendingSplitConfirm = true;
      if (flood) {
        // 3+ messages: offer the upload-as-.txt modal. If they cancel, the
        // already-set pendingSplitConfirm makes the next Send press the
        // override (matching the prior send-again-to-confirm behavior).
        longMessageContent.value = raw;
        longMessageChunks.value = count;
        longMessageMultiline.value = multiline;
        longMessageModalOpen.value = true;
      } else {
        // 2 messages with chat.allow_split_messages=off: keep the existing
        // toast confirmation — uploading would be overkill for a two-message
        // send.
        toasts.push({
          title: multiline
            ? `Will send as ${count} messages — Send again to confirm`
            : `Will split into ${count} lines — Send again to confirm`,
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
// user sees the output of client-resolved commands like /commands or argument
// validation errors. id-less so pushMessage's replay guard doesn't trip.
// networkId null targets the app-scoped system buffer (issue #355).
function localInfo(networkId: number | null, target: string, lineText: string): void {
  buffers.pushMessage({
    networkId,
    target,
    type: 'motd',
    text: lineText,
    time: new Date().toISOString(),
  });
}

// "*zzz*  [global]  NICKS  #chan  [except]" — the rule's dimensions, no index.
// `global` tags rules that apply on every network (vs. this network's own).
function summarizeIgnoreEntry(entry: IgnoreEntry, global = false): string {
  const parts: string[] = [entry.mask ?? '*'];
  if (global) parts.push('[global]');
  if (entry.levels?.length) parts.push(entry.levels.join(','));
  if (entry.channels?.length) parts.push(entry.channels.join(','));
  if (entry.pattern) {
    parts.push(entry.patternKind === 'regex' ? `/${entry.pattern}/` : `"${entry.pattern}"`);
  }
  if (entry.isExcept) parts.push('[except]');
  if (entry.expiresAt) parts.push(`(expires ${entry.expiresAt})`);
  return parts.join('  ');
}

// One indexed line for the /ignore listing: "  2. *zzz*  [global]  NICKS  #chan".
function formatIgnoreEntry(entry: IgnoreEntry, idx: number, global = false): string {
  return `  ${idx}. ${summarizeIgnoreEntry(entry, global)}`;
}

// "QUACK! · whole word · #chan" — a highlight rule's dimensions, no index. The
// subject (mask/pattern) and scope are framed here; the secondary descriptors
// come from the shared formatter the settings pane also uses.
function summarizeHighlightEntry(entry: HighlightRule, global = false): string {
  const subject = entry.mask ? `${entry.mask} (mask)` : (entry.pattern ?? '*');
  const parts = [subject];
  if (global) parts.push('global');
  parts.push(...highlightRuleDetailParts(entry));
  return parts.join(' · ');
}

// One indexed line for the /highlight listing.
function formatHighlightEntry(entry: HighlightRule, idx: number, global = false): string {
  return `  ${idx}. ${summarizeHighlightEntry(entry, global)}`;
}

const COMMANDS_LINES = [
  'commands:',
  '  /me <text>             — emote in the current buffer',
  '  /slap <nick>           — slap someone around a bit with a large trout',
  '  /msg <nick> <text>     — open a DM and send (alias: /query)',
  '  /notice <tgt> <text>   — send a NOTICE to a channel or nick',
  '  /ns <text>             — message NickServ (e.g. identify <pass>)',
  '  /cs <text>             — message ChanServ',
  '  /join <#chan>          — join a channel',
  '  /part [#chan] [reason] — leave channel (keeps buffer; alias: /leave)',
  '  /close                 — close current buffer (parts if channel)',
  '  /clear [off]           — hide buffer up to now (off = undo, show again)',
  '  /away [message]        — set away across every network (no arg clears)',
  '  /back                  — clear away',
  '  /whois <nick>          — query user info (renders in server buffer)',
  '  /ctcp <nick> <type>    — CTCP query (VERSION/PING/TIME/CLIENTINFO/SOURCE)',
  '  /ping [nick]           — CTCP ping a user for round-trip latency',
  '  /kick <nick> [reason]  — kick from current channel',
  '  /kickban <nick> [msg]  — kick and ban in one step',
  '  /op <nick…>            — give op (also /deop /voice /devoice /halfop /dehalfop)',
  '  /ban <nick|mask>       — ban (also /unban /quiet /unquiet)',
  '  /cycle [reason]        — part and rejoin this channel (alias: /hop)',
  '  /mode <target> <flags> — set modes (target defaults to current channel)',
  '  /topic [text]          — set/clear topic on current channel',
  '  /nick <newnick>        — change your nick',
  '  /quit [reason]         — disconnect from current network',
  '  /reconnect             — reconnect to current network',
  '  /list                  — list channels on current network',
  '  /who [mask]            — find users (also /whowas /userhost /ison /names)',
  '  /motd /version /time   — server info (also /admin /info /lusers /links /map /stats /help)',
  '  /jitsi                 — start a video call (alias: /talk)',
  '  /ignore [opts] [mask|#chan] [LEVELS] — list, or add an ignore rule (global by default)',
  '      opts: -network -regexp -full -pattern <text> -except -time <dur>',
  '      LEVELS: ALL PUBLIC MSGS NOTICES ACTIONS JOINS PARTS QUITS NICKS KICKS MODES TOPICS NOHIGHLIGHT',
  '      e.g. /ignore bob NOHIGHLIGHT   ·   /ignore -network -regexp -pattern (foo|bar) #chan',
  '  /unignore <index|mask> — remove an ignore (index from /ignore list)',
  '  /highlight [opts] <text> — list, or add a highlight rule (global by default; alias: /hilight)',
  '      opts: -network -mask -full -regexp -matchcase -channels <#a,#b>',
  '      e.g. /highlight QUACK!   ·   /highlight -mask bob!*@*   ·   /highlight -network -regexp qu+ack',
  '  /unhighlight <index|text> — remove a highlight (index from /highlight list; alias: /dehilight)',
  '  /relay [list]          — list, mark, or unmark relay/bridge bots on this network',
  '      e.g. /relay add relaybot   ·   /relay add bridge <{nick}> {message}   ·   /relay remove relaybot',
  '      custom template mirrors the bot order with {source}/{nick}/{message} placeholders',
  '      e.g. reversed: /relay add eyebot <{nick}> [{source}] {message}',
  '  /network [list]        — manage networks (alias: /net); runs from the system buffer',
  '      add [-host <addr>] [-port <n>] [-tls|-notls] [-nick <n>] [-user <u>] [-realname <name>]',
  '          [-sasl_username <u>] [-sasl_password <p>] [-password <serverpass>]',
  "          [-autosendcmd '<cmds>'] [-channel <#chan>] [-auto|-noauto] <name>",
  '      modify <name> [-flags…]   ·   remove <name>   ·   move <name> <position>',
  '      connect <name>   ·   disconnect <name>   (Lurker folds irssi /server into these)',
  '  /dcc [list]            — DCC downloads: list, or accept/reject/cancel <id>',
  '      e.g. /dcc   ·   /dcc accept 3   ·   /dcc reject 3   ·   /dcc cancel 3',
  '  /set <key> <value…>    — change a setting; /set (or /set ?) lists all keys',
  '  /get <key>             — read a setting back (output in the system buffer)',
  '  /raw <line>            — send a raw IRC line (alias: /quote)',
  '  /e2e <sub>             — end-to-end encryption for a channel (experimental; /e2e help)',
  '      on [#chan] [auto|normal|quiet]   ·   off [#chan]   ·   mode <auto|normal|quiet>',
  '      handshake <nick>   ·   accept <nick>   ·   decline <nick>',
  '      revoke <nick>   ·   unrevoke <nick>   ·   reverify <nick>   ·   verify <nick>',
  '      rotate [#chan]   ·   forget [-all] <nick|handle>   ·   fingerprint   ·   status   ·   list [-all]',
  '      autotrust <list | add <scope> <pattern> | remove <pattern>>   ·   export   ·   import',
  '  /commands              — this list',
  '  //text                 — send literal "/text" as a message (escape)',
];

function isChannelTarget(t: string): boolean {
  return typeof t === 'string' && t.startsWith('#');
}

// Shared builder for the op/voice/ban-family MODE shortcuts (/op, /voice, /ban,
// …). The channel defaults to the current buffer; an explicit #chan may lead
// the args (so `/op #other alice` works from anywhere). Each nick/mask consumes
// one mode letter, so `/op a b` → `MODE #c +oo a b`. Bare nicks passed to +b/+q
// are left verbatim — ircds auto-complete them to `nick!*@*`.
function modeShortcut(
  networkId: number,
  target: string,
  rest: string[],
  sign: '+' | '-',
  letter: string,
  usage: string,
  line: string,
): boolean {
  let channel = isChannelTarget(target) ? target : null;
  let args = rest;
  if (rest[0] && rest[0].startsWith('#')) {
    channel = rest[0];
    args = rest.slice(1);
  }
  if (!channel) {
    localInfo(networkId, target, `${usage} — no channel context`);
    return true;
  }
  if (!args.length) {
    localInfo(networkId, target, usage);
    return true;
  }
  const flags = sign + letter.repeat(args.length);
  return sendOrToast(
    { type: 'raw', networkId, line: `MODE ${channel} ${flags} ${args.join(' ')}` },
    line,
  );
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

// /ignore and /unignore operate on the per-user ignore list (global by default;
// `-network` scopes to the active network), so they're network-agnostic and run
// from the system buffer too — networkId is null there.
// /relay (#277) — mark, unmark, or list relay/bridge bots on this network. The
// store writes go over WS and echo back through `relay-bot-updated`, so the
// confirmation here is optimistic-but-authoritative just like /ignore.
function runRelay(argLine: string, networkId: number, target: string): boolean {
  const cmd = parseRelayCommand(argLine);
  if (cmd.kind === 'error') {
    localInfo(networkId, target, `/relay: ${cmd.message}`);
    return true;
  }
  if (cmd.kind === 'list') {
    const list = relayBots.listForNetwork(networkId);
    if (!list.length) {
      localInfo(networkId, target, 'no relay bots marked on this network. /relay add <nick>');
      return true;
    }
    localInfo(networkId, target, `relay bots (${list.length}):`);
    for (const { nick, pattern } of list) {
      localInfo(networkId, target, `  ${nick}${pattern ? `  — ${pattern}` : ''}`);
    }
    return true;
  }
  if (cmd.kind === 'add') {
    relayBots.setRelay(networkId, cmd.nick, true, cmd.pattern);
    localInfo(
      networkId,
      target,
      `marked ${cmd.nick} as a relay bot${cmd.pattern ? ` (pattern: ${cmd.pattern})` : ''}.`,
    );
    return true;
  }
  relayBots.setRelay(networkId, cmd.nick, false);
  localInfo(networkId, target, `unmarked ${cmd.nick} as a relay bot.`);
  return true;
}

// /dcc (#270) — the slash-command surface over the DCC download manager. `list`
// opens the Transfers view and echoes the current transfers into the buffer
// (slash-command-first: the GUI is a view over the same core); accept/reject/
// cancel act on one transfer by id and report the resulting state. User-wide, so
// networkId may be null (running from the system buffer). The store writes go
// over REST and the authoritative row echoes back through both the response and
// the live `dcc-transfer` frame, so the output here is settled, not optimistic.
async function runDcc(argLine: string, networkId: number | null, target: string): Promise<void> {
  const cmd = parseDccCommand(argLine);
  if (cmd.kind === 'error') {
    localInfo(networkId, target, `/dcc: ${cmd.message}`);
    return;
  }
  if (cmd.kind === 'list') {
    dcc.panelOpen = true;
    try {
      const rows = await dcc.load();
      if (!rows.length) {
        localInfo(networkId, target, 'no DCC transfers.');
        return;
      }
      localInfo(networkId, target, `transfers (${rows.length}):`);
      for (const line of formatColumns(rows.map(dccListRow))) {
        localInfo(networkId, target, `  ${line}`);
      }
    } catch (e: any) {
      localInfo(networkId, target, `/dcc: ${e?.message || 'failed to load'}`);
    }
    return;
  }
  // accept / reject / cancel — the parser guarantees a numeric id here. They all
  // route through the store's shared act() path.
  const verb = cmd.kind;
  try {
    const t = await dcc.act(cmd.id, verb);
    localInfo(
      networkId,
      target,
      t ? `/dcc ${verb}: #${t.id} ${t.filename} — ${t.state}` : `/dcc ${verb}: #${cmd.id} done`,
    );
  } catch (e: any) {
    localInfo(networkId, target, `/dcc ${verb}: ${e?.message || 'failed'}`);
  }
}

// One row for the /dcc list output: "#3  movie.mkv  receiving  alice  42%".
function dccListRow(t: DccTransfer): string[] {
  const pct = t.advertised_size > 0 ? `${percentReceived(t)}%` : '';
  return [`#${t.id}`, t.filename, t.state, t.peer_nick, pct];
}

function runIgnore(argLine: string, networkId: number | null, target: string): boolean {
  const args = argLine.trim();
  if (!args) {
    const list = combinedIgnores(networkId);
    if (!list.length) {
      localInfo(networkId, target, 'ignore list is empty.');
    } else {
      localInfo(networkId, target, `ignore list (${list.length}):`);
      list.forEach(({ entry, scope }, i) =>
        localInfo(networkId, target, formatIgnoreEntry(entry, i + 1, scope === null)),
      );
    }
    return true;
  }
  const parsed = parseIgnoreArgs(args);
  if (parsed.error) {
    localInfo(networkId, target, `/ignore: ${parsed.error}`);
    return true;
  }
  // Default scope is global (null); -network scopes to the current network,
  // which the system buffer doesn't have.
  if (parsed.scopeNetwork && networkId == null) {
    localInfo(
      networkId,
      target,
      '/ignore -network needs an active network — switch to a channel or DM.',
    );
    return true;
  }
  ignores.addRule(parsed.scopeNetwork ? networkId : null, parsed);
  return true;
}

function runUnignore(argLine: string, networkId: number | null, target: string): boolean {
  const arg = argLine.trim();
  if (!arg) {
    localInfo(networkId, target, 'usage: /unignore <index|mask>  (index from /ignore)');
    return true;
  }
  const list = combinedIgnores(networkId);
  if (/^\d+$/.test(arg)) {
    const item = list[Number(arg) - 1];
    if (!item) {
      localInfo(networkId, target, `/unignore: no ignore #${arg} (see /ignore)`);
      return true;
    }
    ignores.removeRule(item.scope, { id: item.entry.id });
    localInfo(
      networkId,
      target,
      `removed ignore #${arg}: ${summarizeIgnoreEntry(item.entry, item.scope === null)}`,
    );
    return true;
  }
  // Remove-by-mask matches the stored mask exactly (case-insensitive) across the
  // visible scope. Count local matches so we confirm or report nothing-removed.
  const matches = list.filter(
    ({ entry }) => (entry.mask ?? '').toLowerCase() === arg.toLowerCase(),
  );
  if (!matches.length) {
    localInfo(networkId, target, `/unignore: no ignore with mask "${arg}" (see /ignore)`);
    return true;
  }
  ignores.removeRule(networkId, { mask: arg });
  localInfo(
    networkId,
    target,
    `removed ${matches.length} ignore${matches.length > 1 ? 's' : ''} matching "${arg}".`,
  );
  return true;
}

// /highlight and /unhighlight manage the per-user highlight rules (global by
// default; `-network` scopes to the active network), the same list the settings
// pane edits. Network-agnostic, so they run from the system buffer too. CRUD is
// REST-backed (async); the server fans `highlight-rules-changed` to keep other
// sessions in sync.
function runHighlight(argLine: string, networkId: number | null, target: string): boolean {
  const args = argLine.trim();
  if (!args) {
    const list = combinedHighlights(networkId);
    if (!list.length) {
      localInfo(networkId, target, 'highlight list is empty.');
    } else {
      localInfo(networkId, target, `highlight list (${list.length}):`);
      list.forEach(({ entry, scope }, i) =>
        localInfo(networkId, target, formatHighlightEntry(entry, i + 1, scope === null)),
      );
    }
    return true;
  }
  const parsed = parseHighlightArgs(args);
  if (parsed.error) {
    localInfo(networkId, target, `/highlight: ${parsed.error}`);
    return true;
  }
  if (parsed.scopeNetwork && networkId == null) {
    localInfo(
      networkId,
      target,
      '/highlight -network needs an active network — switch to a channel or DM.',
    );
    return true;
  }
  highlightRules
    .create({
      pattern: parsed.pattern,
      mask: parsed.mask,
      channels: parsed.channels,
      kind: parsed.kind,
      case_sensitive: parsed.caseSensitive,
      enabled: true,
      networkId: parsed.scopeNetwork ? networkId : null,
    })
    .then((rule) => {
      if (rule)
        localInfo(
          networkId,
          target,
          `highlight added: ${summarizeHighlightEntry(rule, rule.networkIds.length === 0)}`,
        );
      return rule;
    })
    .catch((e: any) => localInfo(networkId, target, `/highlight: ${e?.message || 'failed'}`));
  return true;
}

function runUnhighlight(argLine: string, networkId: number | null, target: string): boolean {
  const arg = argLine.trim();
  if (!arg) {
    localInfo(networkId, target, 'usage: /unhighlight <index|text>  (index from /highlight)');
    return true;
  }
  const list = combinedHighlights(networkId);
  const autoHint =
    'auto-managed (tracks your nick) and read-only — it follows your nick automatically';
  if (/^\d+$/.test(arg)) {
    const item = list[Number(arg) - 1];
    if (!item) {
      localInfo(networkId, target, `/unhighlight: no highlight #${arg} (see /highlight)`);
      return true;
    }
    if (item.entry.auto_managed) {
      localInfo(networkId, target, `/unhighlight: #${arg} is ${autoHint}`);
      return true;
    }
    const summary = summarizeHighlightEntry(item.entry, item.scope === null);
    highlightRules
      .remove(item.entry.id)
      .then(() => localInfo(networkId, target, `removed highlight #${arg}: ${summary}`))
      .catch((e: any) => localInfo(networkId, target, `/unhighlight: ${e?.message || 'failed'}`));
    return true;
  }
  // Remove by keyword/mask text (case-insensitive, exact match of pattern OR
  // mask — check both, since a rule can carry both and `??` would hide the mask).
  const lc = arg.toLowerCase();
  const matches = list.filter(
    ({ entry }) =>
      (entry.pattern ?? '').toLowerCase() === lc || (entry.mask ?? '').toLowerCase() === lc,
  );
  const removable = matches.filter(({ entry }) => !entry.auto_managed);
  if (!matches.length) {
    localInfo(networkId, target, `/unhighlight: no highlight matching "${arg}" (see /highlight)`);
    return true;
  }
  if (!removable.length) {
    localInfo(networkId, target, `/unhighlight: "${arg}" is ${autoHint}`);
    return true;
  }
  Promise.all(removable.map(({ entry }) => highlightRules.remove(entry.id)))
    .then(() =>
      localInfo(
        networkId,
        target,
        `removed ${removable.length} highlight${removable.length > 1 ? 's' : ''} matching "${arg}".`,
      ),
    )
    .catch((e: any) => localInfo(networkId, target, `/unhighlight: ${e?.message || 'failed'}`));
  return true;
}

// Resolve a /network ref to a configured network. Prefer a case-insensitive
// name match (folds inconsistent server casing like the rest of the app), then
// fall back to a numeric id so `/network connect 3` works too.
function resolveNetwork(nameOrId: string): Network | null {
  const lower = nameOrId.toLowerCase();
  const byName = networks.networks.find((n) => n.name.toLowerCase() === lower);
  if (byName) return byName;
  const id = Number(nameOrId);
  return Number.isInteger(id) ? networks.networkById(id) : null;
}

// Render the configured networks as an aligned table into the system buffer.
function listNetworks(networkId: number | null, target: string): void {
  const list = networks.networks;
  if (!list.length) {
    localInfo(
      networkId,
      target,
      'no networks configured — /network add -host <address> -nick <nick> <name>',
    );
    return;
  }
  const rows = [
    ['#', 'NAME', 'ADDRESS', 'NICK', 'STATE'],
    ...list.map((n, i) => [
      String(i + 1),
      n.name,
      `${n.host}:${n.port}${n.tls ? ' (tls)' : ''}`,
      n.nick,
      networks.states[n.id]?.state ?? 'off',
    ]),
  ];
  for (const line of formatColumns(rows)) localInfo(networkId, target, line);
}

// Move a network to a 1-based position by rebuilding the full id order and
// handing it to reorder() — the same store action the drag-to-reorder UI uses.
// Returns the effective (clamped) 1-based position so the caller reports where
// it actually landed, not the requested slot.
async function moveNetwork(net: Network, position: number): Promise<number> {
  const ids = networks.networks.map((n) => n.id).filter((id) => id !== net.id);
  const index = Math.min(position - 1, ids.length);
  ids.splice(index, 0, net.id);
  await networks.reorder(ids);
  return index + 1;
}

// /network — manage IRC networks from the input bar, driving the same store as
// the Settings → Networks pane (#356, slash-command-first per #353). It's
// network-agnostic (runs from the system buffer); output lands in the buffer the
// command came from. Store writes are async, so — like ackedSend — we kick them
// off and report success/failure via localInfo when they settle.
async function runNetwork(
  argLine: string,
  networkId: number | null,
  target: string,
): Promise<void> {
  const cmd = parseNetworkCommand(argLine);
  const reply = (msg: string) => localInfo(networkId, target, msg);

  if (cmd.kind === 'error') return reply(`/network: ${cmd.message}`);
  if (cmd.kind === 'list') return listNetworks(networkId, target);

  if (cmd.kind === 'add') {
    try {
      const net = await networks.create({ ...cmd.input, name: cmd.name } as Partial<Network>);
      const tls = cmd.input.tls ? ' (tls)' : '';
      // create() is an explicit "save & connect" server-side, so it dials now.
      reply(`added ${net.name} — ${cmd.input.host}:${cmd.input.port}${tls}, connecting…`);
    } catch (err) {
      reply(`/network add failed: ${err instanceof Error ? err.message : 'unknown error'}`);
    }
    return;
  }

  // Everything else acts on an existing network — resolve it up front so a typo
  // gives a clean "no network matching" instead of a raw 404.
  const net = resolveNetwork(cmd.ref);
  if (!net) return reply(`/network: no network matching "${cmd.ref}"`);

  try {
    switch (cmd.kind) {
      case 'modify':
        await networks.update(net.id, cmd.input as Partial<Network>);
        return reply(`updated ${net.name}`);
      case 'remove':
        await networks.remove(net.id);
        return reply(`removed ${net.name}`);
      case 'connect':
        await networks.connect(net.id);
        return reply(`connecting to ${net.name}…`);
      case 'disconnect':
        await networks.disconnect(net.id);
        return reply(`disconnecting from ${net.name}…`);
      case 'move': {
        const landed = await moveNetwork(net, cmd.position);
        return reply(`moved ${net.name} to position ${landed}`);
      }
    }
  } catch (err) {
    reply(`/network ${cmd.kind} failed: ${err instanceof Error ? err.message : 'unknown error'}`);
  }
}

// Whether a registry option is exposed to /set, /get, and the listing — the
// same surface the Settings UI shows. An option qualifies only if it lives under
// a real sidebar category (this excludes internal keys whose category is
// intentionally absent from CATEGORIES, e.g. system.timezone, which the client
// auto-syncs) AND is visible in this edition (selfHostedOnly knobs are hidden in
// the hosted build). Category *kind* is irrelevant: bespoke panes like
// Notifications still own registry-backed keys, which belong in the surface.
function settingExposed(opt: SettingOption): boolean {
  return (
    CATEGORIES.some((c) => c.id === opt.category) && optionVisible(opt, { isNode: config.isNode })
  );
}

function lookupSetting(key: string): SettingOption | null {
  const opt = getOption(key);
  return opt && settingExposed(opt) ? opt : null;
}

// /set with no value lists every exposed registry key + current value, grouped
// by Settings category. Passkeys, push subscriptions, and drag-to-reorder stay
// GUI-only by design (#357) — they aren't registry-driven, so they don't appear.
function listSettings(networkId: number | null, target: string): void {
  localInfo(networkId, target, 'settings — /set <key> <value> to change, /get <key> to read:');
  for (const cat of CATEGORIES) {
    const opts = REGISTRY.filter((o) => o.category === cat.id && settingExposed(o));
    if (!opts.length) continue;
    localInfo(networkId, target, `${cat.label.toLowerCase()}:`);
    const rows = opts.map((o) => [`  ${o.key}`, formatSettingValue(o, settings.effective(o.key))]);
    for (const line of formatColumns(rows)) localInfo(networkId, target, line);
  }
}

// /set <key> <value> — coerce to the typed value and write through the same
// store the Settings panes use. /set alone (or `?`) lists keys (#357).
function runSet(argLine: string, networkId: number | null, target: string): void {
  const reply = (msg: string) => localInfo(networkId, target, msg);
  const args = splitSetArgs(argLine);
  if (args.kind === 'list') return listSettings(networkId, target);
  const opt = lookupSetting(args.key);
  if (!opt) return reply(`/set: unknown setting "${args.key}" — /set lists available keys`);
  if (args.kind === 'keyonly') {
    return reply(`usage: /set ${opt.key} <value>  (or /get ${opt.key} to read it)`);
  }
  const coerced = coerceSettingValue(opt, args.rawValue);
  if (!coerced.ok) return reply(`/set: ${coerced.error}`);
  settings
    .setValue(opt.key, coerced.value)
    .then(() => reply(`set ${opt.key} = ${formatSettingValue(opt, coerced.value)}`))
    .catch((err: unknown) =>
      reply(`/set failed: ${err instanceof Error ? err.message : 'unknown error'}`),
    );
}

// /get <key> — read a setting into the buffer, noting the default when changed.
function runGet(argLine: string, networkId: number | null, target: string): void {
  const reply = (msg: string) => localInfo(networkId, target, msg);
  const parts = argLine.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return reply('usage: /get <key>  (/set lists available keys)');
  // Reject extra tokens (parity with /network) so a missing-quote typo doesn't
  // silently read just the first word.
  if (parts.length > 1) return reply('usage: /get <key>  (one key at a time)');
  const opt = lookupSetting(parts[0]);
  if (!opt) return reply(`/get: unknown setting "${parts[0]}" — /set lists available keys`);
  reply(`${opt.key} = ${formatSettingValue(opt, settings.effective(opt.key))}`);
  if (settings.isModified(opt.key)) {
    reply(`  default: ${formatSettingValue(opt, opt.default)}`);
  }
}

function handleCommand(line: string, networkId: number | null, target: string): boolean {
  const [cmd, ...rest] = line.slice(1).split(/\s+/);
  const argLine = line.slice(1 + cmd.length).trim();
  const verb = cmd.toLowerCase();

  // Network-agnostic commands act on global / user-wide state (the local command
  // cheatsheet, the cross-network away flag, the per-user ignore list), so they
  // run whether or not a network is active — including from the system buffer.
  // Handled before the network gate, which then narrows networkId to a number
  // for the switch below.
  switch (verb) {
    case 'commands':
      for (const commandLine of COMMANDS_LINES) localInfo(networkId, target, commandLine);
      return true;
    case 'away':
      // Empty arg → clear away. User-scoped (applies across every connection),
      // so it carries no networkId.
      return sendOrToast({ type: 'away', message: argLine }, line);
    case 'back':
      return sendOrToast({ type: 'back' }, line);
    case 'ignore':
      return runIgnore(argLine, networkId, target);
    case 'unignore':
      return runUnignore(argLine, networkId, target);
    case 'highlight':
    case 'hilight':
      return runHighlight(argLine, networkId, target);
    case 'unhighlight':
    case 'dehilight':
      return runUnhighlight(argLine, networkId, target);
    case 'network':
    case 'net':
      // Network CRUD + connection control. REST-backed and async, so fire it
      // off and let it report into the buffer when it settles; the command is
      // "handled" the moment we recognize it. runNetwork catches its own errors.
      void runNetwork(argLine, networkId, target);
      return true;
    case 'set':
      // Registry-wide setting writes (#357), app-scoped like the others.
      runSet(argLine, networkId, target);
      return true;
    case 'get':
      runGet(argLine, networkId, target);
      return true;
    case 'dcc':
      // DCC download manager (#270). User-wide (transfers aren't tied to the
      // active buffer), so it runs from anywhere including the system buffer.
      // REST-backed + async, so fire-and-forget like /network; it reports into
      // the buffer when it settles.
      void runDcc(argLine, networkId, target);
      return true;
  }

  // Everything else acts on a specific network/buffer.
  if (networkId == null) {
    localInfo(null, target, `/${verb} needs an active network — switch to a channel or DM first.`);
    return true;
  }

  switch (verb) {
    case 'e2e': {
      // RPE2E (#382). `export`/`import` move keyring material across the
      // client↔cell boundary, so they're handled here rather than via the
      // server's buffer-oriented runE2eCommand: export downloads a file (never
      // rendered — it holds the private key), import opens a file picker. Every
      // other subcommand is a thin pass-through; the server parses it and
      // publishes status back into this buffer (defaulting the channel).
      const sub = (rest[0] || '').toLowerCase();
      if (sub === 'export') {
        return sendOrToast({ type: 'e2e-export', networkId }, line);
      }
      if (sub === 'import') {
        e2eImportNetworkId.value = networkId;
        e2eImportInputEl.value?.click();
        return true;
      }
      return sendOrToast({ type: 'e2e', networkId, target, args: argLine }, line);
    }
    case 'relay':
      // Mark/unmark/list relay bots on this network (#277). Network-scoped: a
      // relay mark is per-(network, nick), so it needs an active network.
      return runRelay(argLine, networkId, target);
    case 'me':
      return ackedSend({ type: 'action', networkId, target, text: argLine }, argLine);
    case 'ctcp': {
      // /ctcp <nick> <type> [args] — send a CTCP query (#263). The cell frames
      // and sends it, echoes locally, and routes the reply back to this buffer.
      const who = rest[0];
      const type = rest[1];
      if (!who || !type) {
        localInfo(networkId, target, 'usage: /ctcp <nick> <type> [args] — e.g. /ctcp bob VERSION');
        return true;
      }
      const ctcpArgs = rest.slice(2).join(' ');
      return sendOrToast(
        {
          type: 'ctcp',
          networkId,
          target: who,
          issuingTarget: target,
          ctcpType: type,
          args: ctcpArgs,
        },
        line,
      );
    }
    case 'ping': {
      // /ping [nick] — CTCP PING for round-trip latency (#263). Defaults to the
      // current DM peer when no nick is given — i.e. the active buffer is not a
      // channel (any prefix #&!+, matching the server's isChannelContext) and not
      // a pseudo-buffer (`:server:`/system), so /ping in an `&local` channel
      // doesn't ping the whole channel.
      const who = rest[0] || (target && !/^[#&!+:]/.test(target) ? target : '');
      if (!who) {
        localInfo(networkId, target, 'usage: /ping <nick> (a nick is only optional inside a DM)');
        return true;
      }
      return sendOrToast(
        { type: 'ctcp', networkId, target: who, issuingTarget: target, ctcpType: 'PING', args: '' },
        line,
      );
    }
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
        const ch = ensureChannelPrefix(rest[0]);
        // A channel key is a single whitespace-free token — take just the next
        // arg, not the rest joined (which would fold trailing words into an
        // invalid, space-bearing key).
        const key = rest[1] || undefined;
        // Switch to the channel if we're already in it; otherwise join. Returns
        // false only when a JOIN had to be sent but the socket was closed.
        if (buffers.joinOrActivate(networkId, ch, key)) return true;
        toastSendFailure('disconnected', line);
        return false;
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
    case 'invite': {
      // /invite <nick>             (in a channel buffer → invite to it)
      // /invite <nick> <#chan>     (anywhere)
      // /invite <#chan> <nick>     (channel-first, mirroring /kick)
      let channel;
      let nick;
      if (rest[0] && rest[0].startsWith('#')) {
        channel = rest[0];
        nick = rest[1];
      } else {
        nick = rest[0];
        channel =
          rest[1] && rest[1].startsWith('#') ? rest[1] : isChannelTarget(target) ? target : null;
      }
      if (!nick) {
        localInfo(networkId, target, 'usage: /invite <nick> [#channel]');
        return true;
      }
      if (!channel) {
        localInfo(networkId, target, 'usage: /invite <nick> [#channel] — no channel context');
        return true;
      }
      // Wire order is INVITE <nick> <channel> (note: irc-framework's own
      // .invite() flips the args — we build the raw line directly so it can't).
      return sendOrToast({ type: 'raw', networkId, line: `INVITE ${nick} ${channel}` }, line);
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
    case 'list': {
      // Open the channel-list browser (the same surface as the network context
      // menu) rather than piping a raw LIST into the buffer (#335). The modal
      // self-fetches on open; an argument pre-seeds its filter via the chanlist
      // store, which the modal reads as its initial query.
      const q = argLine.trim();
      if (q) chanlist.setQuery(networkId, q);
      channelListModal.open(networkId);
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
    case 'op':
      return modeShortcut(networkId, target, rest, '+', 'o', 'usage: /op [#chan] <nick…>', line);
    case 'deop':
      return modeShortcut(networkId, target, rest, '-', 'o', 'usage: /deop [#chan] <nick…>', line);
    case 'voice':
      return modeShortcut(networkId, target, rest, '+', 'v', 'usage: /voice [#chan] <nick…>', line);
    case 'devoice':
      return modeShortcut(
        networkId,
        target,
        rest,
        '-',
        'v',
        'usage: /devoice [#chan] <nick…>',
        line,
      );
    case 'halfop':
      return modeShortcut(
        networkId,
        target,
        rest,
        '+',
        'h',
        'usage: /halfop [#chan] <nick…>',
        line,
      );
    case 'dehalfop':
      return modeShortcut(
        networkId,
        target,
        rest,
        '-',
        'h',
        'usage: /dehalfop [#chan] <nick…>',
        line,
      );
    case 'ban':
      return modeShortcut(
        networkId,
        target,
        rest,
        '+',
        'b',
        'usage: /ban [#chan] <nick|mask>',
        line,
      );
    case 'unban':
      return modeShortcut(networkId, target, rest, '-', 'b', 'usage: /unban [#chan] <mask>', line);
    case 'quiet':
      return modeShortcut(
        networkId,
        target,
        rest,
        '+',
        'q',
        'usage: /quiet [#chan] <nick|mask>',
        line,
      );
    case 'unquiet':
      return modeShortcut(
        networkId,
        target,
        rest,
        '-',
        'q',
        'usage: /unquiet [#chan] <mask>',
        line,
      );
    case 'kickban': {
      // Ban first (so they can't instantly rejoin), then kick. A leading #chan
      // is optional; otherwise the current channel is used.
      let channel = isChannelTarget(target) ? target : null;
      let args = rest;
      if (rest[0] && rest[0].startsWith('#')) {
        channel = rest[0];
        args = rest.slice(1);
      }
      if (!channel) {
        localInfo(
          networkId,
          target,
          'usage: /kickban [#chan] <nick> [reason] — no channel context',
        );
        return true;
      }
      const nick = args[0];
      if (!nick) {
        localInfo(networkId, target, 'usage: /kickban [#chan] <nick> [reason]');
        return true;
      }
      const reason = args.slice(1).join(' ');
      const trailer = reason ? ` :${reason}` : '';
      // The ban send returns false only if the socket is closed — skip the KICK
      // so we don't half-apply against a dead connection.
      if (!sendOrToast({ type: 'raw', networkId, line: `MODE ${channel} +b ${nick}` }, line)) {
        return false;
      }
      return sendOrToast(
        { type: 'raw', networkId, line: `KICK ${channel} ${nick}${trailer}` },
        line,
      );
    }
    case 'cycle':
    case 'hop': {
      // Part then immediately rejoin the CURRENT channel; the whole arg line is
      // an optional part reason. Both legs go through the structured part/join
      // WS types — NOT a raw JOIN — so the persisted joined flag flips false and
      // back to true. A raw JOIN bypasses ircManager.joinChannel and would leave
      // joined=false in the DB, breaking reconnect auto-join after a cycle.
      if (!isChannelTarget(target)) {
        localInfo(networkId, target, 'usage: /cycle [reason] — run inside a channel');
        return true;
      }
      if (!sendOrToast({ type: 'part', networkId, channel: target, reason: argLine }, line)) {
        return false;
      }
      return sendOrToast({ type: 'join', networkId, channel: target }, line);
    }
    case 'notice': {
      // Routed through the server's send_notice verb (not a raw NOTICE) so it
      // publishes a self-copy back to every tab — IRC servers don't echo your
      // own NOTICE, so a raw forward would vanish with nothing in the buffer.
      // ackedSend (not sendOrToast) so a not-connected / validation failure
      // surfaces as a toast instead of silently clearing the input — there's no
      // optimistic bubble, the server's self-publish is what renders on success.
      const who = rest[0];
      // Preserve the body's internal spacing by slicing past the target rather
      // than re-joining the \s+-split rest (mirrors /topic).
      const body = line
        .slice(1 + cmd.length)
        .trim()
        .slice(who?.length ?? 0)
        .trim();
      if (!who || !body) {
        localInfo(networkId, target, 'usage: /notice <target> <text>');
        return true;
      }
      return ackedSend({ type: 'notice', networkId, target: who, text: body }, body);
    }
    case 'slap': {
      // mIRC's classic: a CTCP ACTION with the canonical trout line, so it rides
      // the same path as /me into the current channel or DM.
      if (isServer.value) {
        localInfo(networkId, target, 'usage: /slap <nick> — run inside a channel or DM');
        return true;
      }
      const who = rest[0];
      if (!who) {
        localInfo(networkId, target, 'usage: /slap <nick>');
        return true;
      }
      const slapText = `slaps ${who} around a bit with a large trout`;
      return ackedSend({ type: 'action', networkId, target, text: slapText }, slapText);
    }
    // Info/query commands. These already function via the raw fallback now that
    // unhandled server numerics surface in the server buffer (#269) — listing
    // them explicitly uppercases the verb, documents them in /commands, and gives a
    // single home for any future per-command argument handling. Each forwards
    // its IRC verb plus whatever args were typed (server/target/mask/nick…); a
    // missing-arg server error (e.g. bare /whowas) now surfaces on its own.
    case 'time':
    case 'version':
    case 'motd':
    case 'names':
    case 'who':
    case 'whowas':
    case 'admin':
    case 'info':
    case 'lusers':
    case 'links':
    case 'map':
    case 'stats':
    case 'userhost':
    case 'ison':
    // `/help` queries the network's own HELP system (704/705/706 render in the
    // server buffer like any other server reply); the local slash-command
    // cheatsheet lives under `/commands` below (#316).
    case 'help': {
      const rawVerb = cmd.toUpperCase();
      return sendOrToast(
        { type: 'raw', networkId, line: argLine ? `${rawVerb} ${argLine}` : rawVerb },
        line,
      );
    }
    default:
      return sendOrToast({ type: 'raw', networkId, line: line.slice(1) }, line);
  }
}
</script>

<style scoped>
.input {
  display: flex;
  /* flex-start so the prompt label stays pinned to the first line as the
     textarea grows downward across multiple lines. The send button overrides
     this (align-self: flex-end) to track the bottom of the input area. */
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
/* User modes ride the accent-coloured nick but stay muted, matching the status
   bar's channel name (accent) vs mode suffix (muted) treatment (issue #415). */
.prompt .modes {
  color: var(--fg-muted);
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
.send-btn {
  background: none;
  border: none;
  color: var(--accent);
  cursor: pointer;
  padding: 0 var(--space-1);
  font-size: inherit;
  line-height: 1.4;
  /* Stick to the bottom of the input area as the textarea grows multi-line,
     instead of riding the first line with the prompt (issue #295). */
  align-self: flex-end;
}
.send-btn:hover:not(:disabled) {
  color: var(--fg);
}
.send-btn:disabled {
  opacity: 0.4;
  color: var(--fg-muted);
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
