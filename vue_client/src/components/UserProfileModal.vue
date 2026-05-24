<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<!--
  Replaces the old /whois motd dump (issue #92). Opens from the slash
  command, the nicklist menu, the DM context menu, and the DM header.
  Renders the cached whois entry immediately and shows a refreshing
  indicator until the new result lands; if no whois ever arrives the
  empty state explains why.

  Note editor lives in NickNoteModal — the "Edit note" button opens
  that instead of duplicating the editor here, so the editor has a
  single source of truth.
-->

<template>
  <AppModal word="profile" :title="nick" size="md" align="top" @close="onClose">
    <template #subtitle>
      <span :class="['presence', presenceClass]">
        <span class="dot" aria-hidden="true"></span>
        {{ presenceLabel }}
      </span>
      <span v-if="awayMessage" class="away-msg">— {{ awayMessage }}</span>
    </template>

    <div class="body">
      <!-- Identity -->
      <section v-if="hasIdentity" class="section">
        <h3>Identity</h3>
        <dl>
          <template v-if="whois?.real_name">
            <dt>Real name</dt>
            <dd>{{ whois.real_name }}</dd>
          </template>
          <template v-if="hostmask">
            <dt>Hostmask</dt>
            <dd>
              <code>{{ hostmask }}</code>
              <button type="button" class="link inline" title="Copy hostmask" @click="copyHostmask">
                <i class="fa-solid fa-copy"></i>
              </button>
            </dd>
          </template>
          <template v-if="actualHost">
            <dt>Connected from</dt>
            <dd>
              <code>{{ actualHost }}</code>
            </dd>
          </template>
          <template v-if="whois?.account">
            <dt>Account</dt>
            <dd>{{ whois.account }}</dd>
          </template>
        </dl>
        <div v-if="chips.length" class="chips">
          <span v-for="c in chips" :key="c.label" :class="['chip', c.tone]">
            <i v-if="c.icon" :class="c.icon"></i> {{ c.label }}
          </span>
        </div>
      </section>

      <!-- Activity -->
      <section v-if="hasActivity" class="section">
        <h3>Activity</h3>
        <dl>
          <template v-if="idleLabel">
            <dt>Idle</dt>
            <dd>{{ idleLabel }}</dd>
          </template>
          <template v-if="signonLabel">
            <dt>Signed on</dt>
            <dd>{{ signonLabel }}</dd>
          </template>
          <template v-if="whois?.server">
            <dt>Server</dt>
            <dd>
              {{ whois.server }}
              <span v-if="whois.server_info" class="muted">({{ whois.server_info }})</span>
            </dd>
          </template>
          <template v-if="channelsList.length">
            <dt>Channels</dt>
            <dd class="channels">
              <button
                v-for="ch in channelsList"
                :key="ch.name"
                type="button"
                class="link channel"
                @click="onChannelClick(ch.name)"
              >
                <span class="ch-prefix">{{ ch.prefix }}</span
                >{{ ch.name }}
              </button>
            </dd>
          </template>
        </dl>
      </section>

      <!-- Your note -->
      <section class="section">
        <h3>Your note</h3>
        <div v-if="noteText" class="note">
          <p class="note-body">{{ noteText }}</p>
          <p class="meta">
            <span v-if="noteUpdatedAt">Updated {{ formatDateTime(noteUpdatedAt) }}</span>
            <button type="button" class="link inline" @click="openNoteEditor">
              <i class="fa-solid fa-pen"></i> Edit
            </button>
          </p>
        </div>
        <div v-else class="note empty">
          <p class="muted">No note yet.</p>
          <button type="button" class="link inline" @click="openNoteEditor">
            <i class="fa-solid fa-plus"></i> Add note
          </button>
        </div>
      </section>

      <!-- Transient waiting state — only while we're genuinely in the dark.
           If we already know they're offline (MONITOR or not_found whois)
           the presence dot in the header carries that, so we skip the
           redundant line and let "Your note" stand on its own. -->
      <section v-if="!hasIdentity && !hasActivity && !isOffline" class="section status">
        <p class="muted">
          <i class="fa-solid fa-circle-notch fa-spin"></i> Waiting for whois reply…
        </p>
      </section>
    </div>

    <footer class="footer">
      <!-- Send DM and Ignore are meaningless while the peer is offline —
           DMs would bounce and there's no hostmask to build an ignore rule
           from. Hide entirely rather than disable so the modal doesn't read
           as "you could do this if only…". -->
      <button
        v-if="!isOffline"
        type="button"
        class="btn-secondary"
        @click="onSendDm"
        :disabled="isSelf"
      >
        <i class="fa-solid fa-envelope"></i> Send DM
      </button>
      <button
        v-if="!isOffline"
        type="button"
        class="btn-secondary"
        @click="onIgnore"
        :disabled="isSelf"
      >
        <i class="fa-solid fa-ban"></i> Ignore…
      </button>
      <span class="spacer"></span>
      <button type="button" class="btn-secondary" @click="onRefresh" title="Re-run whois">
        <i class="fa-solid fa-arrows-rotate"></i> Refresh
      </button>
    </footer>

    <IgnoreModal
      v-if="ignoreOpen"
      :nick="nick"
      :user="(whois?.ident as string | null) ?? null"
      :host="(whois?.hostname as string | null) ?? null"
      :network-id="networkId"
      @close="ignoreOpen = false"
    />
  </AppModal>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import AppModal from './AppModal.vue';
import IgnoreModal from './IgnoreModal.vue';
import { useWhoisStore } from '../stores/whois.js';
import { useNickNotesStore } from '../stores/nickNotes.js';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { socketSend } from '../composables/useSocket.js';
import { formatDateTime } from '../utils/timestamp.js';
import { isPeerAway, isPeerOffline, isPeerOnline } from '../utils/peerPresence.js';

const props = defineProps<{
  nick: string;
  networkId: number;
}>();

const whoisStore = useWhoisStore();
const nickNotes = useNickNotesStore();
const networks = useNetworksStore();
const buffers = useBuffersStore();
const ignoreOpen = ref(false);

const entry = computed(() => whoisStore.entryFor(props.networkId, props.nick));
const whois = computed(() => entry.value?.data ?? null);

const selfNick = computed(() => networks.states[props.networkId]?.nick ?? null);
const isSelf = computed(
  () => !!selfNick.value && selfNick.value.toLowerCase() === props.nick.toLowerCase(),
);

const peer = computed(
  () => networks.states[props.networkId]?.peerPresence?.[props.nick.toLowerCase()] ?? null,
);
const awayMessage = computed(() => {
  // Prefer the live away-notify payload (peer-presence), fall back to the
  // whois reply's away line — the latter is only populated when whois ran
  // while the peer was away, so peer-presence is the more current source.
  const fromPresence = peer.value?.awayMessage || '';
  if (fromPresence) return fromPresence;
  return (whois.value?.away as string) || '';
});

const presenceClass = computed(() => {
  if (isPeerOffline(peer.value)) return 'offline';
  if (isPeerAway(peer.value) || awayMessage.value) return 'away';
  if (isPeerOnline(peer.value)) return 'online';
  // No presence data — if whois returned an identity we know they're online.
  if (whois.value && !isNotFound.value) return 'online';
  return 'unknown';
});
const presenceLabel = computed(() => {
  switch (presenceClass.value) {
    case 'online':
      return 'Online';
    case 'away':
      return 'Away';
    case 'offline':
      return 'Offline';
    default:
      return 'Unknown';
  }
});

const isNotFound = computed(
  () => (whois.value as { error?: string } | null)?.error === 'not_found',
);
// "Offline" for footer/empty-state purposes: either MONITOR has confirmed
// they're not on the network, or WHOIS came back with no-such-nick. Both
// mean Send DM / Ignore have nothing to bite on.
const isOffline = computed(() => isPeerOffline(peer.value) || isNotFound.value);

const hostmask = computed(() => {
  if (!whois.value) return '';
  const ident = (whois.value.ident as string) || '';
  const host = (whois.value.hostname as string) || '';
  if (!ident && !host) return '';
  return `${props.nick}!${ident || '*'}@${host || '*'}`;
});

const actualHost = computed(() => {
  if (!whois.value) return '';
  return [whois.value.actual_hostname, whois.value.actual_ip].filter(Boolean).join(' ');
});

interface Chip {
  label: string;
  tone: 'good' | 'neutral' | 'warn';
  icon?: string;
}
const chips = computed<Chip[]>(() => {
  const w = whois.value;
  if (!w) return [];
  const out: Chip[] = [];
  if (w.secure) out.push({ label: 'TLS', tone: 'good', icon: 'fa-solid fa-lock' });
  if (w.bot) out.push({ label: 'Bot', tone: 'neutral', icon: 'fa-solid fa-robot' });
  if (w.operator)
    out.push({ label: 'IRC operator', tone: 'warn', icon: 'fa-solid fa-shield-halved' });
  if (w.helpop) out.push({ label: 'Help', tone: 'neutral', icon: 'fa-solid fa-circle-info' });
  if (w.registered_nick)
    out.push({ label: 'Registered', tone: 'good', icon: 'fa-solid fa-id-badge' });
  return out;
});

const idleLabel = computed(() => {
  const idle = whois.value?.idle;
  if (idle == null) return '';
  const n = Number(idle);
  if (!Number.isFinite(n)) return '';
  return humanDuration(n);
});

const signonLabel = computed(() => {
  const logon = whois.value?.logon;
  if (logon == null) return '';
  const n = Number(logon);
  if (!Number.isFinite(n)) return '';
  return formatDateTime(new Date(n * 1000).toISOString());
});

// irc-framework hands `channels` back as a single string of prefix+name
// tokens separated by spaces, e.g. "@#foo +#bar #baz". Split on whitespace
// and peel any leading mode-prefix glyphs off so the name itself is clean
// for join/switch.
const channelsList = computed(() => {
  const raw = (whois.value?.channels as string) || '';
  if (!raw) return [] as { prefix: string; name: string }[];
  return raw
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => {
      const m = token.match(/^([~&@%+]*)(.*)$/);
      return { prefix: m?.[1] || '', name: m?.[2] || token };
    });
});

