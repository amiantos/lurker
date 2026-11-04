<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <section id="notifications" class="settings-pane">
    <h2>notifications</h2>
    <p class="section-desc">
      Each browser/device subscribes independently. Enable here to receive system notifications on
      this device when a highlight or DM arrives and no other client of yours is currently visible.
    </p>
    <p v-if="pushError" class="error inline">{{ pushError }}</p>

    <div class="this-client">
      <span class="this-label">this client</span>
      <button v-if="!pushSupported" class="link" disabled>
        push not supported in this browser
      </button>
      <button
        v-else-if="thisClientEnabled"
        class="link danger"
        :disabled="pushBusy"
        @click="onDisableThisClient"
      >
        disable for this client
      </button>
      <button v-else class="link" :disabled="pushBusy" @click="onEnableThisClient">
        enable for this client
      </button>
    </div>

    <ul v-if="otherSubscriptions.length" class="device-list">
      <li v-for="sub in otherSubscriptions" :key="sub.id" class="device">
        <span class="ua">
          {{ deviceLabel(sub) }}
          <span
            v-if="!sub.enabled"
            class="muted"
            title="Push kept failing for this device; enable push again from it."
            >disabled</span
          >
        </span>
        <span class="last-seen" :title="sub.last_seen_at"
          >last seen {{ formatRelative(sub.last_seen_at) }}</span
        >
        <IconButton
          :icon="TrashIcon"
          label="remove"
          danger
          :disabled="pushBusy"
          @click="onRemoveOther(sub)"
        />
      </li>
    </ul>
    <p v-else-if="pushSubsStore.loaded && thisClientEnabled" class="muted small">
      No other devices registered.
    </p>

    <p class="test-push">
      <button class="link" type="button" :disabled="pushBusy || testBusy" @click="onSendTest">
        {{ testBusy ? 'sending…' : 'send a test push' }}
      </button>
      <span v-if="testResult" class="muted small">{{ testResult }}</span>
    </p>
    <p class="muted small">
      A test skips every rule below and goes to every device, so it answers whether push reaches you
      at all. The log underneath says what happened to each real one.
    </p>

    <hr class="hl-sep" />
    <h3 class="subhead">current clients</h3>
    <p class="section-desc">
      Push fires only while none of these is visible. A tab you left in front, or the app open on
      your phone, is the usual reason a notification stayed put.
    </p>
    <ul v-if="pushSubsStore.clients.length" class="device-list">
      <li v-for="(c, i) in pushSubsStore.clients" :key="i" class="device">
        <span class="ua">{{ clientLabel(c.userAgent) }}</span>
        <span class="last-seen">{{ c.visible ? 'visible' : 'in the background' }}</span>
        <span v-if="c.connectedAt" class="last-seen" :title="c.connectedAt"
          >since {{ formatRelative(c.connectedAt) }}</span
        >
      </li>
    </ul>
    <p v-else class="muted small">No client is connected.</p>

    <hr class="hl-sep" />
    <h3 class="subhead">recent pushes</h3>
    <p class="section-desc">
      Every notification this server tried to send you in the last week, and what became of it. A
      "sent" line means the push service took it; after that it's the device's.
    </p>
    <ul v-if="pushSubsStore.log.length" class="push-log">
      <li v-for="row in pushSubsStore.log" :key="row.id" class="push-row" :class="row.outcome">
        <span class="when" :title="row.at">{{ formatDateTime(row.at) }}</span>
        <span class="what">{{ kindLabel(row.kind) }} · {{ subjectLabel(row) }}</span>
        <span class="how">{{ outcomeLabel(row) }}</span>
      </li>
    </ul>
    <p v-else-if="pushSubsStore.logLoaded" class="muted small">Nothing in the last week.</p>
    <p v-if="pushSubsStore.logHasMore">
      <button class="link" type="button" :disabled="olderBusy" @click="onOlderLog">
        {{ olderBusy ? 'loading…' : 'show older' }}
      </button>
    </p>

    <hr class="hl-sep" />
    <h3 class="subhead">alerts</h3>
    <p class="section-desc">
      One master toggle per signal type. Toast appears in-client when a tab is visible; push fires
      when no tab is visible — the right one is picked automatically, so a single switch covers
      both.
    </p>

    <div v-for="signal in notificationSignals" :key="signal.key" class="hl-notif notif-signal">
      <h4 class="notif-signal-title">{{ signal.title }}</h4>
      <p class="section-desc small">{{ signal.help }}</p>

      <label class="hl-row" :data-setting-key="`notifications.${signal.key}.enabled`">
        <input
          type="checkbox"
          :checked="signal.enabled"
          @change="
            onCommit(
              `notifications.${signal.key}.enabled`,
              ($event.target as HTMLInputElement).checked,
            )
          "
        />
        <span>notify me</span>
      </label>

      <label
        class="hl-row"
        :class="{ 'hl-row--dim': !signal.enabled }"
        :data-setting-key="`notifications.${signal.key}.sound.enabled`"
      >
        <input
          type="checkbox"
          :disabled="!signal.enabled"
          :checked="!!settings.effective(`notifications.${signal.key}.sound.enabled`)"
          @change="
            onCommit(
              `notifications.${signal.key}.sound.enabled`,
              ($event.target as HTMLInputElement).checked,
            )
          "
        />
        <span>play a sound</span>
      </label>

      <div
        class="hl-row"
        :class="{ 'hl-row--dim': !signal.soundEnabled }"
        :data-setting-key="`notifications.${signal.key}.sound.choice`"
      >
        <span class="hl-label">sound</span>
        <select
          :value="settings.effective(`notifications.${signal.key}.sound.choice`)"
          :disabled="!signal.soundEnabled"
          @change="
            onCommit(
              `notifications.${signal.key}.sound.choice`,
              ($event.target as HTMLSelectElement).value,
            )
          "
        >
          <option v-for="c in soundChoices" :key="c" :value="c">{{ c }}</option>
        </select>
        <button class="link" :disabled="!signal.soundEnabled" @click="onPreviewSound(signal.key)">
          preview
        </button>
      </div>

      <div
        class="hl-row"
        :class="{ 'hl-row--dim': !signal.soundEnabled }"
        :data-setting-key="`notifications.${signal.key}.sound.volume`"
      >
        <span class="hl-label">volume</span>
        <input
          type="range"
          min="0"
          max="100"
          step="1"
          :value="settings.effective(`notifications.${signal.key}.sound.volume`)"
          :disabled="!signal.soundEnabled"
          @input="onVolumeInput(signal.key, ($event.target as HTMLInputElement).value)"
          @change="
            onCommit(
              `notifications.${signal.key}.sound.volume`,
              Number(($event.target as HTMLInputElement).value),
            )
          "
        />
        <span class="hl-vol-num">{{
          settings.effective(`notifications.${signal.key}.sound.volume`)
        }}</span>
      </div>
    </div>

    <hr class="hl-sep" />
    <h3 class="subhead">always-notify channels</h3>
    <p class="section-desc">
      Channels flagged "always notify" via the channel context menu fire notifications for every
      message. This is the one place to see and remove the set.
    </p>
    <p v-if="!alwaysNotifyChannelList.length" class="muted small">
      None yet. Right-click a channel in the buffer list to enable.
    </p>
    <ul v-else class="device-list">
      <li v-for="entry in alwaysNotifyChannelList" :key="entry.key" class="device">
        <span class="ua">{{ entry.networkName }} · {{ entry.target }}</span>
        <div class="row-actions">
          <IconButton
            :icon="TrashIcon"
            label="stop"
            danger
            @click="removeAlwaysNotify(entry.networkId, entry.target)"
          />
        </div>
      </li>
    </ul>

    <hr class="hl-sep" />
    <h3 class="subhead">push filters</h3>
    <p class="section-desc">
      Conditions that suppress push notifications globally. Toasts are unaffected — they only fire
      when you're at the desk anyway.
    </p>
    <div class="hl-notif">
      <label class="hl-row" data-setting-key="notifications.push.mute_when_away">
        <input
          type="checkbox"
          :checked="!!settings.effective('notifications.push.mute_when_away')"
          @change="
            onCommit(
              'notifications.push.mute_when_away',
              ($event.target as HTMLInputElement).checked,
            )
          "
        />
        <span>mute push notifications when manually away</span>
      </label>

      <label class="hl-row" data-setting-key="notifications.push.quiet_hours.enabled">
        <input
          type="checkbox"
          :checked="!!settings.effective('notifications.push.quiet_hours.enabled')"
          @change="
            onCommit(
              'notifications.push.quiet_hours.enabled',
              ($event.target as HTMLInputElement).checked,
            )
          "
        />
        <span>quiet hours</span>
      </label>

      <div class="hl-row" :class="{ 'hl-row--dim': !quietHoursEnabled }">
        <span class="hl-label">from</span>
        <input
          type="time"
          data-setting-key="notifications.push.quiet_hours.start"
          :value="settings.effective('notifications.push.quiet_hours.start')"
          :disabled="!quietHoursEnabled"
          @change="
            onCommit(
              'notifications.push.quiet_hours.start',
              ($event.target as HTMLInputElement).value,
            )
          "
        />
        <span class="hl-label">to</span>
        <input
          type="time"
          data-setting-key="notifications.push.quiet_hours.end"
          :value="settings.effective('notifications.push.quiet_hours.end')"
          :disabled="!quietHoursEnabled"
          @change="
            onCommit(
              'notifications.push.quiet_hours.end',
              ($event.target as HTMLInputElement).value,
            )
          "
        />
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useSettingsStore } from '../../stores/settings.js';
import { usePushSubscriptionsStore } from '../../stores/pushSubscriptions.js';
import type { PushSubscription } from '../../stores/pushSubscriptions.js';
import { useChannelNotifyStore } from '../../stores/channelNotify.js';
import { useNetworksStore } from '../../stores/networks.js';
import { formatRelative, formatDateTime } from '../../utils/timestamp.js';
import { clientLabel, kindLabel, outcomeLabel, subjectLabel } from '../../utils/pushLog.js';
import { getOption } from '../../utils/settingsRegistry.js';
import { playSound } from '../../composables/useHighlightNotifier.js';
import IconButton from '../IconButton.vue';
import type { SettingValue, EnumOption } from '../../../../shared/settingsRegistry.js';
import {
  isSupported as isPushSupported,
  registerSW,
  enable as enablePush,
  disable as disablePush,
  getCurrentEndpoint,
} from '../../composables/usePush.js';
import { TrashIcon } from '@lucide/vue';

