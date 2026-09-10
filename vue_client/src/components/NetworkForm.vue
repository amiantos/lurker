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
        <p v-if="showSaslHint && picked?.isInstance" class="sasl-hint">
          <strong>{{ picked.name }}</strong> requires an account, so the SASL account and password
          below are <strong>not optional</strong> — register your nick with the network first, then
          enter it here.
        </p>
        <p v-else-if="showSaslHint" class="sasl-hint">
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
          <hr class="divider" />
          <label>
            <span>Commands to run on connect</span>
            <textarea
              v-model="form.connect_commands"
              rows="4"
              autocomplete="off"
              spellcheck="false"
              :placeholder="connectCommandsPlaceholder"
            />
            <small
              >Raw IRC protocol lines (not /commands), one per line, sent to the server verbatim
              once connected — e.g. for identifying or opering up. A line like
              <code>WAIT 15</code> pauses that many seconds before the next one.</small
            >
          </label>
          <hr class="divider" />
          <div class="certfp">
            <span class="field-label">
              <span>Client certificate (CertFP)</span>
              <button
                v-if="cert"
                type="button"
                class="clear-link"
                :disabled="certBusy"
                @click="removeCertificate"
              >
                remove
              </button>
            </span>
            <p v-if="pendingCert" class="cert-pending">
              {{ pendingCert }}
              <button type="button" class="clear-link" @click="clearPendingCert">undo</button>
            </p>
            <p v-else-if="certUnusable" class="cert-bad">
              This certificate can’t be read, and the network won’t connect while it’s attached.
              Remove it, then generate a new one.
            </p>
            <template v-else-if="certInfo">
              <!-- No fingerprints here on purpose. `CERT ADD` with no argument,
                   from the connection the certificate is on, is what nearly
                   every network wants — TheLounge shows none for the same
                   reason. The exceptions (ergo requires the argument;
                   registering from another client is the only way onto a
                   network that refuses unauthenticated connections) are served
                   by `/network cert <network>`, which prints all three the way
                   soju's `certfp fingerprint` does. -->
              <p class="cert-actions">
                <button type="button" class="btn-secondary" @click="downloadCertificate">
                  <i class="fa-solid fa-download" aria-hidden="true"></i>
                  Download
                </button>
              </p>
              <small>Expires {{ certExpiry }}</small>
            </template>
            <template v-else>
              <p class="cert-actions">
                <button
                  type="button"
                  class="btn-secondary"
                  :disabled="certBusy || !form.tls"
                  @click="generateCertificate"
                >
                  {{ certBusy ? 'Working…' : 'Generate' }}
                </button>
                <button
                  type="button"
                  class="btn-secondary"
                  :disabled="certBusy || !form.tls"
                  @click="certFile?.click()"
                >
                  Import
                </button>
                <span v-if="!form.tls" class="cert-note">TLS only.</span>
                <!-- Picking the file IS the import: every guide to CertFP hands
                     you one .pem, and weechat and irssi both take exactly that.
                     `multiple` covers the other shape irssi documents ("the
                     private key, if not included in the certificate file") and
                     that ergo's own openssl instructions produce. -->
                <input
                  ref="certFile"
                  type="file"
                  accept=".pem,.crt,.cer,.key,.txt,application/x-pem-file,text/plain"
                  multiple
                  hidden
                  @change="onCertFiles"
                />
              </p>
            </template>
            <p v-if="certError" class="error">{{ certError }}</p>
          </div>
          <hr class="divider" />
          <div class="proxy">
            <label class="check">
              <input v-model="form.proxy_enabled" type="checkbox" />
              <span>Connect through a proxy</span>
            </label>
            <template v-if="form.proxy_enabled">
              <label>
                <span>Proxy type</span>
                <select v-model="form.proxy_type">
                  <option value="socks5">SOCKS5</option>
                  <option value="http">HTTP CONNECT</option>
                </select>
              </label>
              <label>
                <span>Proxy address</span>
                <span class="proxy-address">
                  <input
                    v-model.trim="form.proxy_host"
                    placeholder="127.0.0.1"
                    autocomplete="off"
                    spellcheck="false"
                  />
                  <span aria-hidden="true">:</span>
                  <input
                    v-model.number="form.proxy_port"
                    type="number"
                    min="1"
                    max="65535"
                    :placeholder="proxyPortPlaceholder"
                    aria-label="Proxy port"
                  />
                </span>
                <small>
                  For Tor, that's <code>127.0.0.1</code> port <code>9050</code>. The server name is
                  resolved by the proxy, not here — which is what makes
                  <code>.onion</code> addresses work. File transfers (DCC) are turned off while a
                  proxy is set, because they would connect directly and give away your address.
                </small>
              </label>
              <label>
                <span>Proxy username (optional)</span>
                <input v-model.trim="form.proxy_username" autocomplete="off" />
              </label>
              <label>
                <span class="field-label">
                  <span>Proxy password (optional)</span>
                  <button
                    v-if="proxyHasPassword"
                    type="button"
                    class="clear-link"
                    @click="toggleClearProxyPassword"
                  >
                    {{ clearProxyPassword ? 'keep' : 'clear' }}
                  </button>
                </span>
                <input
                  v-model="form.proxy_password"
                  type="password"
                  autocomplete="off"
                  :disabled="clearProxyPassword"
                  :placeholder="proxyHasPassword ? 'leave blank to keep saved password' : ''"
                />
              </label>
            </template>
          </div>
          <hr class="divider" />
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
import { reactive, ref, computed, watch } from 'vue';
import AppModal from './AppModal.vue';
import NetworkPicker from './NetworkPicker.vue';
import { useNetworksStore, type ClientCertInfo, type Network } from '../stores/networks.js';
import { useConfigStore } from '../stores/config.js';
import { partsFromPem } from '../../../shared/clientCertPem.js';
import {
  FALLBACK_CHANNEL,
  LURKER_CHANNEL,
  suggestedChannels,
  type NetworkPreset,
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
// The server sends the proxy as parts with the password reduced to a boolean —
// never the password itself. See routes/networks.ts networkPayload.
const proxyRaw = (netRaw?.proxy ?? null) as Record<string, unknown> | null;

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
  // Add flow only: the routes need a network to write to, so at this point the
  // certificate is an intent the create request carries. It is minted server
  // side BEFORE the first dial — every network's instructions are "connect with
  // it, then register it from that connection", so a certificate attached
  // afterwards misses the one connect that matters.
  generate_client_cert: false,
  // An imported pair waiting on the create request, same idea.
  client_cert: '',
  client_key: '',
  // Proxy (#303). Parts rather than a URL, because the server never hands the
  // password back — with a single URL, changing the port would mean retyping
  // the password. `proxy_enabled` is what the dial path asks: details can sit
  // here saved while the network stays direct.
  proxy_enabled: !!proxyRaw?.enabled,
  proxy_type: (proxyRaw?.type as string | undefined) ?? 'socks5',
  proxy_host: (proxyRaw?.host as string | undefined) ?? '',
  proxy_port: (proxyRaw?.port as number | undefined) ?? 1080,
  // ⚠ `proxy_port` is `number | ''` in practice: `v-model.number` on an emptied
  // number input yields ''. Coerced at save (proxyPortValue) rather than
  // guarded at every read.
  proxy_username: (proxyRaw?.username as string | undefined) ?? '',
  proxy_password: '',
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
      !!netRaw?.client_cert ||
      !!proxyRaw ||
      netRaw?.trusted_certificates === false),
);

