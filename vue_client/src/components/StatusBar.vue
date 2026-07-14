<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <div v-if="active" class="status-bar">
    <div class="bar" :class="{ compact }">
      <div class="bar-main">
        <span v-if="!compact" class="seg clock">{{ clock }}</span>
        <span class="seg buffer"
          ><template v-if="targetLabel"
            ><span v-if="networkLabel" class="net">{{ networkLabel }}/</span
            ><span class="name">{{ targetLabel }}</span></template
          ><span v-else class="name">{{ networkLabel }}</span
          ><span v-if="modeSuffix && !compact" class="modes">{{ modeSuffix }}</span></span
        >
        <!-- Jump-to-unread. Scrolls (usually up) to the pinned unread divider
           when it's off-screen and the user hasn't scrolled it into view yet
           this visit. Renders in both modes — catching up matters as much on
           mobile. -->
        <!-- Label bound via v-text (not inline text) so the formatter can't put
             content on its own indented line, whose newline would render as a
             stray leading space after the `|` separator pseudo-element. -->
        <button
          v-if="unreadAnchor"
          class="seg jump-unread"
          type="button"
          v-text="jumpUnreadLabel"
          @click="onJumpToUnread"
        ></button>
        <!-- Return-to-present: the single downward affordance. Shows whenever the
           buffer is detached (viewing a historical slice) OR the user has
           scrolled up off the live tail; the count badge reflects whichever
           applies. Detached → reattach to live; scrolled-up → snap down. Renders
           in both modes — merging the former desktop-only [N new ↓] button in
           means mobile finally gets a way back to the present too. -->
        <button
          v-if="showPresent"
          class="seg return-present"
          type="button"
          v-text="returnPresentLabel"
          @click="onReturnToPresent"
        ></button>
        <span v-if="peerStatusLabel" class="seg peer-status" :class="peerStatusClass">{{
          peerStatusLabel
        }}</span>
        <span v-if="lagLabel && !compact" class="seg lag" :class="lagClass">{{ lagLabel }}</span>
        <span v-if="uploadLabel" class="seg upload" :class="{ failed: uploads.failedAt }">{{
          uploadLabel
        }}</span>
        <span v-if="splitLabel" class="seg split" :class="splitClass">{{ splitLabel }}</span>
        <span v-if="typingSegments.length" class="seg typing"
          ><i class="fa-regular fa-keyboard" role="img" aria-label="Typing" title="Typing"></i>
          <template v-for="(seg, i) in typingSegments" :key="i"
            ><span :style="seg.color ? { color: seg.color } : null">{{ seg.text }}</span></template
          ></span
        >
      </div>
      <div class="bar-tools">
        <!-- No @mousedown.prevent here (unlike the palette/send buttons): this
             opens the native iOS file picker, which dismisses the soft keyboard
             no matter what. Preventing the tap-blur only delays that dismissal a
             beat — keyboard stays up, then drops as the picker sheet animates in
             — which reads as jank. Letting the tap blur gives one clean
             dismissal instead. -->
        <button
          type="button"
          class="tool-btn"
          :disabled="!sendable"
          title="upload file"
          aria-label="upload file"
          @click="onPickFile"
        >
          <i class="fa-solid fa-paperclip"></i>
        </button>
        <!-- @mousedown.prevent keeps the composer focused (and the iOS keyboard
             up): this opens the in-app colour picker overlay, not a native
             sheet, so the keyboard should stay — same affordance as send. -->
        <button
          v-if="showFormatButton"
          type="button"
          class="tool-btn"
          :disabled="!sendable"
          title="mIRC formatting (Cmd/Ctrl+B/I/U for bold/italic/underline)"
          aria-label="mIRC formatting"
          @mousedown.prevent
          @click="onToggleColorPicker"
        >
          <i class="fa-solid fa-palette"></i>
        </button>
      </div>
    </div>
    <!-- Composer overlays — the nick/emoji suggestion strips replace the bar's
         content while active (same chrome, swapped contents); the mIRC colour
         picker pops up from the bar's bottom edge. State and the "where the
         pick gets applied" logic live in useComposerOverlay so MessageInput
         (which owns the textarea) and StatusBar (which renders the popover)
         stay decoupled. -->
    <SuggestionStrip
      v-show="overlay.nickOpen"
      :items="overlay.nickItems"
      :key-for="nickKeyFor"
      :active-index="overlay.nickActiveIndex"
      @select="onNickStripSelect"
      @hover="setNickActive"
    >
      <template #chip="{ item }">
        <span :style="item.color ? { color: item.color } : null">{{ item.nick }}</span>
      </template>
    </SuggestionStrip>
    <SuggestionStrip
      v-show="overlay.emojiOpen"
      :items="overlay.emojiItems"
      :key-for="emojiKeyFor"
      :active-index="overlay.emojiActiveIndex"
      @select="selectEmoji"
      @hover="setEmojiActive"
    >
      <template #chip="{ item }">
        <span class="emoji-glyph">{{ item.emoji }}</span>
        <span class="emoji-name">:{{ item.name }}:</span>
      </template>
    </SuggestionStrip>
    <MircColorPicker
      v-if="overlay.colorPickerOpen"
      :open="overlay.colorPickerOpen"
      @apply="applyColor"
      @reset="resetColor"
      @close="closeColorPicker"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted, onBeforeUnmount } from 'vue';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useSettingsStore } from '../stores/settings.js';
