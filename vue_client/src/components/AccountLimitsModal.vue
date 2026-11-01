<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<!--
  What a held account can't do, where it just tried to (useAccountLimits.ts):
  the add-network +, attach, Shares. On a hosted cell a held account is a free
  one and paying lifts it, so the modal is the subscribe pitch: the service's
  own words, and a button to the control plane's account page on this origin,
  named for where it lands (the page's Plan section) rather than for the sale. Self-hosted, the admin set the limits and a sentence built from the
  restriction set is the whole answer.
-->

<template>
  <AppModal
    :word="config.isNode ? 'subscribe' : 'limits'"
    :title="config.isNode ? 'Subscribe for all features' : 'account limits'"
    size="sm"
    @close="$emit('close')"
  >
    <div class="modal-form">
      <div class="body">
        <p v-for="line in config.isNode ? HOSTED_PITCH : [sentence]" :key="line">{{ line }}</p>
      </div>
      <footer class="modal-footer">
        <button type="button" class="btn-secondary" @click="$emit('close')">Close</button>
        <a v-if="config.isNode" class="btn-primary subscribe" href="/account">Manage plan</a>
      </footer>
    </div>
  </AppModal>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import AppModal from './AppModal.vue';
import { useAuthStore } from '../stores/auth.js';
import { useConfigStore } from '../stores/config.js';

defineEmits<{ close: [] }>();

const auth = useAuthStore();
const config = useConfigStore();

// The hosted service's own words: on a cell the one held account is a free
// one, so the copy can name what it is and what paying adds.
const HOSTED_PITCH = [
  'Your free Lurker.Chat account can only connect to the Lurker.Chat IRC Server, and you ' +
    'cannot upload content to the Lurker.Chat CDN.',
  'Subscribe for access to all features, and to connect to any IRC network.',
];

// Self-hosted: built from the restriction set itself, so an account held only
// from uploading is not told about networks, and the other way round.
const sentence = computed(() => {
  const hosts = auth.allowedNetworkHosts;
  const parts: string[] = [];
  if (hosts !== null) parts.push(`can only connect to ${hosts.join(', ') || 'no networks'}`);
  if (!auth.canUpload) parts.push("can't upload files");
  if (parts.length === 0) return 'This account has no limits.';
  return `This account ${parts.join(', and ')}.`;
});
</script>

<style scoped>
.body {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  /* The card pads the sides; adding more here would indent the paragraph
     from the title above it. */
  padding: var(--space-2) 0 var(--space-9);
  line-height: 1.5;
}
.body p {
  margin: 0;
}
.subscribe {
  text-decoration: none;
}
</style>