// "Leave blank to keep", the same contract server_password has: the field
// starts empty because the server never sent the password, so an empty box
// means "unchanged" and this button is the only way to actually remove one.
const clearProxyPassword = ref(false);
const proxyHasPassword = computed(() => !!proxyRaw?.has_password);
function toggleClearProxyPassword(): void {
  clearProxyPassword.value = !clearProxyPassword.value;
  if (clearProxyPassword.value) form.proxy_password = '';
}
// Tor is the reason most people will use this, so the empty state is its
// address rather than a generic example.
const proxyPortPlaceholder = computed(() => (form.proxy_type === 'http' ? '3128' : '1080'));

// The default follows the type, or picking "HTTP CONNECT" silently saves 1080
// while the placeholder — which never shows, the field being pre-filled — says
// 3128. Only rewrites an untouched default, never a port the user chose.
watch(
  () => form.proxy_type,
  (next, prev) => {
    const wasDefault = form.proxy_port === (prev === 'http' ? 3128 : 1080);
    if (wasDefault) form.proxy_port = next === 'http' ? 3128 : 1080;
  },
);

/** The port to send: an emptied number input gives '', which would otherwise be
 *  written straight into an INTEGER column and only surface much later, when
 *  the proxy is next enabled and validation calls it invalid. */
function proxyPortValue(): number {
  const n = Number(form.proxy_port);
  return Number.isInteger(n) && n > 0 ? n : form.proxy_type === 'http' ? 3128 : 1080;
}