// The push subscriptions store's PushSubscription covers the core fields; the
// server also returns `id`, `user_agent`, and `last_seen_at`. Extend here so
// the template can display them without colliding with the browser API type.
interface StoredPushSub extends PushSubscription {
  id: string;
  transport: string;
  user_agent: string | null;
  enabled: boolean;
  last_seen_at: string;
}

const settings = useSettingsStore();
const pushSubsStore = usePushSubscriptionsStore();
const channelNotify = useChannelNotifyStore();
const networksStore = useNetworksStore();

const pushSupported = isPushSupported();
const pushError = ref('');
const pushBusy = ref(false);
const testBusy = ref(false);
const testResult = ref('');
const olderBusy = ref(false);
const currentEndpoint = ref<string | null>(null);

const thisClientEnabled = computed(() => {
  if (!currentEndpoint.value) return false;
  return pushSubsStore.subscriptions.some((s) => s.endpoint === currentEndpoint.value);
});
const otherSubscriptions = computed(() =>
  (pushSubsStore.subscriptions as StoredPushSub[]).filter(
    (s) => s.endpoint !== currentEndpoint.value,
  ),
);
const quietHoursEnabled = computed(
  () => !!settings.effective('notifications.push.quiet_hours.enabled'),
);

// Sound choice list is the same enum across all signal types — read off any
// one of the keys (they share a `choices` array in the registry).
const soundChoices = computed(
  () =>
    (getOption('notifications.highlight.sound.choice') as EnumOption | undefined)?.choices || [],
);

