<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<!--
  First-run flow (#300). Two steps, not three: NetworkPicker (reused verbatim
  from the add-network flow), then one screen that takes a nick and the channels
  to land in. Identity and channels share a screen because they share a submit —
  channels are passed to POST /api/networks as `default_channel`, which the
  server splits and turns into autojoin rows. One create call, no partial state,
  and the connect that follows lands the user directly in a populated channel.

  Deliberately NOT reusing NetworkForm: that component is a modal shell in its
  own right (it can't nest inside this one), and it carries an edit mode, a
  delete button, a reconnect button and an advanced-options section that have no
  business in a first run. The reuse that matters happens a layer down — both
  submit through the same networks.create() action.
-->

<template>
  <AppModal
    word="welcome"
    size="xl"
    :fill-height="step === 'pick'"
    close-title="Close for now"
    @close="onboarding.dismiss"
  >
    <template #actions>
      <button type="button" class="link skip" @click="skip">Skip setup</button>
    </template>
    <template #title>
      <h2 v-if="step === 'pick'">welcome to lurker</h2>
      <h2 v-else>{{ picked ? `connect to ${picked.name}` : 'connect to a network' }}</h2>
    </template>
    <template #subtitle>
      <span v-if="step === 'pick'">
        IRC is a collection of independent networks. Pick one to get started — you can add more
        whenever you like.
      </span>
      <span v-else>Choose a nick and where to land.</span>
    </template>

    <NetworkPicker v-if="step === 'pick'" @select="onPick" @manual="onManual" />

    <form v-else class="modal-form" @submit.prevent="submit">
      <div class="setup">
        <button type="button" class="back-link" @click="back">← pick a different network</button>

        <!-- Manual entry has no preset behind it, so the connection details the
             picker would have supplied have to be asked for. -->
        <template v-if="!picked">
          <label>
            <span>Network name</span>
            <input v-model="form.name" placeholder="My network" required />
          </label>
          <div class="row">
            <label class="grow">
              <span>Host</span>
              <input v-model="form.host" placeholder="irc.example.org" required />
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
        </template>

        <label>
          <span>Nick</span>
          <input v-model="form.nick" placeholder="your nickname" required autocomplete="off" />
          <small>This is the name people on IRC will see. You can change it later.</small>
        </label>

        <!-- Same condition (and same warning) as NetworkForm: a hosted cell
             connects from a datacenter IP, which some networks refuse without
             SASL. Self-hosted users don't hit this, so they aren't asked. -->
        <template v-if="saslRequired">
          <p v-if="picked?.isInstance" class="sasl-hint">
            <strong>{{ picked.name }}</strong> requires an account, so these are
            <strong>not optional</strong> — register your nick with the network first, then enter it
            here.
          </p>
          <p v-else class="sasl-hint">
            <strong>{{ picked?.name }}</strong> blocks unauthenticated connections from hosted
            servers, so these are <strong>not optional</strong> — register your nick with the
            network first, then enter it here.
          </p>
          <div class="row">
            <label class="grow">
              <span>SASL account</span>
              <input
                v-model="form.sasl_account"
                :placeholder="form.nick || 'defaults to nick'"
                autocomplete="off"
              />
            </label>
            <label class="grow">
              <span>SASL password</span>
              <input v-model="form.sasl_password" type="password" autocomplete="off" />
            </label>
          </div>
        </template>

        <fieldset class="channels">
          <legend>Channels to join</legend>
          <div v-if="chips.length" class="chip-row">
            <button
              v-for="channel in chips"
              :key="channel"
              type="button"
              class="chip"
              :class="{ on: selected.includes(channel) }"
              :aria-pressed="selected.includes(channel)"
              @click="toggle(channel)"
            >
              {{ channel }}
            </button>
          </div>
          <div class="other">
            <input
              v-model="extra"
              :placeholder="extraPlaceholder"
              autocomplete="off"
              spellcheck="false"
              aria-label="Other channels to join"
            />
            <small>
              {{
                chips.length
                  ? 'Add any others, comma-separated.'
                  : 'Comma-separated. Leave blank to land in the server buffer and browse with /list.'
              }}
            </small>
          </div>
        </fieldset>

        <p v-if="error" class="error">{{ error }}</p>
      </div>

      <footer class="modal-footer">
        <span class="spacer"></span>
        <button type="submit" class="btn-primary" :disabled="loading">
          {{ loading ? 'Connecting…' : 'Connect' }}
        </button>
      </footer>
    </form>
  </AppModal>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import AppModal from './AppModal.vue';
import NetworkPicker from './NetworkPicker.vue';
import { useNetworksStore } from '../stores/networks.js';
import { useConfigStore } from '../stores/config.js';
import { useAuthStore } from '../stores/auth.js';
import { useOnboarding } from '../composables/useOnboarding.js';
import { nickFromUsername } from '../utils/ircNick.js';
import {
  FALLBACK_CHANNEL,
  suggestedChannels,
  type NetworkPreset,
} from '../utils/builtinNetworks.js';

const networks = useNetworksStore();
const config = useConfigStore();
const auth = useAuthStore();
const onboarding = useOnboarding();

const step = ref<'pick' | 'setup'>('pick');
const picked = ref<NetworkPreset | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);

