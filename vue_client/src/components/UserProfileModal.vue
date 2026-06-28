<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<!--
  Replaces the old /whois motd dump (issue #92). Opens from the slash
  command, the nicklist menu, the DM context menu, and the DM header.
  Renders the cached whois entry immediately and silently overwrites it
  when the new reply arrives; while we have nothing cached the empty
  state shows a spinner (or "offline" if MONITOR already knows).

  Note editor lives in NickNoteModal — the "Edit note" button opens
  that instead of duplicating the editor here, so the editor has a
  single source of truth.
-->

<template>
  <AppModal word="profile" size="md" @close="onClose">
    <template #title>
      <h2>
        <span
          class="dot"
          :class="presenceClass"
          role="img"
          :aria-label="presenceLabel"
          :title="presenceLabel"
        ></span
        >{{ nick }}<span v-if="awayMessage" class="away">&nbsp;({{ awayMessage }})</span>
      </h2>
    </template>

    <div class="body">
      <!-- Identity + activity merged into one headerless table; the status pills
           sit under the table (below Channels), then the note section follows. -->
      <section v-if="hasDetails" class="section">
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
          <template v-if="whois?.server">
            <dt>Server</dt>
            <dd>
              {{ whois.server }}
              <span v-if="whois.server_info" class="muted">({{ whois.server_info }})</span>
            </dd>
          </template>
          <template v-if="idleLabel">
            <dt>Idle</dt>
            <dd>{{ idleLabel }}</dd>
          </template>
          <template v-if="signonLabel">
            <dt>Signed on</dt>
            <dd>{{ signonLabel }}</dd>
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
        <div v-if="chips.length" class="chips">
          <span v-for="c in chips" :key="c.label" :class="['chip', c.tone]">
            <i v-if="c.icon" :class="c.icon"></i> {{ c.label }}
          </span>
        </div>
      </section>

      <!-- Your note — headingless; a divider sets it off from the details above
           (only when there are details to divide from). -->
      <section class="section note-section" :class="{ divided: hasDetails }">
        <div class="note">
          <p v-if="noteText" class="note-body">{{ noteText }}</p>
          <p class="meta">
            <span v-if="noteUpdatedAt">Updated {{ formatDateTime(noteUpdatedAt) }}</span>
            <button type="button" class="link inline" @click="openNoteEditor">
              <i :class="noteText ? 'fa-solid fa-pen' : 'fa-solid fa-plus'"></i>
              {{ noteText ? 'Edit' : 'Add note' }}
            </button>
          </p>
        </div>
      </section>

      <!-- Transient waiting state — only while we're genuinely in the dark.
           If we already know they're offline (MONITOR or not_found whois)
           the presence dot in the header carries that, so we skip the
           redundant line and let "Your note" stand on its own. -->
      <section v-if="!hasDetails && !isOffline" class="section status">
        <p class="muted">
          <i class="fa-solid fa-circle-notch fa-spin"></i> Waiting for whois reply…
        </p>
      </section>
    </div>

    <footer class="modal-footer">
      <!-- Primary actions only. Send DM is meaningless on yourself and while the
           peer is offline (a DM would bounce), so it's hidden then. Add Friend
           works regardless of presence — you can watch an offline peer — so it
           isn't gated on isOffline. Everything else (Ignore, relay-bot toggle,
           Refresh) lives in the More menu so the footer never crowds or wraps. -->
      <button
        v-if="!isOffline && !isSelf"
        type="button"
        class="btn-secondary"
        title="Send DM"
        @click="onSendDm"
      >
        <i class="fa-solid fa-envelope"></i> <span class="label">Send DM</span>
      </button>
      <button
        v-if="!isSelf"
        type="button"
        class="btn-secondary"
        :title="isFriend ? 'Edit Friend' : 'Add Friend'"
        @click="onAddFriend"
      >
        <i class="fa-solid fa-user-group"></i>
        <span class="label">{{ isFriend ? 'Edit Friend' : 'Add Friend' }}</span>
      </button>
      <span class="spacer"></span>
      <button type="button" class="btn-secondary" title="More actions" @click="openMoreMenu">
        <i class="fa-solid fa-ellipsis"></i> <span class="label">More</span>
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
import { useRelayBotsStore } from '../stores/relayBots.js';
import { useFriendsStore } from '../stores/friends.js';
import { useContextMenu, type ContextMenuItem } from '../composables/useContextMenu.js';
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
const relayBots = useRelayBotsStore();
const friends = useFriendsStore();
const contextMenu = useContextMenu();
const networks = useNetworksStore();
const buffers = useBuffersStore();
const ignoreOpen = ref(false);

const isFriend = computed(() => !!friends.contactForTarget(props.networkId, props.nick));
const isRelay = computed(() => relayBots.isRelay(props.networkId, props.nick));

const entry = computed(() => whoisStore.entryFor(props.networkId, props.nick));
const whois = computed(() => entry.value?.data ?? null);

const selfNick = computed(() => networks.states[props.networkId]?.nick ?? null);
const isSelf = computed(
  () => !!selfNick.value && selfNick.value.toLowerCase() === props.nick.toLowerCase(),
);

