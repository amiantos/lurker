<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <AppModal
    :word="isEdit ? 'edit' : 'network'"
    :title="isEdit ? 'edit network' : 'add network'"
    size="sm"
    @close="$emit('close')"
  >
    <form class="net-form" @submit.prevent="submit">
      <label>
        <span>Name</span>
        <input v-model="form.name" placeholder="Libera" required />
      </label>
      <div class="row">
        <label class="grow">
          <span>Host</span>
          <input v-model="form.host" placeholder="irc.libera.chat" required />
        </label>
        <label class="port">
          <span>Port</span>
          <input v-model.number="form.port" type="number" min="1" max="65535" />
        </label>
        <label class="tls">
          <span>TLS</span>
          <input v-model="form.tls" type="checkbox" />
        </label>
      </div>
      <label>
        <span>Nick</span>
        <input v-model="form.nick" required />
      </label>
      <label>
        <span>Real name (optional)</span>
        <input v-model="form.realname" />
      </label>
      <button type="button" class="advanced-toggle" @click="showAdvanced = !showAdvanced">
        {{ showAdvanced ? '− Advanced options' : '+ Advanced options' }}
      </button>
      <div v-if="showAdvanced" class="advanced">
        <label>
          <span>Server password (optional)</span>
          <input
            v-model="form.server_password"
            type="password"
            autocomplete="off"
            :placeholder="isEdit && props.network?.has_password ? '(saved — type to replace)' : ''"
          />
        </label>
        <div class="row">
          <label class="grow">
            <span>SASL account (optional)</span>
            <input
              v-model="form.sasl_account"
              :placeholder="form.nick || 'defaults to nick'"
              autocomplete="off"
            />
          </label>
          <label class="grow">
            <span>SASL password (optional)</span>
            <input
              v-model="form.sasl_password"
              type="password"
              autocomplete="off"
              :placeholder="
                isEdit && props.network?.has_sasl_password ? '(saved — type to replace)' : ''
              "
            />
          </label>
        </div>
        <label v-if="!isEdit">
          <span>Default channel</span>
          <input v-model="form.default_channel" placeholder="#lurker" />
        </label>
        <label>
          <span>Commands to run on connect</span>
          <textarea
            v-model="form.connect_commands"
            rows="4"
            autocomplete="off"
            spellcheck="false"
            placeholder="AUTH <user> <password> etc…"
          />
          <small
            >One per line, e.g. for opering up on connect. If you need to add a (eg, 15 sec) delay
            between commands, you can write: WAIT 15</small
          >
        </label>
        <label class="check">
          <input v-model="form.autoconnect" type="checkbox" />
          <span>Reconnect automatically</span>
        </label>
      </div>
      <p v-if="error" class="error">{{ error }}</p>
      <div class="actions">
        <button v-if="isEdit" type="button" class="danger" :disabled="loading" @click="remove">
          Delete
        </button>
        <button v-if="isEdit" type="button" class="ghost" :disabled="loading" @click="reconnect">
          Reconnect
        </button>
        <span class="spacer"></span>
        <button type="button" class="ghost" @click="$emit('close')">Cancel</button>
        <button type="submit" :disabled="loading">
          {{ loading ? 'Saving…' : isEdit ? 'Save' : 'Save & connect' }}
        </button>
      </div>
    </form>
  </AppModal>
</template>

<script setup lang="ts">
import { reactive, ref, computed } from 'vue';
import AppModal from './AppModal.vue';
import { useNetworksStore, type Network } from '../stores/networks.js';

const props = withDefaults(
  defineProps<{
    network?: Network | null;
  }>(),
  {
    network: null,
  },
);
const emit = defineEmits<{ close: [] }>();
const networks = useNetworksStore();

const isEdit = computed(() => !!props.network);

// Cast to a loose record so we can read extra API fields not declared in
// the typed Network interface (sasl_account, autoconnect, connect_commands, etc.).
const netRaw = props.network as Record<string, unknown> | null;

const form = reactive({
  name: props.network?.name ?? '',
  host: props.network?.host ?? '',
  port: props.network?.port ?? 6697,
  tls: props.network ? !!props.network.tls : true,
  nick: props.network?.nick ?? '',
  realname: (netRaw?.realname as string | undefined) ?? '',
  server_password: '',
  sasl_account: (netRaw?.sasl_account as string | undefined) ?? '',
  sasl_password: '',
  default_channel: '#lurker',
  autoconnect: netRaw ? !!netRaw.autoconnect : true,
  connect_commands: (netRaw?.connect_commands as string | undefined) ?? '',
});