const NOTIFICATION_SIGNALS = [
  {
    key: 'highlight',
    title: 'Highlights',
    help: 'When a message matches one of your highlight rules.',
  },
  {
    key: 'dm',
    title: 'Direct messages',
    help: 'When someone sends you a DM.',
  },
  {
    key: 'always_notify',
    title: 'Always-notify channels',
    help: 'For every message in channels you have flagged via the channel context menu.',
  },
  {
    key: 'friend_online',
    title: 'Friend online',
    help: 'When the peer of a DM in your FRIENDS section comes online.',
  },
  {
    key: 'kicked',
    title: 'Kicks',
    help: 'When you are kicked from a channel. No bell needed — but a muted channel stays silent.',
  },
];

const notificationSignals = computed(() =>
  NOTIFICATION_SIGNALS.map((s) => {
    const enabled = !!settings.effective(`notifications.${s.key}.enabled`);
    const soundEnabled = enabled && !!settings.effective(`notifications.${s.key}.sound.enabled`);
    return { ...s, enabled, soundEnabled };
  }),
);

const alwaysNotifyChannelList = computed(() => {
  return channelNotify.alwaysNotifyChannels
    .map((entry) => ({
      ...entry,
      key: `${entry.networkId}::${entry.target}`,
      networkName: networksStore.networkById(entry.networkId)?.name || `net:${entry.networkId}`,
    }))
    .toSorted(
      (a, b) => a.networkName.localeCompare(b.networkName) || a.target.localeCompare(b.target),
    );
});

async function refreshPushState() {
  if (!pushSupported) return;
  try {
    currentEndpoint.value = await getCurrentEndpoint();
  } catch {
    currentEndpoint.value = null;
  }
  try {
    await pushSubsStore.fetchAll();
  } catch (e: any) {
    pushError.value = e.message || 'failed to load devices';
  }
}