const hasIdentity = computed(
  () => !!(whois.value && (whois.value.real_name || hostmask.value || whois.value.account)),
);
const hasActivity = computed(
  () =>
    !!(
      whois.value &&
      (idleLabel.value || signonLabel.value || whois.value.server || channelsList.value.length)
    ),
);

const noteEntry = computed(() => nickNotes.entryFor(props.networkId, props.nick));
const noteText = computed(() => noteEntry.value?.note || '');
const noteUpdatedAt = computed(() => noteEntry.value?.updatedAt || '');

function humanDuration(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))}s`;
  const min = Math.floor(seconds / 60);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const rm = min % 60;
  if (h < 24) return rm ? `${h}h ${rm}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `${d}d ${rh}h` : `${d}d`;
}

function onClose() {
  whoisStore.closeViewer();
}

function onSendDm() {
  if (isSelf.value) return;
  buffers.activate(props.networkId, props.nick);
  whoisStore.closeViewer();
}

function onIgnore() {
  if (isSelf.value) return;
  ignoreOpen.value = true;
}

function openNoteEditor() {
  nickNotes.openEditor(props.networkId, props.nick);
}

function onChannelClick(channel: string) {
  // Send a JOIN — if we're already on it the server is a no-op and the
  // existing buffer activation will surface it.
  socketSend({ type: 'join', networkId: props.networkId, channel });
  buffers.activate(props.networkId, channel);
  whoisStore.closeViewer();
}

