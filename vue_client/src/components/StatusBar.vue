<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <div v-if="active" class="status-bar">
    <div class="bar" :class="{ compact }">
      <span v-if="!compact" class="seg clock">{{ clock }}</span>
      <span v-if="!compact" class="seg buffer"
        ><template v-if="targetLabel"
          ><span v-if="networkLabel" class="net">{{ networkLabel }}/</span
          ><span class="name">{{ targetLabel }}</span></template
        ><span v-else class="name">{{ networkLabel }}</span
        ><span v-if="modeSuffix" class="modes">{{ modeSuffix }}</span></span
      >
      <span v-if="compact" class="seg self"
        ><span class="name">{{ promptLabel }}</span
        ><span v-if="awayLabel" class="away">&nbsp;{{ awayLabel }}</span></span
      >
      <!-- Detached-jump indicator. Sits adjacent to the self/nick segment on
         compact (mobile) per agreed placement, where it's the only exit
         from a detached buffer back to live. On desktop seg.self is hidden,
         so this lands right after the buffer name — also a natural spot.
         Unlike [N new ↓] (which is hidden on compact), this button renders
         in both modes. -->
      <button v-if="detached" class="seg return-present" type="button" @click="onReturnToPresent">
        Return to present<template v-if="liveDuringDetach > 0">
          ({{ liveDuringDetach }} new)</template
        >
        ↓
      </button>
      <span v-if="peerStatusLabel" class="seg peer-status" :class="peerStatusClass">{{
        peerStatusLabel
      }}</span>
      <span v-if="lagLabel && !compact" class="seg lag" :class="lagClass">{{ lagLabel }}</span>
      <span v-if="uploadLabel" class="seg upload" :class="{ failed: uploads.failedAt }">{{
        uploadLabel
      }}</span>
      <button
        v-if="newBelow > 0 && !compact"
        class="seg jump"
        type="button"
        @click="onJumpToBottom"
      >
        {{ newBelow }} new ↓
      </button>
      <span v-if="splitLabel" class="seg split" :class="splitClass">{{ splitLabel }}</span>
      <span v-if="typingSegments.length" class="seg typing"
        >Typing:
        <template v-for="(seg, i) in typingSegments" :key="i"
          ><span :style="seg.color ? { color: seg.color } : null">{{ seg.text }}</span></template
        ></span
      >
    </div>
    <!-- Composer overlays — the nick/emoji suggestion strips replace the bar's
         content while active (same chrome, swapped contents); the mIRC colour
         picker pops up from the bar's bottom edge. State and the "where the
         pick gets applied" logic live in useComposerOverlay so MessageInput
         (which owns the textarea) and StatusBar (which renders the popover)
         stay decoupled. -->
    <NickSuggestionStrip
      v-show="overlay.nickOpen"
      :query="overlay.nickQuery"
      :buffer="buffer"
      :self-nick="ownNick"
      @select="selectNick"
    />
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
import { useNickColors } from '../composables/useNickColors.js';
import { useScrollState, requestScrollToBottom } from '../composables/useScrollState.js';
import { useComposing } from '../composables/useComposing.js';
import { useSelfLabel } from '../composables/useSelfLabel.js';
import { formatTimestamp } from '../utils/timestamp.js';
import { isPeerOffline, isPeerAway } from '../utils/peerPresence.js';
import NickSuggestionStrip from './NickSuggestionStrip.vue';
import SuggestionStrip from './SuggestionStrip.vue';
import MircColorPicker from './MircColorPicker.vue';
import {
  useComposerOverlay,
  selectNick,
  selectEmoji,
  setEmojiActive,
  applyColor,
  resetColor,
  closeColorPicker,
} from '../composables/useComposerOverlay.js';
import type { EmojiMatch } from '../utils/emojiData.js';

withDefaults(
  defineProps<{
    // Mobile/petite mode: drops the clock and buffer-name segments entirely
    // (the buffer name is already in the mobile header, the clock isn't worth
    // the row), and renders the self identity (nick + channel-prefix + user
    // modes + away) here instead — freeing the input row to be just `>`,
    // textarea, and the paperclip. Also hides lag and the "new ↓" jump button
    // so the typing/split/upload signals stay legible at phone widths.
    compact?: boolean;
  }>(),
  { compact: false },
);