onMounted(() => {
  if (pushSupported) {
    registerSW().catch(() => {
      /* best-effort */
    });
    refreshPushState();
  }
  // The log and the client list are about the account, not this browser, so
  // they load even where push itself isn't supported.
  pushSubsStore.fetchLog().catch((e: any) => {
    pushError.value = e.message || 'failed to load the push log';
  });
  pushSubsStore.fetchClients().catch(() => {});
});

async function onSendTest() {
  testBusy.value = true;
  testResult.value = '';
  try {
    const { sent, dropped, devices, disabled } = await pushSubsStore.sendTest();
    const off = disabled ? ` (${disabled} disabled after repeated failures)` : '';
    if (devices === 0) testResult.value = `no device to send to${off}`;
    else if (sent === 0 && dropped === 0) {
      testResult.value = `held for every device — see the log${off}`;
    } else {
      const n = sent === 1 ? '1 device' : `${sent} devices`;
      testResult.value = (dropped ? `sent to ${n}, ${dropped} failed` : `sent to ${n}`) + off;
    }
  } catch (e: any) {
    testResult.value =
      e?.status === 429
        ? 'one test every few seconds — try again shortly'
        : e.message || 'failed to send';
  } finally {
    testBusy.value = false;
  }
}

async function onCommit(key: string, value: SettingValue) {
  try {
    await settings.setValue(key, value);
  } catch (e: any) {
    pushError.value = e.message || 'failed to save';
  }
}

function onPreviewSound(kindKey: string) {
  const choice = settings.effective(`notifications.${kindKey}.sound.choice`) || 'ping';
  const volume = settings.effective(`notifications.${kindKey}.sound.volume`);
  playSound(choice as string, volume as number);
}

// Live-update volume on drag without spamming the server: the range input's
// `input` event tweaks the local optimistic value, and `change` commits.
function onVolumeInput(kindKey: string, raw: string) {
  const n = Number(raw);
  if (Number.isFinite(n)) {
    settings.values = { ...settings.values, [`notifications.${kindKey}.sound.volume`]: n };
  }
}

function removeAlwaysNotify(networkId: number, target: string) {
  channelNotify.setNotifyAlways(networkId, target, false);
}

async function onOlderLog() {
  olderBusy.value = true;
  try {
    await pushSubsStore.fetchOlderLog();
  } catch (e: any) {
    pushError.value = e.message || 'failed to load older rows';
  } finally {
    olderBusy.value = false;
  }
}

async function onEnableThisClient() {
  pushError.value = '';
  pushBusy.value = true;
  try {
    await enablePush();
    await refreshPushState();
  } catch (e: any) {
    pushError.value = e.message || 'failed to enable';
  } finally {
    pushBusy.value = false;
  }
}

async function onDisableThisClient() {
  pushError.value = '';
  pushBusy.value = true;
  try {
    await disablePush();
    await refreshPushState();
  } catch (e: any) {
    pushError.value = e.message || 'failed to disable';
  } finally {
    pushBusy.value = false;
  }
}

async function onRemoveOther(sub: StoredPushSub) {
  pushError.value = '';
  pushBusy.value = true;
  try {
    await pushSubsStore.removeByEndpoint(sub.endpoint);
  } catch (e: any) {
    pushError.value = e.message || 'failed to remove';
  } finally {
    pushBusy.value = false;
  }
}

// A native app's UA is CFNetwork/OkHttp noise, but its transport says exactly
// what it is — the server projects `transport` for precisely this. UA parsing
// is the fallback for webpush rows, where the browser genuinely is the client.
function deviceLabel(sub: StoredPushSub): string {
  if (sub.transport === 'apns') return 'Lurker for iOS';
  if (sub.transport === 'fcm') return 'Lurker for Android';
  return clientLabel(sub.user_agent);
}
</script>

<style src="./panes.css"></style>
<style scoped>
.test-push {
  display: flex;
  align-items: center;
  gap: 1ch;
  margin: 0 0 var(--space-2);
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
.this-client {
  display: flex;
  align-items: center;
  gap: var(--space-6);
  padding: 0 0 var(--space-5);
}
.this-label {
  color: var(--fg-muted);
  font-weight: 600;
}

.notif-signal + .notif-signal {
  margin-top: var(--space-7);
  padding-top: var(--space-6);
  border-top: 1px dashed var(--border);
}
.notif-signal-title {
  margin: 0 0 var(--space-2);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--fg);
}
.hl-vol-num {
  color: var(--fg-muted);
  font-variant-numeric: tabular-nums;
  min-width: 2.5em;
  text-align: right;
}
</style>
