<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0

  Admin panel → Notifications: the opt-in to push.lurker.chat for the official
  iOS and Android apps (lurker-dev/RELAY_PLAN.md §5a). Until it's on, the server
  doesn't mention the relay to the apps, so they never contact it.
-->

<template>
  <section id="admin-notifications" class="settings-pane">
    <h2>notifications</h2>
    <p v-if="error" class="error inline">{{ error }}</p>

    <template v-if="push">
      <p v-if="!push.vapidSubject.appleAccepts" class="error inline">
        Safari and home-screen web apps on iPhone will refuse notifications from this server. (The
        Lurker apps aren't affected.) Set <code>VAPID_SUBJECT</code> to <code>mailto:</code> an
        address on a real domain, or to your server's <code>https://</code> URL, then restart.
      </p>
      <p v-else-if="push.vapidSubject.ignored" class="muted small">
        <code>VAPID_SUBJECT</code> isn't usable, so web push uses
        <code>{{ push.vapidSubject.subject }}</code> instead.
      </p>
      <p v-if="native" class="section-desc">
        This server sends notifications to browsers and to the Lurker iOS and Android apps directly.
      </p>
      <template v-else>
        <p class="section-desc">
          Browsers get notifications from this server directly. The Lurker iOS and Android apps need
          <a :href="push.relay.url" target="_blank" rel="noopener">{{ relayHost }}</a>
          to forward them. Each notification is encrypted for the phone, so the relay can't read it.
        </p>

        <h3 class="subhead">server key</h3>
        <p class="muted small">Register this key at {{ relayHost }}.</p>
        <div class="key-row">
          <code class="key">{{ push.publicKey }}</code>
          <button class="link" type="button" @click="copy(push.publicKey)">
            {{ copied ? 'copied' : 'copy' }}
          </button>
        </div>
        <p class="relay-status small">
          <span v-if="status" :class="status.ok ? 'muted' : 'error'">{{ status.text }}</span>
          <button class="link" type="button" :disabled="checking || busy" @click="check">
            {{ checking ? 'checking…' : 'check' }}
          </button>
        </p>
      </template>

      <!-- Still shown on a native server while the relay is on: otherwise an
           admin who added APNs/FCM keys later would have no way to turn it off. -->
      <template v-if="!native || push.relay.enabled">
        <label class="check">
          <input
            type="checkbox"
            :checked="push.relay.enabled"
            :disabled="busy || checking"
            @change="toggle"
          />
          <span>Use {{ relayHost }} for the iOS and Android apps</span>
        </label>
        <p v-if="push.relay.enabled" class="muted small">
          {{ deviceCount }} registered through the relay. Turning this off removes them.
        </p>
        <p v-else class="muted small">While this is off, the apps never contact {{ relayHost }}.</p>
      </template>
    </template>

    <hr class="hl-sep" />
    <h3 class="subhead">connected clients</h3>
    <p class="section-desc">
      Who is connected right now, and whether a client of theirs reports itself visible. Push for a
      user is held while one does.
    </p>
    <ul v-if="store.presence.length" class="device-list">
      <li v-for="row in store.presence" :key="row.userId" class="device stacked">
        <span class="ua">{{ row.username ?? `user ${row.userId}` }}</span>
        <span class="last-seen">{{ socketSummary(row) }}</span>
        <ul class="sockets">
          <li v-for="(c, i) in row.sockets" :key="i" class="muted small">{{ clientText(c) }}</li>
        </ul>
      </li>
    </ul>
    <p v-else class="muted small">Nobody is connected.</p>

    <hr class="hl-sep" />
    <h3 class="subhead">recent pushes</h3>
    <p class="section-desc">
      Every push this server tried to send in the last week, newest first. A "sent" line with a 201
      from {{ relayHost || 'the push service' }} means the relay forwarded it and Apple or Google
      accepted it; a "held" line names the rule that stopped it. Copy the log to send along with a
      bug report.
    </p>
    <p class="log-actions">
      <button class="link" type="button" :disabled="!store.pushLog.length" @click="copyLog">
        {{ logCopied ? 'copied' : 'copy as text' }}
      </button>
      <button class="link" type="button" @click="reloadLog">refresh</button>
    </p>
    <ul v-if="store.pushLog.length" class="push-log">
      <li v-for="row in store.pushLog" :key="row.id" class="push-row" :class="row.outcome">
        <span class="when" :title="row.at">{{ formatDateTime(row.at) }}</span>
        <span class="what">
          <strong>{{ row.username ?? `user ${row.user_id}` }}</strong> · {{ kindLabel(row.kind) }} ·
          {{ subjectLabel(row) }}
        </span>
        <span class="how">{{ outcomeLabel(row) }}</span>
      </li>
    </ul>
    <p v-else-if="store.pushLogLoaded" class="muted small">Nothing in the last week.</p>
    <p v-if="store.pushLogHasMore">
      <button class="link" type="button" :disabled="olderBusy" @click="olderLog">
        {{ olderBusy ? 'loading…' : 'show older' }}
      </button>
    </p>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useAdminStore, type AdminPresenceRow } from '../../stores/admin.js';
import type { RelayStatus } from '../../../../shared/relayStatus.js';
import { useCopyFeedback } from '../../composables/useCopyFeedback.js';
import { formatDateTime } from '../../utils/timestamp.js';
import {
  clientText,
  kindLabel,
  outcomeLabel,
  pushLogText,
  subjectLabel,
} from '../../utils/pushLog.js';

const store = useAdminStore();
const { copied, copy } = useCopyFeedback();
// The log's copy button ticks on its own, not with the key's.
const { copied: logCopied, copy: copyText } = useCopyFeedback();

function copyLog() {
  copyText(pushLogText(store.pushLog));
}