/** The proxy columns, but only when this save actually changes them.
 *
 *  ⚠⚠ Sending all six on every save made every save 403 on a locked-down
 *  instance, because the server gated on the keys being PRESENT. The server now
 *  gates on the proxy actually changing, so this is belt and braces — but it is
 *  also just correct: a rename should not carry a proxy payload. */
function proxyPatch(): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  const before = proxyRaw;
  if (form.proxy_enabled !== !!before?.enabled) next.proxy_enabled = form.proxy_enabled;
  if (form.proxy_type !== ((before?.type as string | undefined) ?? 'socks5')) {
    next.proxy_type = form.proxy_type;
  }
  if (form.proxy_host !== ((before?.host as string | undefined) ?? '')) {
    next.proxy_host = form.proxy_host;
  }
  // ⚠ Only when the network HAS a proxy, or the user is setting one up.
  // Comparing the default against `undefined` on a network with no proxy sent
  // `proxy_port` on every single save — a rename writing 1080 into an
  // untouched column, which is exactly the churn this function exists to stop.
  if ((before || form.proxy_enabled) && proxyPortValue() !== (before?.port as number | undefined)) {
    next.proxy_port = proxyPortValue();
  }
  if (form.proxy_username !== ((before?.username as string | undefined) ?? '')) {
    next.proxy_username = form.proxy_username;
  }
  if (form.proxy_password) next.proxy_password = form.proxy_password;
  else if (clearProxyPassword.value) next.proxy_password = '';
  return next;
}

// CertFP (#459). These four buttons write straight through to the server rather
// than waiting for Save: a certificate is not a form field, it is a stored pair
// with its own routes, and the fingerprint the user has to register only exists
// once it has been written. Kept in a local ref so the block re-renders from
// what the action returned, without depending on the parent refetching.
const cert = ref<ClientCertInfo | null>((netRaw?.client_cert as ClientCertInfo | null) ?? null);
const certBusy = ref(false);
const certError = ref('');
const certFile = ref<HTMLInputElement | null>(null);

const certUnusable = computed(() => !!cert.value && 'unusable' in cert.value);
// The readable variant, or null — `v-if="cert"` can't narrow the union in a
// template, and an attached-but-unparseable certificate has no digests to show.
const certInfo = computed(() => (cert.value && !('unusable' in cert.value) ? cert.value : null));
const certExpiry = computed(() =>
  certInfo.value ? new Date(certInfo.value.validTo).toLocaleDateString() : '',
);

async function runCertAction(action: () => Promise<void>): Promise<void> {
  certBusy.value = true;
  certError.value = '';
  try {
    await action();
  } catch (err: any) {
    certError.value = err?.data?.error || err?.message || 'that did not work';
  } finally {
    certBusy.value = false;
  }
}

// Generate and Import mean the same two things in both flows; only the timing
// differs, and it has to — while adding, there is no network to write to yet,
// so the choice rides along with the create request and the server applies it
// BEFORE the first dial (which is the connect the user registers the
// fingerprint from).
function generateCertificate(): Promise<void> {
  if (!isEdit.value) {
    form.generate_client_cert = true;
    form.client_cert = '';
    form.client_key = '';
    return Promise.resolve();
  }
  return runCertAction(async () => {
    cert.value = await networks.attachCertificate(props.network!.id, { mode: 'generate' });
  });
}

// Picking the file is the whole import. The halves are pulled out here so a
// file missing one can be named on the spot rather than at save time; the
// server splits and validates again on arrival, and stays the only thing that
// decides whether the pair actually works.
async function onCertFiles(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = ''; // so picking the same file again still fires
  if (!files.length) return;
  certError.value = '';
  const text = (await Promise.all(files.map((f) => f.text()))).join('\n');
  const parts = partsFromPem(text);
  if (!parts.cert && !parts.key) {
    certError.value = "that file doesn't hold a certificate or a private key";
    return;
  }
  if (!parts.cert || !parts.key) {
    certError.value = parts.cert
      ? 'that file has no private key in it — pick the .pem holding both, or both files at once'
      : 'that file has no certificate in it — pick the .pem holding both, or both files at once';
    return;
  }
  await importCertificate(parts.cert, parts.key);
}

