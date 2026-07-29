<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <div v-if="urls.length" class="attachments">
    <MessageAttachment v-for="url in urls" :key="url" :url="url" @measured="$emit('measured')" />
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

// Bubbles up from an image that had no server-side dimensions and therefore grew the row
// when it decoded. The message list re-pins the viewport on it.
defineEmits<{ measured: [] }>();

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
  /* ⚠ NOT the default `stretch`. A flex column stretches its children across the
     cross axis, which forced every inline image to the container's full width while
     `max-height` capped its height — squashing it instead of scaling it. Images size
     themselves from their own dimensions; only the cards want the full width. */
  align-items: flex-start;
  gap: var(--space-2);
  margin-top: var(--space-2);
  /* Attachments hang under the message body, and a card that stretched the full
     width of a wide window would read as a page element rather than as part of
     the message. */
  max-width: 480px;
}
/* The card is the one attachment that wants the width it's given — its text has to wrap
   against something. Undoes the container's flex-start for cards only. */
.attachments > :deep(.card) {
  align-self: stretch;
}
</style>
