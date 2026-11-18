<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0

  Add or edit one uploader, in a modal. The form used to open inline beneath the
  list it came from, where it replaced the "add" section while an edit was open
  and left the list's own buttons live beside a half-filled form. A modal says
  which uploader the fields belong to and that nothing else is in play.

  Shared by Settings → Uploads and Admin → Uploaders: the caller owns the request
  and passes `busy` / `error` back, as it did for the inline form.

  Adding: `drivers` is the creatable set and a Type picker leads the form (hidden
  when there is only one type to pick). Editing: `drivers` is the one driver of
  `existing`, and the type is fixed.
-->

<template>
  <!-- Not closable while a save is out (Escape and the X included): a refusal
       is shown in this form, with what was typed.
       To body, as NewInviteModal does: the settings layout gives a fixed-position
       card a containing block, so rendered in place it would cover only the
       pane's column, not the page. -->
  <Teleport to="body">
    <AppModal
      word="upload"
      :title="existing ? `edit ${existing.label}` : 'add uploader'"
      size="sm"
      @close="busy || $emit('close')"
    >
      <label v-if="!existing && drivers.length > 1" class="driver-pick">
        <span>Type</span>
        <select v-model="driverId" :disabled="busy">
          <option v-for="d in drivers" :key="d.driver" :value="d.driver">{{ d.label }}</option>
        </select>
      </label>
      <!-- Keyed on what it edits: the form seeds its fields once, at setup. -->
      <UploaderConfigForm
        v-if="driver"
        :key="driver.driver"
        :driver="driver"
        :existing="existing"
        :busy="busy"
        :error="error"
        @save="$emit('save', { driver: driver.driver, ...$event })"
        @cancel="$emit('close')"
      />
    </AppModal>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import AppModal from './AppModal.vue';
import UploaderConfigForm from './UploaderConfigForm.vue';
import type { UploaderDriver, UploaderDraft } from '../utils/uploaders.js';

const props = defineProps<{
  drivers: UploaderDriver[];
  /** Editing: the uploader's label, non-secret config and which secrets are set. */
  existing?: { label: string; config: Record<string, string>; secretsSet: Record<string, boolean> };
  busy?: boolean;
  error?: string;
}>();

defineEmits<{
  save: [payload: UploaderDraft];
  close: [];
}>();

const driverId = ref(props.drivers[0]?.driver ?? '');
const driver = computed(() => props.drivers.find((d) => d.driver === driverId.value));
</script>

<style scoped>
.driver-pick {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-bottom: var(--space-7);
}
.driver-pick > span {
  color: var(--fg);
}
</style>
