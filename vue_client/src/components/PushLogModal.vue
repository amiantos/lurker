<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0

  The push trail (#1272): which of your clients are connected, and what became
  of every notification this server tried to send you in the last week. It is
  what you read when a notification did not arrive, so it opens from Settings →
  Notifications on request rather than sitting in the pane between the device
  list and the switches, a week of rows deep.
-->

<template>
  <!-- To body, as NewInviteModal does: the settings layout gives a fixed-position
       card a containing block, so rendered in place it would cover only the
       pane's column, not the page. -->
  <Teleport to="body">
    <AppModal word="push" title="push log" size="lg" fill-height @close="$emit('close')">
      <div class="push-trail">
        <p v-if="error" class="error">{{ error }}</p>

        <h3>current clients</h3>
        <p class="desc">
          Push fires only while none of these is visible. A tab you left in front, or the app open
          on your phone, is the usual reason a notification stayed put.
        </p>
        <ul v-if="store.clients.length" class="rows">
          <li v-for="(c, i) in store.clients" :key="i" class="client-row">
            <span class="who">{{ clientLabel(c.userAgent) }}</span>
            <MetaLine :parts="clientMeta(c)" />
          </li>
        </ul>
        <p v-else class="desc">No client is connected.</p>

        <h3>recent pushes</h3>
        <p class="desc">
          Every notification this server tried to send you in the last week, and what became of it.
          A "sent" line means the push service took it; after that it's the device's.
        </p>
        <ul v-if="store.log.length" class="rows">
          <li v-for="row in store.log" :key="row.id" class="push-row" :class="row.outcome">
            <span class="when" :title="row.at">{{ formatDateTime(row.at) }}</span>
            <span class="what">{{ kindLabel(row.kind) }} · {{ subjectLabel(row) }}</span>
            <span class="how">{{ outcomeLabel(row) }}</span>
          </li>
        </ul>
        <p v-else-if="store.logLoaded" class="desc">Nothing in the last week.</p>
        <p v-if="store.logHasMore" class="older">
          <button type="button" class="btn-secondary" :disabled="olderBusy" @click="onOlder">
            {{ olderBusy ? 'loading…' : 'show older' }}
          </button>
        </p>
      </div>
    </AppModal>
  </Teleport>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import AppModal from './AppModal.vue';
import MetaLine from './MetaLine.vue';
import { usePushSubscriptionsStore } from '../stores/pushSubscriptions.js';
import { formatRelative, formatDateTime } from '../utils/timestamp.js';
import { clientLabel, kindLabel, outcomeLabel, subjectLabel } from '../utils/pushLog.js';
import type { MetaPart } from '../utils/metaLine.js';

defineEmits<{ close: [] }>();

const store = usePushSubscriptionsStore();
const error = ref('');
const olderBusy = ref(false);

function clientMeta(c: { visible: boolean; connectedAt?: string | null }): MetaPart[] {
  return [
    c.visible ? 'visible' : 'in the background',
    c.connectedAt && `since ${formatRelative(c.connectedAt)}`,
  ];
}

// Fetched on open, so the trail is as of now and not as of when Settings loaded.
onMounted(() => {
  store.fetchLog().catch((e: any) => {
    error.value = e.message || 'failed to load the push log';
  });
  store.fetchClients().catch(() => {});
});

async function onOlder() {
  olderBusy.value = true;
  try {
    await store.fetchOlderLog();
  } catch (e: any) {
    error.value = e.message || 'failed to load older rows';
  } finally {
    olderBusy.value = false;
  }
}
</script>

<style scoped>
/* The body is what scrolls; it breaks out to the card's edges so the scrollbar
   sits against the border. */
.push-trail {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  margin: 0 calc(-1 * var(--card-pad-x));
  padding: 0 var(--card-pad-x);
}
h3 {
  margin: var(--space-9) 0 var(--space-3);
  padding-bottom: var(--space-3);
  border-bottom: 1px solid var(--border);
  color: var(--fg-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-weight: 600;
}
h3:first-of-type {
  margin-top: 0;
}
.desc {
  margin: 0 0 var(--space-4);
  color: var(--fg-muted);
}
.error {
  color: var(--bad);
  margin: 0 0 var(--space-3);
}
.rows {
  list-style: none;
  margin: 0;
  padding: 0;
}
.client-row,
.push-row {
  padding: var(--space-3) 0;
  border-top: 1px solid var(--border);
}
.client-row:first-child,
.push-row:first-child {
  border-top: none;
}
.client-row {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  column-gap: var(--space-6);
}
.client-row :deep(.meta-line) {
  color: var(--fg-muted);
}
.push-row {
  display: grid;
  grid-template-columns: max-content 1fr;
  column-gap: var(--space-6);
}
.push-row .when {
  color: var(--fg-muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.push-row .how {
  grid-column: 2;
  color: var(--fg-muted);
  overflow-wrap: anywhere;
}
.push-row.sent .how {
  color: var(--fg);
}
.push-row.failed .how {
  color: var(--bad);
}
.older {
  margin: var(--space-4) 0 0;
}
</style>