import { useUploadsStore } from '../stores/uploads.js';
import { useIgnoresStore } from '../stores/ignores.js';
import { useAuthStore } from '../stores/auth.js';
import { useNickColors } from '../composables/useNickColors.js';
import {
  useScrollState,
  requestScrollToBottom,
  requestScrollToUnread,
} from '../composables/useScrollState.js';
import { useComposing } from '../composables/useComposing.js';
import { formatTimestamp } from '../utils/timestamp.js';
import { isPeerOffline, isPeerAway } from '../utils/peerPresence.js';
import SuggestionStrip from './SuggestionStrip.vue';
import MircColorPicker from './MircColorPicker.vue';
import {
  useComposerOverlay,
  selectNick,
  selectEmoji,
  setEmojiActive,
  setNickActive,
  applyColor,
  resetColor,
  closeColorPicker,
  setColorPickerOpen,
  pickComposerFile,
  type NickStripItem,
} from '../composables/useComposerOverlay.js';
import type { EmojiMatch } from '../utils/emojiData.js';

withDefaults(
  defineProps<{
    // Mobile/petite mode: drops the clock segment (not worth the row at phone
    // widths) and hides lag so the typing/split/upload signals stay legible.
    // The buffer name (network/channel + modes) renders in both modes; the
    // self identity (nick + channel-prefix + user modes + away) moves to the
    // input placeholder on mobile, freeing the input row to be just `>`,
    // textarea, and send. (The scroll affordances — jump-to-unread
    // and return-to-present — render in both modes.)
    compact?: boolean;
  }>(),
  { compact: false },
);

const networks = useNetworksStore();
const buffers = useBuffersStore();
const settings = useSettingsStore();
const uploads = useUploadsStore();
const ignores = useIgnoresStore();
const auth = useAuthStore();
const nickColors = useNickColors();
const composing = useComposing();

// SPLIT (warn) at 2 chunks, FLOOD (bad) at 3+. Lives just before the typing
// indicator so heavy composers can see it without taking their eyes off the
// input. Empty / single-chunk drafts render nothing. On a multiline network
// `composing.chunks` is the batch (message) count: 1 → a neutral MULTILINE
// chip (lands as one logical message), 2 → MULTILINE ×2 (warn), 3+ →
// MULTILINE ×N (bad, where the upload-as-.txt gate kicks in). (#381)
const splitLabel = computed(() => {
  if (composing.multiline) {
    return composing.chunks <= 1 ? 'MULTILINE' : `MULTILINE ×${composing.chunks}`;
  }
  if (composing.chunks <= 1) return '';
  if (composing.isAction) return 'ACTION TOO LONG';
  return composing.chunks >= 3 ? `FLOOD (${composing.chunks})` : 'SPLIT';
});
const splitClass = computed(() => {
  if (composing.multiline) {
    if (composing.chunks >= 3) return 'bad';
    return composing.chunks === 2 ? 'warn' : '';
  }
  if (composing.chunks <= 1) return '';
  if (composing.isAction || composing.chunks >= 3) return 'bad';
  return 'warn';
});