const form = reactive({
  name: '',
  host: '',
  port: 6697,
  tls: true,
  nick: nickFromUsername(auth.user?.username),
  sasl_account: '',
  sasl_password: '',
});

// Only the channels we can actually vouch for are offered as one-click chips:
// #lurker where there's an active one, plus the network's own documented channel
// (#308). We never chip a guess — a brand-new user has no way to tell a real
// channel from one we invented, and clicking it would silently create an empty
// room. Where we know nothing, #chat is offered as a placeholder only.
const chips = computed(() => (picked.value ? suggestedChannels(picked.value) : []));
const selected = ref<string[]>([]);
const extra = ref('');
const extraPlaceholder = computed(() =>
  chips.value.length ? '#another, #channel' : FALLBACK_CHANNEL,
);

// The builtin catalogue's saslLikelyRequired flag is specifically about
// datacenter IPs — some networks refuse unauthenticated connections from one —
// so for a builtin it only applies on a hosted cell. An admin who ticks the flag
// on their OWN instance preset is stating a fact about their network, and that
// holds on every edition.
const saslRequired = computed(() => {
  const net = picked.value;
  if (!net?.saslLikelyRequired) return false;
  return net.isInstance === true || config.isNode;
});

function toggle(channel: string): void {
  const idx = selected.value.indexOf(channel);
  if (idx >= 0) selected.value.splice(idx, 1);
  else selected.value.push(channel);
}

function onPick(net: NetworkPreset): void {
  picked.value = net;
  form.name = net.name;
  form.host = net.host;
  form.port = net.port;
  form.tls = net.tls;
  // Everything we can vouch for starts checked — the point of the flow is that
  // the happy path is one click. Channel choices are per-network, so both the
  // chips and anything hand-typed reset on a re-pick: a "#vim" meant for Libera
  // must not follow the user to Rizon and get silently joined there.
  selected.value = [...suggestedChannels(net)];
  extra.value = '';
  step.value = 'setup';
}

function onManual(): void {
  picked.value = null;
  form.name = '';
  form.host = '';
  form.port = 6697;
  form.tls = true;
  selected.value = [];
  extra.value = '';
  step.value = 'setup';
}

function back(): void {
  error.value = null;
  step.value = 'pick';
}

async function submit(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    // The server splits this on commas and whitespace, de-duplicates, and writes
    // one autojoin row per channel; create() then connects, so the user lands in
    // these channels rather than an empty server buffer.
    const channels = [...selected.value, extra.value].filter(Boolean).join(',');
    await networks.create({
      name: form.name,
      host: form.host,
      port: form.port,
      tls: form.tls,
      nick: form.nick,
      sasl_account: form.sasl_account,
      sasl_password: form.sasl_password,
      default_channel: channels,
    });
    await onboarding.complete();
  } catch (err: unknown) {
    error.value = (err instanceof Error ? err.message : null) || 'failed to connect';
    loading.value = false;
  }
}

// "Skip setup" is the deliberate, permanent bail-out #300 asks for — it never
// comes back, on any device. Distinct from the × / Esc, which only close it for
// this session (see onboarding.dismiss): a power user choosing to hand-configure
// has made a decision, while someone hitting Esc has not. From here the + button
// in the sidebar is the ordinary path, and the empty state points at it.
function skip(): void {
  void onboarding.complete();
}
</script>

<style scoped>
.setup {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  /* Breakout so the scrollbar rides the card border, matching NetworkForm. */
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
label input {
  color: var(--fg);
  width: 100%;
  box-sizing: border-box;
}
label small {
  color: var(--fg-muted);
  margin-top: var(--space-1);
  text-transform: none;
  letter-spacing: normal;
}
.row {
  display: flex;
  gap: var(--space-4);
  align-items: end;
}
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
/* Sits beside the modal's × in the header actions. Reads as the deliberate
   "I don't want this" next to the ×'s "not now". */
.skip {
  color: var(--fg-muted);
  cursor: pointer;
  text-transform: lowercase;
}
.skip:hover {
  color: var(--fg);
  text-decoration: underline;
}
.back-link {
  align-self: flex-start;
  background: transparent;
  border: 0;
  padding: var(--space-2) 0;
  color: var(--accent);
  cursor: pointer;
  text-transform: lowercase;
}
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
.channels {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  border: 0;
  padding: 0;
  margin: 0;
  min-width: 0;
}
.channels legend {
  padding: 0;
  color: var(--fg-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.chip-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
}
/* Mirrors the label column layout without being a <label> — the input is
   labelled by aria-label, since the fieldset legend already names the group. */
.other {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
}
.other input {
  color: var(--fg);
  width: 100%;
  box-sizing: border-box;
}
.other small {
  color: var(--fg-muted);
  margin-top: var(--space-1);
}
.chip {
  background: transparent;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  padding: var(--space-2) var(--space-4);
  color: var(--fg-muted);
  cursor: pointer;
}
.chip:hover {
  border-color: var(--accent);
}
.chip.on {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--bg);
}
.error {
  color: var(--bad);
  margin: 0;
}
</style>