function importCertificate(certPem: string, keyPem: string): Promise<void> {
  if (!isEdit.value) {
    // No network to write to yet, so it rides along with the create request,
    // which validates it the same way and applies it before the first dial.
    form.client_cert = certPem;
    form.client_key = keyPem;
    form.generate_client_cert = false;
    return Promise.resolve();
  }
  return runCertAction(async () => {
    cert.value = await networks.attachCertificate(props.network!.id, {
      mode: 'import',
      cert: certPem,
      key: keyPem,
    });
  });
}

// What the add flow has queued up, in words, or '' when nothing is.
const pendingCert = computed(() => {
  if (isEdit.value) return '';
  if (form.generate_client_cert) return 'A certificate will be created with this network.';
  if (form.client_cert) return 'Your certificate will be attached to this network.';
  return '';
});

function clearPendingCert(): void {
  form.generate_client_cert = false;
  form.client_cert = '';
  form.client_key = '';
  certError.value = '';
}

function removeCertificate(): Promise<void> {
  return runCertAction(async () => {
    await networks.removeCertificate(props.network!.id);
    cert.value = null;
  });
}

// A button rather than a link, to sit with the copy row. The server names the
// file in its Content-Disposition; the anchor exists only to start the download
// without navigating away from the form.
function downloadCertificate(): void {
  const link = document.createElement('a');
  link.href = `/api/networks/${props.network!.id}/certificate/export`;
  link.download = '';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

// Add-flow opens on the network picker (#169); editing jumps straight to the
// form. Picking a built-in prefills the connection fields so the user only has
// to supply a nick.
const step = ref<'pick' | 'form'>(isEdit.value ? 'form' : 'pick');
const picked = ref<NetworkPreset | null>(null);

function onPick(net: NetworkPreset): void {
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
// SASL. Self-hosted (standalone) connections don't hit this, so for a builtin
// it's node-only. An admin-defined instance preset (#298) is different: ticking
// "requires an account" there is a statement about their own network, true on
// every edition.
const showSaslHint = computed(() => {
  if (step.value !== 'form') return false;
  const net = picked.value;
  if (!net?.saslLikelyRequired) return false;
  return net.isInstance === true || config.isNode;
});

// When SASL is effectively required (a hosted cell on a network that blocks
// unauthenticated cloud IPs), drop the "(optional)" qualifier on the labels.
const saslRequired = computed(() => showSaslHint.value);

// A worked example beats prose here: raw wire lines, not slash commands, and
// the WAIT pseudo-command in context. (#540)
const connectCommandsPlaceholder = [
  'PRIVMSG NickServ :IDENTIFY hunter2',
  'WAIT 5',
  'OPER admin hunter2',
].join('\n');

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
      Object.assign(patch, proxyPatch());
      // Saving only persists the row — it never cycles the live connection.
      // Connection-relevant edits (host/port/nick/credentials) take effect on
      // the next connect; the explicit "Reconnect" button below applies them
      // now if the user wants that.
      await networks.update(props.network.id, patch);
    } else {
      // ⚠ The proxy columns are omitted entirely unless one was configured, so
      // creating an ordinary network on a locked-down instance carries no proxy
      // payload to be refused.
      const {
        proxy_enabled,
        proxy_type,
        proxy_host,
        proxy_port,
        proxy_username,
        proxy_password,
        ...rest
      } = form;
      await networks.create({
        ...rest,
        ...(proxy_enabled
          ? {
              proxy_enabled,
              proxy_type,
              proxy_host,
              proxy_port: proxyPortValue(),
              proxy_username,
              proxy_password,
            }
          : {}),
      });
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
/* .certfp labels a GROUP of buttons rather than one control, so it is a <div>
   and not a <label> — and has to opt into the field styling every other title
   in the form gets for free, or it reads as body text among them. */
label,
.certfp {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  color: var(--fg-muted);
}
label span,
.certfp > .field-label > span {
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
.divider {
  height: 1px;
  width: 100%;
  border: 0;
  margin: 0;
  background: var(--border);
}

.cert-actions {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin: 0;
  /* Three copy buttons plus a download link don't fit a narrow modal in one
     line. */
  flex-wrap: wrap;
}
.cert-bad {
  margin: 0;
  color: var(--bad);
}
.cert-pending {
  display: flex;
  align-items: baseline;
  gap: var(--space-3);
  margin: 0;
}
.cert-note {
  color: var(--fg-muted);
}

.proxy {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}
.proxy-address {
  display: flex;
  align-items: center;
  gap: 0.35rem;
}
.proxy-address input:first-of-type {
  flex: 1 1 auto;
  min-width: 0;
}
.proxy-address input[type='number'] {
  flex: 0 0 6.5rem;
}
</style>