function onRefresh() {
  socketSend({ type: 'raw', networkId: props.networkId, line: `WHOIS ${props.nick}` });
}

function copyHostmask() {
  const text = hostmask.value;
  if (!text) return;
  try {
    void navigator.clipboard?.writeText(text);
  } catch (_) {
    /* ignore — older browsers without clipboard API just don't copy */
  }
}
</script>

<style scoped>
.body {
  display: flex;
  flex-direction: column;
  gap: 20px;
  overflow-y: auto;
  flex: 1;
  min-height: 0;
  /* Break out of card padding so the scrollbar sits against the card
     border; padding keeps section content visually aligned. */
  margin: 0 calc(-1 * var(--card-pad-x));
  padding: 0 var(--card-pad-x) 8px;
}

.presence {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--fg);
  font-weight: 600;
}
.presence .dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--fg-muted);
}
.presence.online .dot {
  background: var(--good, #4ec27e);
}
.presence.away .dot {
  background: var(--warn, #d4a256);
}
.presence.offline .dot {
  background: var(--bad);
}
.presence.unknown .dot {
  background: var(--fg-muted);
}
.away-msg {
  margin-left: 8px;
  color: var(--fg-muted);
  font-weight: 400;
}

.section h3 {
  margin: 0 0 8px;
  color: var(--accent);
  font-weight: 700;
  text-transform: lowercase;
  letter-spacing: 0.02em;
}

dl {
  display: grid;
  grid-template-columns: max-content 1fr;
  column-gap: 16px;
  row-gap: 6px;
  margin: 0;
}
dt {
  color: var(--fg-muted);
  font-weight: 400;
}
dd {
  margin: 0;
  color: var(--fg);
  min-width: 0;
  word-break: break-word;
}
code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  background: var(--bg-soft);
  padding: 1px 6px;
}
.muted {
  color: var(--fg-muted);
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 10px;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: 1px solid var(--border);
  padding: 2px 8px;
  border-radius: 999px;
  color: var(--fg);
}
.chip.good {
  border-color: var(--good, #4ec27e);
  color: var(--good, #4ec27e);
}
.chip.warn {
  border-color: var(--warn, #d4a256);
  color: var(--warn, #d4a256);
}

.channels {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
}
.channel {
  background: none;
  border: none;
  color: var(--accent);
  cursor: pointer;
  padding: 0;
  font: inherit;
}
.channel:hover {
  text-decoration: underline;
}
.ch-prefix {
  color: var(--fg-muted);
  margin-right: 1px;
}

.note .note-body {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
}
.note.empty {
  display: flex;
  align-items: center;
  gap: 12px;
}
.meta {
  margin: 8px 0 0;
  color: var(--fg-muted);
  display: flex;
  gap: 12px;
  align-items: baseline;
}

.link.inline {
  background: none;
  border: none;
  color: var(--accent);
  cursor: pointer;
  font: inherit;
  padding: 0 4px;
}
.link.inline:hover {
  text-decoration: underline;
}

.status {
  padding: 12px 0;
}

.footer {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-top: 16px;
  border-top: 1px solid var(--border);
}
.footer .spacer {
  flex: 1;
}
.btn-secondary {
  background: none;
  border: 1px solid var(--border);
  color: var(--fg);
  padding: 6px 12px;
  cursor: pointer;
  font: inherit;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.btn-secondary:hover:not(:disabled) {
  background: var(--bg-soft);
}
.btn-secondary:disabled {
  opacity: 0.4;
  cursor: default;
}
</style>
