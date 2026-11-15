<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->
<!--
  The standing facts about a buffer, as small dim icons after its name in the
  topic bar (#422, #646): encrypted, always-notify, muted, and for a DM, that
  the peer is logged in to services. Renders nothing when none holds.

  A new state is one more entry in `items`.
-->
<template>
  <span v-if="items.length" class="status-icons">
    <component
      :is="item.icon"
      v-for="item in items"
      :key="item.key"
      role="img"
      :aria-label="item.label"
      ><title>{{ item.label }}</title></component
    >
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { BadgeCheckIcon, BellOffIcon, BellRingIcon, LockIcon, type LucideIcon } from '@lucide/vue';
import { useBuffersStore, type Buffer } from '../stores/buffers.js';
import { useChannelNotifyStore } from '../stores/channelNotify.js';
import { useE2eChannelsStore } from '../stores/e2eChannels.js';
import { useIgnoresStore } from '../stores/ignores.js';

const props = defineProps<{ buf: Buffer }>();

const buffers = useBuffersStore();
const channelNotify = useChannelNotifyStore();
const e2eChannels = useE2eChannelsStore();
const ignores = useIgnoresStore();

interface StatusItem {
  key: string;
  icon: LucideIcon;
  label: string;
}

const items = computed<StatusItem[]>(() => {
  const { networkId, target, kind } = props.buf;
  if (networkId == null) return [];
  const out: StatusItem[] = [];
  const account = kind === 'dm' ? buffers.knownAccountFor(networkId, target) : null;
  if (account) {
    out.push({ key: 'account', icon: BadgeCheckIcon, label: `Logged in as ${account}` });
  }
  if (e2eChannels.isEnabled(networkId, target)) {
    out.push({ key: 'e2e', icon: LockIcon, label: 'End-to-end encrypted' });
  }
  if (channelNotify.notifyAlways(networkId, target)) {
    out.push({ key: 'notify', icon: BellRingIcon, label: 'Always notify' });
  }
  if (ignores.bufferMutesUnread(networkId, target)) {
    out.push({ key: 'muted', icon: BellOffIcon, label: 'Muted' });
  }
  return out;
});
</script>

<style scoped>
/* Plain inline, not a flex row, so the icons keep a vertical-align against the
   text's baseline. */
.status-icons {
  /* The topic bar's spacing between the forward button, the name and the
     topic (.topic-meta's gap in DesktopChat). */
  margin-left: calc(var(--space-4) + var(--space-2));
  color: var(--fg-muted);
}
/* The global .lucide offset, snapped to whole pixels. The text and the icon
   each round to the pixel grid on their own, so a fractional offset lands a
   pixel higher or lower depending on where the bar happens to fall on the
   page; a whole one cannot. The first declaration is for a browser without
   round(). */
.status-icons :deep(svg) {
  vertical-align: var(--icon-valign);
  vertical-align: round(var(--icon-valign), 1px);
}
.status-icons :deep(svg + svg) {
  margin-left: var(--space-2);
}
</style>
