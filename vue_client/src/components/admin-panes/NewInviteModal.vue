<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0

  Two stages. First, configure an invite link: how long it lasts, and the
  restrictions the account it creates starts with (shared/accountRestrictions.ts),
  so a limited account never exists unrestricted between acceptance and the
  Users pane. Then the link itself, copied to the clipboard on arrival, with a
  copy button for when that was refused, and done. The store already lists the
  new invite; the pane needs nothing from here but `close`.
-->

<template>
  <!-- To body, as ColorPicker does: the settings layout gives a fixed-position
       card a containing block, so rendered in place it would cover only the
       pane's column, not the page. -->
  <Teleport to="body">
    <AppModal
      word="invite"
      :title="created ? 'invite link' : 'new invite link'"
      size="sm"
      @close="$emit('close')"
    >
      <div v-if="created" class="modal-form">
        <div class="invite-form">
          <p class="hint">Share this link. It works once.</p>
          <code class="url">{{ created.url }}</code>
          <p v-if="summary" class="hint">{{ summary }}</p>
        </div>
        <footer class="modal-footer">
          <button type="button" class="btn-secondary" @click="copy(created.url)">
            {{ copied ? 'copied' : 'copy link' }}
          </button>
          <button type="button" class="btn-primary" @click="$emit('close')">Done</button>
        </footer>
      </div>
      <form v-else class="modal-form" @submit.prevent="create">
        <div class="invite-form">
          <label>
            <span>link expires in</span>
            <select v-model.number="expiresInDays" :disabled="busy">
              <option :value="1">1 day</option>
              <option :value="7">7 days</option>
              <option :value="30">30 days</option>
            </select>
          </label>
          <fieldset class="limits">
            <legend>the account it creates</legend>
            <RestrictionsFields v-model="restrictions" :disabled="busy" />
            <p v-if="noNetworks" class="hint warn">List at least one network, or allow any.</p>
          </fieldset>
          <p v-if="error" class="error">{{ error }}</p>
        </div>
        <footer class="modal-footer">
          <button type="button" class="btn-secondary" :disabled="busy" @click="$emit('close')">
            Cancel
          </button>
          <button type="submit" class="btn-primary" :disabled="busy || noNetworks || badHost">
            {{ busy ? 'Creating…' : 'Create link' }}
          </button>
        </footer>
      </form>
    </AppModal>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import AppModal from '../AppModal.vue';
import RestrictionsFields from '../RestrictionsFields.vue';
import { useAdminStore, type AdminInvite } from '../../stores/admin.js';
import { useCopyFeedback } from '../../composables/useCopyFeedback.js';
import { describeRestrictions } from '../../utils/accountRestrictions.js';
import {
  hostListProblem,
  isUnrestricted,
  UNRESTRICTED,
  type AccountRestrictions,
} from '../../../../shared/accountRestrictions.js';

defineEmits<{ close: [] }>();

const adminStore = useAdminStore();
const expiresInDays = ref(7);
const restrictions = ref<AccountRestrictions>({ ...UNRESTRICTED });
const busy = ref(false);
const error = ref('');
// Stage two: the link that was made.
const created = ref<AdminInvite | null>(null);
const { copied, copy } = useCopyFeedback();
const summary = computed(() => describeRestrictions(created.value?.restrictions));
// A link whose account could connect nowhere is a dead end; the server refuses
// it too, this just says so before the click.
const noNetworks = computed(
  () => restrictions.value.networks !== null && restrictions.value.networks.length === 0,
);
// A host the server would refuse (the fields say which); nothing to create yet.
const badHost = computed(
  () => restrictions.value.networks !== null && !!hostListProblem(restrictions.value.networks),
);

async function create(): Promise<void> {
  if (noNetworks.value || badHost.value) return;
  error.value = '';
  busy.value = true;
  try {
    const invite = await adminStore.createInvite({
      expiresInDays: expiresInDays.value,
      ...(isUnrestricted(restrictions.value) ? {} : { restrictions: restrictions.value }),
    });
    created.value = invite;
    // Best effort, like every copy in the app: the button is there for when
    // the clipboard refuses without a gesture.
    void copy(invite.url);
  } catch (e: any) {
    error.value = e.message || 'failed to create invite';
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped>
.invite-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
  padding-bottom: var(--space-6);
}
.invite-form > label {
  display: flex;
  align-items: baseline;
  gap: var(--space-3);
}
.limits {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  border: 1px solid var(--border);
  padding: var(--space-4);
  margin: 0;
}
.limits legend {
  color: var(--fg-muted);
  padding: 0 var(--space-2);
}
.hint {
  color: var(--fg-muted);
  margin: 0;
}
.hint.warn {
  color: var(--warn);
}
.url {
  display: block;
  background: var(--bg-soft);
  padding: var(--space-2) var(--space-3);
  word-break: break-all;
  user-select: all;
}
</style>
