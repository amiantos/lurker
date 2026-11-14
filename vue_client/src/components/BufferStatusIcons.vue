<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->
<!--
  The status slot of a buffer-list row (#422): small dim icons for standing
  facts about the buffer, as opposed to the badges after it, which count what
  is waiting. It sits between the name and the badges and takes the row's
  spare width, so the icons hug the name and the badges stay at the edge.

  A new state is one more entry in `items`.
-->
<template>
  <span class="status-icons">
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
import { BellOffIcon, BellRingIcon, LockIcon, type LucideIcon } from '@lucide/vue';
import type { Buffer } from '../stores/buffers.js';
import { useChannelNotifyStore } from '../stores/channelNotify.js';
import { useE2eChannelsStore } from '../stores/e2eChannels.js';
import { useIgnoresStore } from '../stores/ignores.js';

const props = defineProps<{ buf: Buffer }>();

const channelNotify = useChannelNotifyStore();
const e2eChannels = useE2eChannelsStore();
const ignores = useIgnoresStore();

interface StatusItem {
  key: string;
  icon: LucideIcon;
  label: string;
}

const items = computed<StatusItem[]>(() => {
  const { networkId, target } = props.buf;
  if (networkId == null) return [];
  const out: StatusItem[] = [];
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
.status-icons {
  flex: 1 0 auto;
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding-left: var(--space-2);
  color: var(--fg-muted);
}
</style>
