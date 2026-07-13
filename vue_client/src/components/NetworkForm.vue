<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <AppModal
    :word="isEdit ? 'edit' : 'network'"
    :title="isEdit ? 'edit network' : 'add network'"
    size="sm"
    :fill-height="step === 'pick'"
    @close="$emit('close')"
  >
    <NetworkPicker v-if="step === 'pick'" @select="onPick" @manual="onManual" />

    <form v-else class="modal-form" @submit.prevent="submit">
      <div class="net-form">
        <button v-if="!isEdit" type="button" class="back-link" @click="step = 'pick'">
          ← {{ picked ? picked.name : 'pick a network' }}
        </button>
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
        <p v-if="showSaslHint" class="sasl-hint">
          <strong>{{ picked?.name }}</strong> blocks unauthenticated connections from hosted
          servers, so the SASL account and password below are <strong>not optional</strong> —
          register your nick with the network first, then enter it here.
        </p>
        <div class="row">
          <label class="grow">
            <span>SASL account{{ saslRequired ? '' : ' (optional)' }}</span>
            <input
              v-model="form.sasl_account"
              :placeholder="form.nick || 'defaults to nick'"
              autocomplete="off"
            />
          </label>
          <label class="grow">
            <span class="field-label">
              <span>SASL password{{ saslRequired ? '' : ' (optional)' }}</span>
              <button
                v-if="isEdit && props.network?.has_sasl_password"
                type="button"
                class="clear-link"
                :aria-label="saslPasswordClearLabel"
                @click="toggleClearSasl"
              >
                {{ clearSaslPassword ? 'keep' : 'clear' }}
              </button>
            </span>
            <input
              v-model="form.sasl_password"
              type="password"
              autocomplete="off"
              :disabled="clearSaslPassword"
              :placeholder="saslPasswordPlaceholder"
            />
          </label>
        </div>
        <button type="button" class="advanced-toggle" @click="showAdvanced = !showAdvanced">
          {{ showAdvanced ? '− Advanced options' : '+ Advanced options' }}
        </button>
        <div v-if="showAdvanced" class="advanced">
          <label>
            <span class="field-label">
              <span>Server password (optional)</span>
              <button
                v-if="isEdit && props.network?.has_password"
                type="button"
                class="clear-link"
                :aria-label="serverPasswordClearLabel"
                @click="toggleClearServer"
              >
                {{ clearServerPassword ? 'keep' : 'clear' }}
              </button>
            </span>
            <input
              v-model="form.server_password"
              type="password"
              autocomplete="off"
              :disabled="clearServerPassword"
              :placeholder="serverPasswordPlaceholder"
            />
          </label>
          <label v-if="!isEdit">
            <span>Channels to join</span>
            <input v-model="form.default_channel" :placeholder="channelPlaceholder" />
            <small>Comma-separated, e.g. #lurker, #libera</small>
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
          <label class="check">
            <input v-model="form.trusted_certificates" type="checkbox" />
            <span>Only allow trusted certificates</span>
          </label>
        </div>
        <p v-if="error" class="error">{{ error }}</p>
      </div>
      <footer class="modal-footer">
        <button
          v-if="isEdit"
          type="button"
          class="btn-secondary danger"
          :disabled="loading"
          @click="remove"
        >
          Delete
        </button>
        <button
          v-if="isEdit"
          type="button"
          class="btn-secondary"
          :disabled="loading"
          @click="reconnect"
        >
          Reconnect
        </button>
        <span class="spacer"></span>
        <button type="button" class="btn-secondary" @click="$emit('close')">Cancel</button>
        <button type="submit" class="btn-primary" :disabled="loading">
          {{ loading ? 'Saving…' : isEdit ? 'Save' : 'Save & connect' }}
        </button>
      </footer>
    </form>
  </AppModal>
</template>