function reloadLog() {
  store.fetchPushLog().catch(() => {});
  store.fetchPresence().catch(() => {});
}

const olderBusy = ref(false);
async function olderLog() {
  olderBusy.value = true;
  try {
    await store.fetchOlderPushLog();
  } catch (e: any) {
    error.value = e.message || 'failed to load older rows';
  } finally {
    olderBusy.value = false;
  }
}

function socketSummary(row: AdminPresenceRow): string {
  const n = row.openSockets === 1 ? '1 client' : `${row.openSockets} clients`;
  return row.visibleSockets ? `${n}, ${row.visibleSockets} visible` : `${n}, none visible`;
}
const error = ref('');
const busy = ref(false);

const push = computed(() => store.push);
// Both apps already get native push (the hosted service), so the relay has
// nothing to do here.
const native = computed(
  () => !!push.value?.transports.includes('apns') && push.value.transports.includes('fcm'),
);
const relayHost = computed(() => (push.value ? new URL(push.value.relay.url).host : ''));
const deviceCount = computed(() => {
  const n = push.value?.relay.devices ?? 0;
  return n === 1 ? '1 device' : `${n} devices`;
});

const checking = ref(false);

// What push.lurker.chat says about this server's key, in a line — the one place
// these words live (a refused turn-on shows this, not a second message). The
// switch is exhaustive: a state added to RelayStatus fails typecheck here.
function describe(s: RelayStatus, host: string): { text: string; ok: boolean } {
  switch (s.state) {
    case 'active':
      if (s.comped) return { text: 'Comped', ok: true };
      // The UTC calendar date, as the relay's own page shows it.
      if (s.paidThrough)
        return { text: `Active — paid through ${s.paidThrough.slice(0, 10)}`, ok: true };
      return { text: 'Active', ok: true };
    case 'inactive':
      return s.registered
        ? { text: `This server's key isn't active on ${host}`, ok: false }
        : { text: `${host} doesn't recognize this server's key`, ok: false };
    case 'unauthorized':
      return { text: `${host} couldn't verify this server's key`, ok: false };
    case 'refused':
      return { text: `${host} refused the status check (HTTP ${s.httpStatus})`, ok: false };
    case 'unreachable':
      return { text: `Couldn't reach ${host}`, ok: false };
    default: {
      const unhandled: never = s;
      return unhandled;
    }
  }
}

const status = computed(() => {
  const s = store.relayStatus;
  return s ? describe(s, relayHost.value) : null;
});

async function check() {
  error.value = '';
  checking.value = true;
  try {
    await store.checkPushRelay();
  } catch (e: any) {
    error.value = e.message || 'failed to check';
  } finally {
    checking.value = false;
  }
}

async function load() {
  error.value = '';
  try {
    await store.fetchPush();
  } catch (e: any) {
    error.value = e.message || 'failed to load notification settings';
    return;
  }
  // The load never waits on the relay, so its status may be missing or a minute
  // old; ask for it now. Only while opted in — otherwise nothing contacts the
  // relay until the admin presses "check".
  if (store.push?.relay.enabled) store.refreshRelayStatus().catch(() => {});
  // The log and the client list stand on their own: a failed load of either
  // leaves its section empty, not the pane.
  reloadLog();
}

// The checkbox flips itself before we know whether the change will stick, and
// Vue won't put it back: the bound value never changed. So a cancelled or
// failed change resets the input by hand.
async function toggle(e: Event) {
  const input = e.target as HTMLInputElement;
  const enabled = input.checked;
  if (
    !enabled &&
    (push.value?.relay.devices ?? 0) > 0 &&
    !confirm(`Turn off the relay? ${deviceCount.value} will stop getting notifications.`)
  ) {
    input.checked = true;
    return;
  }
  error.value = '';
  busy.value = true;
  try {
    await store.setPushRelayEnabled(enabled);
  } catch (e: any) {
    // The store refetched (or kept the refusal's answer); show what the server holds.
    input.checked = store.push?.relay.enabled ?? !enabled;
    // A refused turn-on (409) is explained by the status line; saying it twice
    // would be noise.
    if (e?.status !== 409) error.value = e.message || 'failed to change the relay setting';
  } finally {
    busy.value = false;
  }
}

onMounted(load);
</script>

<style src="../settings-panes/panes.css"></style>
<style scoped>
.sockets {
  list-style: none;
  margin: 0;
  padding: 0;
  grid-column: 1 / -1;
}
.log-actions {
  display: flex;
  gap: 1ch;
  margin: 0 0 var(--space-3);
}
.push-log {
  list-style: none;
  margin: 0;
  padding: 0;
}
.push-row {
  display: grid;
  grid-template-columns: max-content 1fr;
  column-gap: var(--space-6);
  padding: var(--space-3) 0;
  border-top: 1px solid var(--border);
}
.push-row:first-child {
  border-top: none;
}
.push-row .when {
  color: var(--fg-muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.push-row .how {
  grid-column: 2;
  color: var(--fg-muted);
  overflow-wrap: anywhere;
}
.push-row.sent .how {
  color: var(--fg);
}
.push-row.failed .how {
  color: var(--bad);
}
.key-row {
  display: flex;
  align-items: center;
  gap: 1ch;
  margin-bottom: var(--space-6);
}
.key {
  flex: 1 1 auto;
  font-family: var(--mono);
  word-break: break-all;
  user-select: all;
  background: var(--bg);
  padding: var(--space-2) var(--space-4);
  border: 1px solid var(--border);
  min-width: 0;
}
.relay-status {
  display: flex;
  gap: 1ch;
  margin-top: calc(-1 * var(--space-4));
  margin-bottom: var(--space-6);
}
.check {
  flex-direction: row;
  align-items: center;
  gap: var(--space-3);
}
.check input {
  width: auto;
}
</style>