// Narrate the leg the upload is ACTUALLY on (#545). A percentage appears only where
// one is real — the browser leg, and the provider send when the driver can count
// bytes. Everywhere else the label is indeterminate on purpose: "Processing…" tells
// the truth about an unmeasurable phase, where "100%" told a comfortable lie.
const uploadLabel = computed(() => {
  const cur = uploads.current;
  if (cur) {
    if (cur.phase === 'uploading') return `Uploading: ${cur.progress}%`;
    if (cur.phase === 'sending') {
      const where = cur.destination ? `Sending to ${cur.destination}` : 'Sending';
      return cur.sentPercent == null ? `${where}…` : `${where}… ${cur.sentPercent}%`;
    }
    return 'Processing…';
  }
  if (uploads.failedAt) {
    return uploads.failedMessage ? `Upload failed — ${uploads.failedMessage}` : 'Upload failed';
  }
  return '';
});
const { newBelow, stuckToBottom, unreadAnchor } = useScrollState();

const active = computed(() => networks.activeBuffer);
const buffer = computed(() => (networks.activeKey ? buffers.byKey(networks.activeKey) : null));
const isServerBuffer = computed(() => !!active.value?.target?.startsWith(':server:'));
const sendable = computed(() => !!active.value && !isServerBuffer.value && !auth.isPaused);
const showFormatButton = computed(() => settings.effective('input.show_format_button') === true);

const overlay = useComposerOverlay();
const emojiKeyFor = (m: EmojiMatch): string => m.name;
const nickKeyFor = (item: NickStripItem): string => item.nick.toLowerCase();
// Route the chip click through selectNick (which fires the host's registered
// onNickSelect). hover events are wired straight to setNickActive on the
// template — same shape as the emoji strip.
const onNickStripSelect = (item: NickStripItem): void => selectNick(item.nick);

const isChannel = computed(() => !!active.value?.target?.startsWith('#'));

const networkLabel = computed(() => {
  const a = active.value;
  return a?.network?.name || '';
});

// For server pseudo-buffers we drop the redundant trailing `:server:<id>` and
// just show the network name (no `/`). Channels/DMs show the raw target.
const targetLabel = computed(() => {
  const a = active.value;
  if (!a) return '';
  if (isServerBuffer.value) return '';
  return a.target;
});

const modeSuffix = computed(() => {
  if (!isChannel.value) return '';
  const m = buffer.value?.modes;
  return m ? `(+${m})` : '';
});

// DM-only persistent peer state. Surfaces "<nick> is offline" when the server
// has flipped them offline (their reply won't be seen live), and an
// "<nick> is away" sub-state when they're flagged AFK but still reachable.
// Server pseudo-buffers and channels skip this entirely.
const isDmBuffer = computed(
  () =>
    !!active.value?.target &&
    !active.value.target.startsWith('#') &&
    !active.value.target.startsWith(':server:'),
);
const peerForActive = computed(() => {
  if (!isDmBuffer.value) return null;
  const a = active.value;
  if (!a) return null;
  return networks.peerFor(a.networkId, a.target);
});
const peerStatusLabel = computed(() => {
  const peer = peerForActive.value;
  if (!peer) return '';
  const a = active.value;
  if (!a) return '';
  if (isPeerOffline(peer)) return `${a.target} is offline`;
  if (isPeerAway(peer)) {
    return peer.awayMessage ? `${a.target} is away: ${peer.awayMessage}` : `${a.target} is away`;
  }
  return '';
});
const peerStatusClass = computed(() => {
  const peer = peerForActive.value;
  if (!peer) return '';
  return isPeerOffline(peer) ? 'offline' : 'away';
});

const typingNicks = computed(() => {
  const t = buffer.value?.typing;
  if (!t) return [];
  const networkId = active.value?.networkId;
  // The map is keyed by lowercased nick; render the display nick from the entry.
  if (!networkId) return Object.values(t).map((entry) => entry.nick);
  return Object.values(t)
    .filter((entry) => !ignores.isIgnored(networkId, entry.nick, entry.userhost ?? ''))
    .map((entry) => entry.nick);
});

function nickSeg(nick: string): { text: string; color: string | null } {
  return { text: nick, color: nickColors.color(nick) };
}

const sep = (s: string): { text: string; color: null } => ({ text: s, color: null });
const typingSegments = computed(() => {
  const list = typingNicks.value;
  if (list.length === 0) return [];
  if (list.length === 1) return [nickSeg(list[0])];
  if (list.length === 2) return [nickSeg(list[0]), sep(', '), nickSeg(list[1])];
  if (list.length === 3)
    return [nickSeg(list[0]), sep(', '), nickSeg(list[1]), sep(', '), nickSeg(list[2])];
  return [nickSeg(list[0]), sep(', '), nickSeg(list[1]), sep(`, +${list.length - 2}`)];
});

const lagMs = computed(() => {
  const a = active.value;
  if (!a) return null;
  const v = networks.states[a.networkId]?.lagMs;
  return typeof v === 'number' ? v : null;
});