<script setup lang="ts">
import { reactive, ref, computed } from 'vue';
import AppModal from './AppModal.vue';
import NetworkPicker from './NetworkPicker.vue';
import { useNetworksStore, type Network } from '../stores/networks.js';
import { useConfigStore } from '../stores/config.js';
import {
  FALLBACK_CHANNEL,
  LURKER_CHANNEL,
  suggestedChannels,
  type BuiltinNetwork,
} from '../utils/builtinNetworks.js';

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
const config = useConfigStore();

const isEdit = computed(() => !!props.network);

// Cast to a loose record so we can read extra API fields not declared in
// the typed Network interface (sasl_account, autoconnect, connect_commands, etc.).
const netRaw = props.network as Record<string, unknown> | null;

const form = reactive({
  name: props.network?.name ?? '',
  host: props.network?.host ?? '',
  port: props.network?.port ?? 6697,
  tls: props.network ? !!props.network.tls : true,
  trusted_certificates: netRaw ? netRaw.trusted_certificates !== false : true,
  nick: props.network?.nick ?? '',
  realname: (netRaw?.realname as string | undefined) ?? '',
  server_password: '',
  sasl_account: (netRaw?.sasl_account as string | undefined) ?? '',
  sasl_password: '',
  default_channel: LURKER_CHANNEL,
  autoconnect: netRaw ? !!netRaw.autoconnect : true,
  connect_commands: (netRaw?.connect_commands as string | undefined) ?? '',
});

// Auto-expand advanced when editing a row that already has any advanced value
// set, so the user doesn't have to hunt for a saved password or connect script
// they configured previously. SASL now lives outside advanced, so it no longer
// forces the section open.
const showAdvanced = ref(
  !!props.network &&
    (!!netRaw?.has_password ||
      !!netRaw?.connect_commands ||
      netRaw?.autoconnect === false ||
      netRaw?.trusted_certificates === false),
);

// Add-flow opens on the network picker (#169); editing jumps straight to the
// form. Picking a built-in prefills the connection fields so the user only has
// to supply a nick.
const step = ref<'pick' | 'form'>(isEdit.value ? 'form' : 'pick');
const picked = ref<BuiltinNetwork | null>(null);

function onPick(net: BuiltinNetwork): void {
  form.name = net.name;
  form.host = net.host;
  form.port = net.port;
  form.tls = net.tls;
  // Always land the user in a channel rather than an empty server buffer: the
  // channels we can vouch for (#lurker, the network's own — #308), else #chat as
  // a common-enough lobby. The server splits this on commas, so a network with
  // both gets both.
  const suggested = suggestedChannels(net);
  form.default_channel = suggested.length ? suggested.join(', ') : FALLBACK_CHANNEL;
  picked.value = net;
  step.value = 'form';
}
function onManual(): void {
  // Clear anything a prior pick prefilled so "enter manually" starts blank
  // (the connection fields onPick touches); user-typed nick/realname/creds stay.
  picked.value = null;
  form.name = '';
  form.host = '';
  form.port = 6697;
  form.tls = true;
  form.default_channel = LURKER_CHANNEL;
  step.value = 'form';
}

// Node (hosted-cell) clients connect from a datacenter IP, where some networks
// (e.g. Libera) refuse unauthenticated connections — nudge the user to fill in
// SASL. Self-hosted (standalone) connections don't hit this, so it's node-only.
const showSaslHint = computed(
  () => step.value === 'form' && config.isNode && !!picked.value?.saslLikelyRequired,
);

// When SASL is effectively required (a hosted cell on a network that blocks
// unauthenticated cloud IPs), drop the "(optional)" qualifier on the labels.
const saslRequired = computed(() => showSaslHint.value);

// Placeholder echoes the prefilled default if the user clears the field.
const channelPlaceholder = computed(() => {
  if (!picked.value) return LURKER_CHANNEL;
  const suggested = suggestedChannels(picked.value);
  return suggested.length ? suggested.join(', ') : FALLBACK_CHANNEL;
});