// Auto-expand advanced when editing a row that already has any advanced value
// set, so the user doesn't have to hunt for a saved password or connect script
// they configured previously.
const showAdvanced = ref(
  !!props.network &&
    (!!netRaw?.has_password ||
      !!netRaw?.has_sasl_password ||
      !!netRaw?.sasl_account ||
      !!netRaw?.connect_commands ||
      netRaw?.autoconnect === false),
);

const loading = ref(false);
const error = ref<string | null>(null);

async function submit(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    if (isEdit.value && props.network) {
      const patch: Record<string, unknown> = {
        name: form.name,
        host: form.host,
        port: form.port,
        tls: form.tls,
        nick: form.nick,
        realname: form.realname,
        sasl_account: form.sasl_account,
        autoconnect: form.autoconnect,
        connect_commands: form.connect_commands,
      };
      if (form.server_password) patch.server_password = form.server_password;
      if (form.sasl_password) patch.sasl_password = form.sasl_password;
      // Saving only persists the row — it never cycles the live connection.
      // Connection-relevant edits (host/port/nick/credentials) take effect on
      // the next connect; the explicit "Reconnect" button below applies them
      // now if the user wants that.
      await networks.update(props.network.id, patch);
    } else {
      await networks.create({ ...form });
    }
    emit('close');
  } catch (err: unknown) {
    error.value = (err instanceof Error ? err.message : null) || 'failed to save network';
  } finally {
    loading.value = false;
  }
}

async function reconnect(): Promise<void> {
  if (!props.network) return;
  loading.value = true;
  error.value = null;
  try {
    await networks.reconnect(props.network.id);
    emit('close');
  } catch (err: unknown) {
    error.value = (err instanceof Error ? err.message : null) || 'failed to reconnect';
    loading.value = false;
  }
}

async function remove(): Promise<void> {
  if (!props.network) return;
  if (!confirm(`Delete network "${props.network.name}"? This disconnects and removes its history.`))
    return;
  loading.value = true;
  error.value = null;
  try {
    await networks.remove(props.network.id);
    emit('close');
  } catch (err: unknown) {
    error.value = (err instanceof Error ? err.message : null) || 'failed to delete network';
    loading.value = false;
  }
}
</script>

<style scoped>
/* Scroll within the card when advanced options stretch the form past the
   modal's max-height; the AppModal shell already clips and centers. */
.net-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  /* Match the breakout pattern from SearchModal/RecentUploadsModal so the
     scrollbar sits against the card border instead of inside the padding. */
  margin: 0 calc(-1 * var(--card-pad-x));
  padding: 0 var(--card-pad-x);
}
label {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  color: var(--fg-muted);
}
label span {
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
/* width:100% + border-box keeps inputs sized to their label rather than their
   intrinsic (size=20) width, so flex columns can't be pushed wider than the
   card. */
label input,
label textarea {
  color: var(--fg);
  width: 100%;
  box-sizing: border-box;
}
label textarea {
  font-family: inherit;
  resize: vertical;
  min-height: 80px;
}
label small {
  color: var(--fg-muted);
  margin-top: var(--space-1);
  text-transform: none;
  letter-spacing: normal;
}
.advanced-toggle {
  align-self: flex-start;
  background: transparent;
  border: 0;
  padding: var(--space-2) 0;
  color: var(--accent);
  cursor: pointer;
  text-transform: lowercase;
}
.advanced-toggle:hover {
  text-decoration: underline;
}
.advanced {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}
.row {
  display: flex;
  gap: var(--space-4);
  align-items: end;
}
/* min-width:0 lets a flex item shrink below its content's intrinsic width —
   without it two side-by-side inputs (the SASL row) overflow the card. */
.grow {
  flex: 1;
  min-width: 0;
}
.port {
  width: 80px;
}
.tls {
  width: 48px;
  align-items: center;
}
.tls input {
  width: auto;
  transform: scale(1.1);
}
.check {
  flex-direction: row;
  align-items: center;
  gap: var(--space-4);
}
.check input {
  width: auto;
}
.check span {
  text-transform: none;
  letter-spacing: normal;
  color: var(--fg);
  font-size: inherit;
}
.actions {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  margin-top: var(--space-3);
}
.spacer {
  flex: 1;
}
.ghost {
  border-color: var(--border);
}
.danger {
  color: var(--bad);
  border-color: var(--bad);
}
.danger:hover:not(:disabled) {
  background: var(--bad);
  color: var(--bg);
  border-color: var(--bad);
}
.error {
  color: var(--bad);
  margin: 0;
}
</style>
