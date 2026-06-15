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
        <span class="ua">{{ formatUA(sub.user_agent) }}</span>
        <span class="last-seen" :title="sub.last_seen_at"
          >last seen {{ formatRelative(sub.last_seen_at) }}</span
        >
        <button class="link danger" @click="onRemoveOther(sub)" :disabled="pushBusy">remove</button>
      </li>
    </ul>
    <p v-else-if="pushSubsStore.loaded && thisClientEnabled" class="muted small">
      No other devices registered.
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
        <button class="link danger" @click="removeAlwaysNotify(entry.networkId, entry.target)">
          stop
        </button>
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
import { formatRelative } from '../../utils/timestamp.js';
import { getOption } from '../../utils/settingsRegistry.js';
import { playSound } from '../../composables/useHighlightNotifier.js';
import type { SettingValue, EnumOption } from '../../../../shared/settingsRegistry.js';
import {
  isSupported as isPushSupported,
  registerSW,
  enable as enablePush,
  disable as disablePush,
  getCurrentEndpoint,
} from '../../composables/usePush.js';

// The push subscriptions store's PushSubscription covers the core fields; the
// server also returns `id`, `user_agent`, and `last_seen_at`. Extend here so
// the template can display them without colliding with the browser API type.
interface StoredPushSub extends PushSubscription {
  id: string;
  user_agent: string | null;
  last_seen_at: string;
}

const settings = useSettingsStore();
const pushSubsStore = usePushSubscriptionsStore();
const channelNotify = useChannelNotifyStore();
const networksStore = useNetworksStore();

const pushSupported = isPushSupported();
const pushError = ref('');
const pushBusy = ref(false);
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
    help: 'When a friend you have flagged "notify when online" comes online. The per-friend toggle in the Configure Friend dialog is the opt-in.',
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
});

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

function formatUA(ua: string | null | undefined): string {
  if (!ua) return 'unknown device';
  // Cheap parser: extract a recognizable browser + OS pair from a UA string.
  let browser = 'browser';
  if (/Firefox\//.test(ua)) browser = 'Firefox';
  else if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/Chrome\//.test(ua)) browser = 'Chrome';
  else if (/Safari\//.test(ua)) browser = 'Safari';
  let os = '';
  if (/iPhone|iPad/.test(ua)) os = 'iOS';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/Mac OS X/.test(ua)) os = 'macOS';
  else if (/Windows/.test(ua)) os = 'Windows';
  else if (/Linux/.test(ua)) os = 'Linux';
  return os ? `${browser} on ${os}` : browser;
}
</script>

<style src="./panes.css"></style>
<style scoped>
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