const networks = useNetworksStore();
const buffers = useBuffersStore();
const settings = useSettingsStore();
const uploads = useUploadsStore();
const ignores = useIgnoresStore();
const nickColors = useNickColors();
const composing = useComposing();
const { promptLabel, awayLabel } = useSelfLabel();

// SPLIT (warn) at 2 chunks, FLOOD (bad) at 3+. Lives just before the typing
// indicator so heavy composers can see it without taking their eyes off the
// input. Empty / single-chunk drafts render nothing.
const splitLabel = computed(() => {
  if (composing.chunks <= 1) return '';
  if (composing.isAction) return 'ACTION TOO LONG';
  return composing.chunks >= 3 ? `FLOOD (${composing.chunks})` : 'SPLIT';
});
const splitClass = computed(() => {
  if (composing.chunks <= 1) return '';
  if (composing.isAction || composing.chunks >= 3) return 'bad';
  return 'warn';
});

const uploadLabel = computed(() => {
  if (uploads.current) return `Uploading: ${uploads.current.progress}%`;
  if (uploads.failedAt) {
    return uploads.failedMessage ? `Upload failed — ${uploads.failedMessage}` : 'Upload failed';
  }
  return '';
});
const { newBelow } = useScrollState();

const active = computed(() => networks.activeBuffer);
const buffer = computed(() => (networks.activeKey ? buffers.byKey(networks.activeKey) : null));

// Composer-overlay state and the props the popovers need. ownNick and
// `buffer` aren't routed through the composable because they're always the
// active buffer / network's — derive them here from the same stores
// MessageInput reads.
const overlay = useComposerOverlay();
const ownNick = computed(() => {
  const a = active.value;
  if (!a) return '';
  return networks.states[a.networkId]?.nick || '';
});
const emojiKeyFor = (m: EmojiMatch): string => m.name;

const isServerBuffer = computed(() => !!active.value?.target?.startsWith(':server:'));
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
  return networks.states[a.networkId]?.peerPresence?.[a.target.toLowerCase()] || null;
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
  if (!networkId) return Object.keys(t);
  return Object.entries(t)
    .filter(([nick, entry]) => !ignores.isIgnored(networkId, nick, entry.userhost ?? ''))
    .map(([nick]) => nick);
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

function onJumpToBottom() {
  requestScrollToBottom();
}

const detached = computed(() => !!buffer.value?.detached);
const liveDuringDetach = computed(() => buffer.value?.liveDuringDetach || 0);

function onReturnToPresent() {
  const buf = buffer.value;
  if (!buf) return;
  buffers.reattachToLive(buf.networkId, buf.target);
  // The reattach response will replace messages and trip the wholesale-
  // replace branch in MessageList's watcher (which snaps to bottom and
  // resets stickToBottom). The explicit token here is belt-and-suspenders:
  // if the response is slow, the user clicking again still requests a
  // bottom snap once the slice eventually lands.
  requestScrollToBottom();
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
  gap: 1ch;
  padding: 1ch 12px 0;
  border-top: 1px solid var(--border);
  color: var(--fg-muted);
  white-space: nowrap;
  overflow: hidden;
  /* Match the input bar's line-height (1.4 — tighter than the body default
     of 1.55 used for message text). Status + input are sibling rows of
     bottom chrome and need to share a content height; without this they
     drift apart and the sidebar-foot (also overridden to 1.4 below) and
     the input bar end up at different heights even with identical box
     padding. */
  line-height: 1.4;
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
.seg.buffer {
  color: var(--fg-muted);
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
/* Mobile-only self identity. Accent for the nick to mirror how the
   input prompt rendered it on desktop; warn-colored away tail. */
.seg.self .name {
  color: var(--accent);
}
.seg.self .away {
  color: var(--warn);
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
.seg.jump,
.seg.return-present {
  background: none;
  border: none;
  color: var(--warn);
  font: inherit;
  padding: 0;
  cursor: pointer;
}
.seg.jump:hover,
.seg.return-present:hover {
  color: var(--fg);
}
/* Emoji suggester chip body — the glyph leads, the `:shortcode:` trails
   muted so two near-identical emoji stay distinguishable. Styled here (not
   in SuggestionStrip) because slot content carries this component's scope. */
.emoji-name {
  opacity: 0.6;
}
</style>
