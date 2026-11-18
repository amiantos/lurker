<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0

  A form in a modal: the shell every "add" and "edit" in the Settings panes opens
  (a highlight, an ignore, an alias, an API token). Those forms used to sit under
  the list they add to, and turn into an edit form in place when a row's pen was
  pressed, with the list still live above them.

  The caller keeps the form's state and passes the fields as the default slot, so
  the pane's own scoped styles still reach them. The fields scroll; Cancel and the
  submit button are pinned beneath. The footer stays inside the <form>, so Enter
  submits (an IME's confirming Enter does not). Replace the `footer` slot for a
  stage that isn't a submit, as the API-token reveal does.
-->

<template>
  <!-- To body, as NewInviteModal does: the settings layout gives a fixed-position
       card a containing block, so rendered in place it would cover only the
       pane's column, not the page. -->
  <Teleport to="body">
    <!-- Escape and the header's X are closes too, and Cancel is disabled while a
         save is out: a close then would drop the form its answer belongs to, so
         a refusal had nowhere to show and a success could close a later form. -->
    <AppModal :word="word" :title="title" :size="size" @close="busy || $emit('close')">
      <form class="modal-form" @submit.prevent="$emit('submit')" @keydown.enter="blockImeEnter">
        <div class="form-body">
          <slot />
          <p v-if="error" class="form-error">{{ error }}</p>
        </div>
        <footer class="modal-footer">
          <slot name="footer">
            <button type="button" class="btn-secondary" :disabled="busy" @click="$emit('close')">
              Cancel
            </button>
            <button type="submit" class="btn-primary" :disabled="busy || !canSubmit">
              {{ submitLabel }}
            </button>
          </slot>
        </footer>
      </form>
    </AppModal>
  </Teleport>
</template>

<script setup lang="ts">
import AppModal from './AppModal.vue';
import { blockImeEnter } from '../composables/useImeSafeInput.js';

withDefaults(
  defineProps<{
    /** The backdrop wallpaper word. */
    word: string;
    title: string;
    submitLabel?: string;
    canSubmit?: boolean;
    busy?: boolean;
    /** Why the last submit was refused; shown under the fields. */
    error?: string;
    size?: string;
  }>(),
  { submitLabel: 'Save', canSubmit: true, busy: false, error: '', size: 'md' },
);

defineEmits<{ submit: []; close: [] }>();
</script>

<style scoped>
/* What scrolls, out to the card's edges so the scrollbar sits on its border. */
.form-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  margin: 0 calc(-1 * var(--card-pad-x));
  padding: 0 var(--card-pad-x) var(--space-6);
}
.form-error {
  margin: var(--space-4) 0 0;
  color: var(--bad);
}
/* A pane's helper text, outside the pane: panes.css scopes .muted to
   .settings-pane, which a teleported form is no longer inside. */
.form-body :deep(.muted) {
  color: var(--fg-muted);
}
</style>
