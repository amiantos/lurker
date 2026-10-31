<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<!--
  What a held account can't do, in one sentence, where it just tried to
  (useAccountLimits.ts): the add-network +, attach, Shares. On a hosted cell a
  held account is a free one and paying lifts it, so the footer's action is
  Subscribe, which goes to the control plane's account page on this origin.
  Self-hosted, the admin set the limits and the sentence is the whole answer.
-->

<template>
  <AppModal word="limits" title="account limits" size="sm" @close="$emit('close')">
    <div class="modal-form">
      <p class="body">{{ sentence }}</p>
      <footer class="modal-footer">
        <button type="button" class="btn-secondary" @click="$emit('close')">Close</button>
        <a v-if="config.isNode" class="btn-primary subscribe" href="/account">Subscribe</a>
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

// Built from the restriction set itself, so an account held only from
// uploading is not told about networks, and the other way round.
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
  margin: 0;
  padding: var(--space-3) var(--space-4);
}
.subscribe {
  text-decoration: none;
}
</style>