// Weechat-style visibility: hide entirely when lag is below the show threshold,
// unless the user has opted into always-show. Above the threshold we render the
// raw value (no "lag: " prefix), warn-colored normally and bad-colored once the
// alarm threshold is crossed so a real spike is impossible to miss.
const lagMinShowMs = computed(() => settings.effective('look.bar.lag_min_show_ms') as number);
const lagAlarmMs = computed(() => settings.effective('look.bar.lag_alarm_ms') as number);
const lagAlwaysShow = computed(() => settings.effective('look.bar.lag_always_show'));

const lagLabel = computed(() => {
  const v = lagMs.value;
  if (v == null) return '';
  if (!lagAlwaysShow.value && v < lagMinShowMs.value) return '';
  if (v < 1000) return `${v}ms`;
  return `${(v / 1000).toFixed(1)}s`;
});

const lagClass = computed(() => {
  const v = lagMs.value;
  if (v == null) return '';
  if (v >= lagAlarmMs.value) return 'alarm';
  if (v >= lagMinShowMs.value) return 'warn';
  return '';
});

// Clock lives in the status bar now. Same 1s tick + same format setting as
// the input bar used to have, so existing look.bar.time_format keeps working.
const tsFormat = computed(
  () => (settings.effective('look.bar.time_format') as string) || 'HH:mm:ss',
);
const now = ref(new Date());
let clockTimer: ReturnType<typeof setInterval> | null = null;
let clockAlignTimeout: ReturnType<typeof setTimeout> | null = null;
// Align the first tick to the next wall-clock second boundary before
// kicking off the 1s interval. Without this, the displayed second can be
// up to ~999ms behind any NTP-synced clock — we tick from whatever
// sub-second offset mount happened at, and HH:mm:ss formatting floors.
onMounted(() => {
  const delay = 1000 - (Date.now() % 1000);
  clockAlignTimeout = setTimeout(() => {
    now.value = new Date();
    clockTimer = setInterval(() => {
      now.value = new Date();
    }, 1000);
  }, delay);
});
onBeforeUnmount(() => {
  if (clockAlignTimeout) clearTimeout(clockAlignTimeout);
  if (clockTimer) clearInterval(clockTimer);
});
const clock = computed(() => formatTimestamp(now.value.toISOString(), tsFormat.value));

const detached = computed(() => !!buffer.value?.detached);
const liveDuringDetach = computed(() => buffer.value?.liveDuringDetach || 0);

// One downward affordance covering both "scrolled up on the live tail" and
// "viewing a detached historical slice". Detached forces stickToBottom false
// when the slice lands, but the user can scroll to the bottom OF THE SLICE
// (stuck=true) while still off the live tail — so detached must be its own
// arm of the condition, not folded into !stuckToBottom.
const showPresent = computed(() => detached.value || !stuckToBottom.value);
// Count badge: messages that arrived while detached, else the live unread-
// below count tracked by the scroll state.
const presentCount = computed(() => (detached.value ? liveDuringDetach.value : newBelow.value));
// Built as a single string (and bound with v-text in the template) rather than
// inline template text so no formatter-injected indentation whitespace can
// leak into the rendered label — see the button markup for why that matters.
const returnPresentLabel = computed(() => {
  const count = presentCount.value > 0 ? ` (${presentCount.value} new)` : '';
  return `Return${count} ↓`;
});

function onReturnToPresent() {
  const buf = buffer.value;
  if (!buf) return;
  // Only a detached buffer needs to re-fetch the live tail; a plain scrolled-
  // up live buffer just snaps down. The reattach response replaces messages
  // and trips the wholesale-replace branch in MessageList's watcher (which
  // snaps to bottom and resets stickToBottom); the token is belt-and-
  // suspenders for a slow response.
  if (buf.detached && buf.networkId != null) buffers.reattachToLive(buf.networkId, buf.target);
  requestScrollToBottom();
}

const unreadArrow = computed(() => (unreadAnchor.value === 'down' ? '↓' : '↑'));
const jumpUnreadLabel = computed(() => `Unread ${unreadArrow.value}`);

function onJumpToUnread() {
  requestScrollToUnread();
}

function onPickFile() {
  if (!sendable.value) return;
  pickComposerFile();
}

function onToggleColorPicker() {
  if (!sendable.value) return;
  setColorPickerOpen(!overlay.colorPickerOpen);
}
</script>

