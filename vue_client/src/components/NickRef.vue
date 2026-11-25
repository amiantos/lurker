<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <span
    class="nick-ref"
    :class="{ interactive }"
    :style="style"
    :title="displayName ? nick : undefined"
    ><span v-if="glyph" class="mode-glyph" :class="glyphClass">{{ glyph }}</span
    ><RenderSegments v-if="displayName" :segments="nameSegments" /><template v-else>{{
      nick
    }}</template></span
  >
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useSettingsStore } from '../stores/settings.js';
import { useNickColors } from '../composables/useNickColors.js';
import { useDisplayNames } from '../composables/useDisplayNames.js';
import type { PrefixMode } from '../../../shared/channelModes.js';
import { prefixClass, prefixOf } from '../utils/memberPrefix.js';
import { formattingSegments } from '../utils/nickColor.js';
import RenderSegments from './RenderSegments.vue';

const props = withDefaults(
  defineProps<{
    nick: string;
    // Channel user-mode glyph (#376). Both must be supplied for the glyph to
    // render; callers that aren't a channel speaker just omit them.
    modes?: string[];
    showPrefix?: boolean;
    // The network's PREFIX (`modeSpec.prefix`) the modes are read against;
    // null or absent falls back to the conventional ~&@%+ table.
    prefix?: readonly PrefixMode[] | null;
    // Pointer affordance for clickable nicks (#238). The click handler is
    // attached by the consumer and reaches the root span via Vue's attribute
    // fallthrough — this prop only drives the cursor styling. Nicks open their
    // menu on left-click/tap only; right-click is left to the browser so the
    // text stays selectable for copy/paste (#426).
    interactive?: boolean;
    // Whether this is the user's own nick, when the caller knows (a reply's
    // quote carries it). Otherwise guessed from the open buffer's network nick —
    // wrong for a nick shown from another network (a search hit's quote, #998).
    self?: boolean;
    // The network the nick is on, for its display name (#607). Absent, the open
    // buffer's network is assumed — right wherever `self` is guessed the same way.
    networkId?: number | null;
    // No display name lookup: the nick is a relay bot's envelope (someone on
    // another network), which may happen to spell a local nick.
    plain?: boolean;
  }>(),
  // An explicit undefined: Vue casts an absent Boolean prop to false, which
  // would read as "not you" and switch the guess off everywhere.
  { self: undefined },
);

const networks = useNetworksStore();
const buffers = useBuffersStore();
const settings = useSettingsStore();
const nicks = useNickColors();
const displayNames = useDisplayNames();

const glyph = computed(() => (props.showPrefix ? prefixOf(props.modes, props.prefix) : ''));

// The network the nick is on: told, else the open buffer's.
const networkId = computed(() => {
  if (props.networkId != null) return props.networkId;
  const key = networks.activeKey;
  const buf = key ? buffers.byKey(key) : null;
  return buf?.networkId ?? null;
});
// A display name (#607) prints in place of the nick, in the nick's colour, with
// its own mIRC formatting on top; the nick itself moves to the title.
const displayName = computed(() =>
  props.nick && !props.plain ? displayNames.displayNameFor(networkId.value, props.nick) : null,
);
const nameSegments = computed(() => formattingSegments(displayName.value ?? ''));
// The glyph takes its rank's member colour, or with no class the nick's own
// colour from the span around it (#1403).
const glyphClass = computed(() =>
  settings.effective('look.nick.mode_prefix_nick_color')
    ? ''
    : prefixClass(props.modes, props.prefix),
);

const selfLower = computed(() => {
  const key = networks.activeKey;
  if (!key) return null;
  const buf = buffers.byKey(key);
  const sn = buf && buf.networkId != null ? networks.states[buf.networkId]?.nick : null;
  return sn ? sn.toLowerCase() : null;
});

const isSelf = computed(() => {
  if (props.self !== undefined) return props.self;
  const sl = selfLower.value;
  return !!(sl && props.nick && props.nick.toLowerCase() === sl);
});

const style = computed(() => {
  if (isSelf.value) return { color: nicks.selfColor.value };
  const c = nicks.color(props.nick);
  return c ? { color: c } : null;
});
</script>

<style scoped>
.nick-ref {
  color: inherit;
}
.nick-ref.interactive {
  cursor: pointer;
}
/* The mode glyph reuses the nicklist's per-mode colors so it reads as a status
   marker rather than part of the (separately-colored) nick. Without a mode
   class (look.nick.mode_prefix_nick_color) it inherits the nick's. */
.mode-glyph.mode-owner {
  color: var(--member-owner);
}
.mode-glyph.mode-admin {
  color: var(--member-admin);
}
.mode-glyph.mode-op {
  color: var(--member-op);
}
.mode-glyph.mode-halfop {
  color: var(--member-halfop);
}
.mode-glyph.mode-voice {
  color: var(--member-voice);
}
</style>