// Passwords are write-only as far as the client is concerned: the API returns
// only has_password / has_sasl_password booleans, never the secret, so the
// fields start blank and a blank field means "keep the saved value". That
// overload left no way to *remove* a saved password (#363). These flags add an
// explicit "clear" intent — when set, submit() sends an empty string, which the
// server stores verbatim (clearing the column). Typing a replacement still just
// overwrites it as before. Only reachable when editing a row that has a saved
// secret, so the toggle is hidden otherwise.
const clearServerPassword = ref(false);
const clearSaslPassword = ref(false);

function toggleClearServer(): void {
  clearServerPassword.value = !clearServerPassword.value;
  // Blank the field when arming clear so a previously-typed value can't win the
  // truthiness check in submit() and silently override the clear.
  if (clearServerPassword.value) form.server_password = '';
}
function toggleClearSasl(): void {
  clearSaslPassword.value = !clearSaslPassword.value;
  if (clearSaslPassword.value) form.sasl_password = '';
}

const serverPasswordPlaceholder = computed(() =>
  clearServerPassword.value
    ? '(will be cleared)'
    : isEdit.value && props.network?.has_password
      ? '(saved — type to replace)'
      : '',
);
const saslPasswordPlaceholder = computed(() =>
  clearSaslPassword.value
    ? '(will be cleared)'
    : isEdit.value && props.network?.has_sasl_password
      ? '(saved — type to replace)'
      : '',
);

// The visible toggle text is just "clear"/"keep" — fine sighted (it sits beside
// the field it acts on) but ambiguous to a screen reader, where two such buttons
// read identically (#420 review). A descriptive accessible name names the field;
// keeping the leading verb in sync with the visible label satisfies WCAG 2.5.3
// (Label in Name) and conveys the toggle's state without an aria-pressed that
// would fight the changing label.
const serverPasswordClearLabel = computed(() =>
  clearServerPassword.value ? 'keep saved server password' : 'clear saved server password',
);
const saslPasswordClearLabel = computed(() =>
  clearSaslPassword.value ? 'keep saved SASL password' : 'clear saved SASL password',
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
        trusted_certificates: form.trusted_certificates,
        nick: form.nick,
        realname: form.realname,
        sasl_account: form.sasl_account,
        autoconnect: form.autoconnect,
        connect_commands: form.connect_commands,
      };
      // A typed value replaces; an explicit clear sends '' to wipe the saved
      // secret; a blank field with no clear intent is omitted so the existing
      // value is preserved.
      if (form.server_password) patch.server_password = form.server_password;
      else if (clearServerPassword.value) patch.server_password = '';
      if (form.sasl_password) patch.sasl_password = form.sasl_password;
      else if (clearSaslPassword.value) patch.sasl_password = '';
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
     scrollbar sits against the card border instead of inside the padding.
     Bottom padding keeps the last field off the footer divider when scrolled. */
  margin: 0 calc(-1 * var(--card-pad-x));
  padding: 0 var(--card-pad-x) var(--space-7);
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
/* Field title sharing its row with an inline "clear" affordance (saved
   passwords, #363). The inner <span> keeps the uppercase label styling; the
   button overrides it to read as a lowercase accent link. */
.field-label {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-3);
}
.clear-link {
  background: transparent;
  border: 0;
  padding: 0;
  color: var(--accent);
  cursor: pointer;
  text-transform: lowercase;
  letter-spacing: normal;
}
.clear-link:hover {
  text-decoration: underline;
}
.advanced-toggle,
.back-link {
  align-self: flex-start;
  background: transparent;
  border: 0;
  padding: var(--space-2) 0;
  color: var(--accent);
  cursor: pointer;
  text-transform: lowercase;
}
.advanced-toggle:hover,
.back-link:hover {
  text-decoration: underline;
}
.sasl-hint {
  margin: 0;
  color: var(--fg-muted);
  border-left: 2px solid var(--accent);
  padding-left: var(--space-3);
}
.sasl-hint strong {
  color: var(--fg);
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
.error {
  color: var(--bad);
  margin: 0;
}
</style>
