<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <div v-if="urls.length" class="attachments">
    <MessageAttachment v-for="url in urls" :key="url" :url="url" />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useSettingsStore } from '../stores/settings.js';
import { previewableUrls } from '../utils/previewUrls.js';
import MessageAttachment from './MessageAttachment.vue';

// Decides WHICH urls in a message are worth asking the server about; the
// selection rule itself lives in utils/previewUrls so it can be tested without
// mounting anything. Rendering any one of them is MessageAttachment's problem.
//
// Both settings off and this component never mounts a child, never makes a
// request, and costs one regex pass over text we had already tokenised anyway.
const props = defineProps<{ text: string | null | undefined }>();

const settings = useSettingsStore();

const urls = computed(() =>
  previewableUrls(props.text, {
    inlineMedia: settings.effective('chat.inline_media.enabled') === true,
    linkPreviews: settings.effective('chat.link_previews.enabled') === true,
  }),
);
</script>

<style scoped>
.attachments {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-top: var(--space-2);
  /* Attachments hang under the message body, and a card that stretched the full
     width of a wide window would read as a page element rather than as part of
     the message. */
  max-width: 480px;
}
</style>