<style scoped>
/* The component root carries no chrome of its own — it's a positioning
   context so the strips can pin to the inner bar via `position: absolute;
   inset: 0;` and the colour picker can anchor to the bottom-right without
   the inner row's `overflow: hidden` clipping it. Keeping the `.status-bar`
   class on the root preserves the contract with consumers' scoped-CSS
   selectors (DesktopChat's grid placement, MobileChat's flex sizing). */
.status-bar {
  position: relative;
  flex: 0 0 auto;
}
.bar {
  display: flex;
  align-items: center;
  padding: 1ch var(--space-6) 0;
  border-top: 1px solid var(--border);
  color: var(--fg-muted);
  gap: 1ch;
  /* Match the input bar's line-height (1.4 — tighter than the body default
     of 1.55 used for message text). Status + input are sibling rows of
     bottom chrome and need to share a content height; without this they
     drift apart and the sidebar-foot (also overridden to 1.4 below) and
     the input bar end up at different heights even with identical box
     padding. */
  line-height: 1.4;
}
.bar-main {
  display: flex;
  align-items: center;
  min-width: 0;
  flex: 1 1 auto;
  white-space: nowrap;
  overflow: hidden;
  /* Segments live here now (the send-button PR moved them out of `.bar`).
     The `|` separators get their right-side space from the `::before`
     margin, but rely on this gap for the matching left-side space — without
     it the pipe sits flush against the previous segment and floats off the
     next one. Mirrors the `gap` `.bar` carries between main + tools. */
  gap: 1ch;
}
.bar-tools {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
}
.seg {
  flex: 0 0 auto;
}
/* Pipe separator between consecutive visible segments. v-if removes hidden
   segments from the DOM, so adjacent-sibling matching naturally skips them. */
.seg + .seg::before {
  content: '|';
  color: var(--border);
  margin-right: 1ch;
}
.seg.clock {
  color: var(--fg-muted);
}
/* Shrink-only (grow: 0): the buffer name takes its natural width and lets the
   segments after it (peer-status/lag/upload/split/typing) pack immediately to
   its right — left-aligned — instead of being shoved against the tool buttons.
   It still shrinks + ellipsis-truncates when the row is too tight to fit. */
.seg.buffer {
  flex: 0 1 auto;
  color: var(--fg-muted);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.seg.buffer .name {
  color: var(--accent);
}
.seg.buffer .net {
  color: var(--fg-muted);
}
.seg.buffer .modes {
  color: var(--fg-muted);
}
.seg.lag {
  color: var(--fg-muted);
}
.seg.lag.warn {
  color: var(--warn);
}
.seg.lag.alarm {
  color: var(--bad);
}
.seg.peer-status.offline {
  color: var(--warn);
}
.seg.peer-status.away {
  color: var(--fg-muted);
}
.seg.upload {
  color: var(--accent);
}
.seg.upload.failed {
  color: var(--bad);
}
.seg.split {
  font-weight: 600;
  letter-spacing: 0.05em;
}
.seg.split.warn {
  color: var(--warn);
}
.seg.split.bad {
  color: var(--bad);
}
/* Keyboard glyph standing in for the old "Typing:" label. The 1ch space off the
   first nick lives on the nick span, NOT the icon: `ch` is measured against the
   element's own font, and the FontAwesome `<i>` has no '0' glyph, so its `ch`
   falls back to ~0.5em — half the intended gap. The nick span inherits the mono
   text font, where 1ch is a true character, matching the bar's gap/pipe spacing. */
.seg.typing > span:first-of-type {
  margin-left: 1ch;
}
.seg.jump-unread,
.seg.return-present {
  background: none;
  border: none;
  color: var(--warn);
  font: inherit;
  padding: 0;
  cursor: pointer;
}
.seg.jump-unread:hover,
.seg.return-present:hover {
  color: var(--fg);
}
.tool-btn {
  background: none;
  border: none;
  color: var(--accent);
  cursor: pointer;
  padding: 0 var(--space-1);
  font-size: inherit;
  line-height: 1.4;
}
.tool-btn:hover:not(:disabled) {
  color: var(--fg);
}
.tool-btn:disabled {
  opacity: 0.4;
  color: var(--fg-muted);
  cursor: default;
}
/* Emoji suggester chip body — the glyph leads, the `:shortcode:` trails
   muted so two near-identical emoji stay distinguishable. Styled here (not
   in SuggestionStrip) because slot content carries this component's scope. */
.emoji-name {
  opacity: 0.6;
}
</style>
