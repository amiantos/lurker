<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<!--
  A nick's avatar (#607): a square in the nick's colour with one image of the
  active tile set over it, or the avatar the user set through IRCv3 metadata
  (served by the media proxy, never the origin) when there is one. That one
  is drawn over nothing (#1315): a round or cut-out picture should not sit on
  a square of the nick's colour. An image that fails to load falls back to
  the tile, so a dead URL never leaves a blank. Sized by the --avatar-size custom property the surface sets.

  A `mark` tile (#1180) is a placeholder, never a face, an initial or a
  metadata picture: a notice's is a megaphone over the nick's colour, and the
  network's own voice (the server buffer's text, system and status lines) is
  a server over the network's, hashed as the system buffer hashes its name.
  A notice's "nick" is often not a person
  (the server's hostname, Lurker's own status lines), and the glyph says what
  the line is where a face would say who.
-->

<template>
  <span
    class="nick-avatar"
    :class="{
      interactive,
      metadata: fromMetadata,
      'mark-notice': mark === 'notice',
      'mark-server': mark === 'server',
    }"
    :style="{ background: fromMetadata ? 'transparent' : (color ?? undefined) }"
    :title="nick"
    role="img"
    :aria-label="nick"
    ><MegaphoneIcon
      v-if="mark === 'notice'"
      class="mark"
      :class="ink"
      aria-hidden="true"
    /><ServerIcon v-else-if="mark === 'server'" class="mark" :class="ink" aria-hidden="true" /><img
      v-else-if="src"
      :src="src"
      alt=""
      draggable="false"
      @error="onError"
    /><span v-else-if="initial" class="initial" :class="ink" aria-hidden="true">{{
      initial
    }}</span></span
  >
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { MegaphoneIcon, ServerIcon } from '@lucide/vue';
import { useNetworksStore } from '../stores/networks.js';
import { useAvatarSetsStore } from '../stores/avatarSets.js';
import { useNickColors } from '../composables/useNickColors.js';
import { useDisplayNames } from '../composables/useDisplayNames.js';
import { themeColor } from '../lib/cssColor.js';
import { avatarInk } from '../../../shared/avatarTiles.js';

const props = withDefaults(
  defineProps<{
    nick: string;
    // The network the nick is on, for its metadata avatar and self colour.
    networkId?: number | null;
    // Pointer affordance; the click handler is the consumer's (attribute fallthrough).
    interactive?: boolean;
    // Whether this is the user's own line, when the caller knows (the row's
    // stored flag). Otherwise guessed from the network's current nick — wrong
    // for a line sent under a nick since changed.
    self?: boolean;
    // No metadata avatar: the nick is a relay bot's envelope (someone on
    // another network); the generated tile still shows.
    plain?: boolean;
    // A placeholder in place of the picture: a notice's megaphone or the
    // network's server, over the colour `nick` hashes to. No image or
    // initial, no metadata lookup.
    mark?: 'notice' | 'server' | null;
  }>(),
  // An explicit undefined: Vue casts an absent Boolean prop to false, which
  // would read as "not you" and switch the guess off everywhere.
  { networkId: null, interactive: false, self: undefined, plain: false, mark: null },
);

const networks = useNetworksStore();
const avatarSets = useAvatarSetsStore();
const nicks = useNickColors();
const displayNames = useDisplayNames();

onMounted(() => {
  void avatarSets.ensureBuiltins();
});

const meta = computed(() =>
  props.plain || props.mark ? null : networks.metadataFor(props.networkId, props.nick),
);
const failed = ref(false);
// A new URL gets its own chance.
watch(
  () => meta.value?.avatarUrl,
  () => {
    failed.value = false;
  },
);
const fromMetadata = computed(() => !!meta.value?.avatarUrl && !failed.value);

const isSelf = computed(() => {
  if (props.self !== undefined) return props.self;
  const own = props.networkId != null ? networks.states[props.networkId]?.nick : null;
  return !!own && !!props.nick && own.toLowerCase() === props.nick.toLowerCase();
});
const color = computed(() => {
  if (isSelf.value) return nicks.selfColorOn(props.networkId);
  return props.nick ? nicks.color(props.nick, props.networkId) : null;
});
// What reads on that colour, near-white or near-black: the letter's ink, the
// silhouette's, a placeholder glyph's. The colour is any CSS the user typed,
// so the engine says what it is. A nick with no colour, or one the engine
// cannot read, leaves the tile on its own background (.avatar, --bg-soft).
const ink = computed(() => avatarInk(themeColor(color.value) ?? themeColor('var(--bg-soft)')));

const src = computed(() => {
  if (fromMetadata.value) return meta.value!.avatarUrl as string;
  return props.nick ? avatarSets.tileFor(props.nick, ink.value) : null;
});
// An Initial set: the first letter of what the head prints — the display
// name where there is one, else the nick.
const initial = computed(() => {
  if (avatarSets.activeSet?.kind !== 'initial' || !props.nick) return null;
  const shown = props.plain ? null : displayNames.plainDisplayNameFor(props.networkId, props.nick);
  const first = Array.from(shown ?? props.nick)[0];
  return first ? first.toUpperCase() : null;
});

function onError(): void {
  if (fromMetadata.value) failed.value = true;
}
</script>

<style scoped>
.nick-avatar {
  display: inline-block;
  width: var(--avatar-size, 2.25em);
  height: var(--avatar-size, 2.25em);
  border-radius: var(--radius-md);
  overflow: hidden;
  flex-shrink: 0;
  background: var(--bg-soft);
  vertical-align: middle;
}
.nick-avatar img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.nick-avatar.interactive {
  cursor: pointer;
}
/* The Initial sets: one letter, centred, faded the way the silhouettes are
   so the colour shows through. A deliberate exception to the one-font-size
   rule, with the icon tokens: the letter is a glyph standing in for an
   image, so it scales with the tile (half its height), not with the text. */
.nick-avatar .initial {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  font-size: calc(var(--avatar-size, 2.25em) * 0.5);
  font-weight: 600;
  line-height: 1;
  user-select: none;
}
.nick-avatar .initial.light,
.nick-avatar .mark.light {
  color: rgba(255, 255, 255, 0.85);
}
.nick-avatar .initial.dark,
.nick-avatar .mark.dark {
  color: rgba(28, 26, 30, 0.85);
}
/* The placeholders: a glyph centred and sized like an initial, half the
   tile, through the icon token the global .lucide box reads. Classed
   mark-*, not `notice`: the root of a child component wears its parent's
   scoped rules too, and MessageList has a `.notice` for its dividers. */
.nick-avatar.mark-notice,
.nick-avatar.mark-server {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.nick-avatar .mark {
  --icon-size: calc(var(--avatar-size, 2.25em) * 0.5);
  vertical-align: 0;
}
</style>