const peer = computed(() => networks.peerFor(props.networkId, props.nick));
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
  const out: Chip[] = [];
  const w = whois.value;
  if (w) {
    if (w.secure) out.push({ label: 'TLS', tone: 'good', icon: 'fa-solid fa-lock' });
    if (w.bot) out.push({ label: 'Bot', tone: 'neutral', icon: 'fa-solid fa-robot' });
    if (w.operator)
      out.push({ label: 'IRC operator', tone: 'warn', icon: 'fa-solid fa-shield-halved' });
    if (w.helpop) out.push({ label: 'Help', tone: 'neutral', icon: 'fa-solid fa-circle-info' });
    if (w.registered_nick)
      out.push({ label: 'Registered', tone: 'good', icon: 'fa-solid fa-id-badge' });
  }
  // Relay-bot mark is local user state, not a whois fact, so it shows even when
  // no whois reply is in (e.g. opening the profile of an offline bot).
  if (isRelay.value)
    out.push({ label: 'Relay bot', tone: 'neutral', icon: 'fa-solid fa-satellite-dish' });
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

// Any detail row present → render the table. Covers every row (identity +
// activity, including actual host) so the headerless table shows whenever we
// have anything at all to display.
const hasDetails = computed(
  () =>
    !!(
      whois.value &&
      (whois.value.real_name ||
        hostmask.value ||
        actualHost.value ||
        whois.value.account ||
        whois.value.server ||
        idleLabel.value ||
        signonLabel.value ||
        channelsList.value.length)
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

function onAddFriend() {
  // Opens the Configure Friend modal on top of the profile (same as the note
  // editor) — a sub-edit, so we don't close the viewer here.
  friends.openEditorForNick(props.networkId, props.nick);
}

function onToggleRelay() {
  // Mark/unmark this nick as a relay bot (#277). Marking from here uses the
  // built-in envelope formats; a custom pattern is a power-user concern handled
  // by `/relay add <nick> <pattern>`. The store echoes back over WS so the chip
  // and the re-attributed messages update across every open tab.
  if (isSelf.value) return;
  relayBots.setRelay(props.networkId, props.nick, !isRelay.value);
}

// Secondary/contextual actions collapse into a "More" overflow menu so the
// footer stays a clean primary-action row no matter how many actions exist.
// Reuses the shared context-menu primitive (z-menu sits above z-modal, so it
// floats over the modal correctly). Built fresh on open so toggle labels and
// presence-gated entries reflect current state.
function openMoreMenu(e: MouseEvent) {
  const items: ContextMenuItem[] = [];
  if (!isOffline.value && !isSelf.value) {
    items.push({ label: 'Ignore…', icon: 'fa-solid fa-ban', onClick: onIgnore });
  }
  if (!isSelf.value) {
    items.push({
      label: isRelay.value ? 'Unmark relay bot' : 'Mark relay bot',
      icon: 'fa-solid fa-satellite-dish',
      onClick: onToggleRelay,
    });
  }
  items.push({ label: 'Refresh', icon: 'fa-solid fa-arrows-rotate', onClick: onRefresh });
  const btn = e.currentTarget as Element | null;
  if (btn) {
    const rect = btn.getBoundingClientRect();
    contextMenu.open(items, rect.left, rect.bottom + 2, btn);
  } else {
    contextMenu.open(items, e.clientX, e.clientY);
  }
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
  // Best-effort: writeText returns a rejected promise when permissions are
  // denied (and the clipboard API itself can be missing on older browsers),
  // so swallow both paths quietly — copy isn't load-bearing.
  navigator.clipboard?.writeText(text).catch(() => {});
}
</script>

<style scoped>
.body {
  display: flex;
  flex-direction: column;
  gap: var(--space-8);
  overflow-y: auto;
  flex: 1;
  min-height: 0;
  /* Break out of card padding so the scrollbar sits against the card
     border; padding keeps section content visually aligned. The bottom padding
     gives the note area breathing room above the footer divider. */
  margin: 0 calc(-1 * var(--card-pad-x));
  padding: 0 var(--card-pad-x) var(--space-7);
}

/* Presence dot sits just left of the nick in the title. The class is applied to
   the dot itself now (no wrapping .presence label), so colour keys off it. */
.dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--fg-muted);
  margin-right: var(--space-3);
  vertical-align: middle;
}
.dot.online {
  background: var(--good);
}
.dot.away {
  background: var(--warn);
}
.dot.offline {
  background: var(--bad);
}
.dot.unknown {
  background: var(--fg-muted);
}
/* Away message beside the nick, matching the input-bar prompt: warn-coloured and
   exempt from the title's lowercase transform so the message reads verbatim. */
.away {
  color: var(--warn);
  text-transform: none;
}

/* Divider above the note section, mirroring the head's rule on the opposite
   edge. Only applied when there's a details section above it to separate from. */
.note-section.divided {
  border-top: 1px solid var(--border);
  padding-top: var(--space-7);
}

dl {
  display: grid;
  grid-template-columns: max-content 1fr;
  column-gap: var(--space-7);
  row-gap: var(--space-3);
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
  gap: var(--space-3);
  margin-top: var(--space-5);
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  border: 1px solid var(--border);
  padding: var(--space-1) var(--space-4);
  border-radius: var(--radius-pill);
  color: var(--fg);
}
.chip.good {
  border-color: var(--good);
  color: var(--good);
}
.chip.warn {
  border-color: var(--warn);
  color: var(--warn);
}

.channels {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-5);
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
.meta {
  margin: 0;
  color: var(--fg-muted);
  display: flex;
  gap: var(--space-6);
  align-items: baseline;
}
/* Only space the meta line off the note body when a note is present; with no
   note the Add-note button sits on its own with no superfluous top gap. */
.note-body + .meta {
  margin-top: var(--space-4);
}

.link.inline {
  background: none;
  border: none;
  color: var(--accent);
  cursor: pointer;
  font: inherit;
  padding: 0 var(--space-2);
}
.link.inline:hover {
  text-decoration: underline;
}

.status {
  padding: var(--space-6) 0;
}
</style>
