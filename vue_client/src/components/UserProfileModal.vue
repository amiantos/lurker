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
        <!-- IRCv3 metadata (#607): the avatar the user set, served through the
             media proxy (never the origin), beside what they said about themselves. -->
        <img v-if="meta?.avatarUrl" class="avatar" :src="meta.avatarUrl" alt="" />
        <dl>
          <template v-if="meta?.displayName">
            <dt>Display name</dt>
            <dd><RenderSegments :segments="displayNameSegments" /></dd>
          </template>
          <template v-if="whois?.real_name">
            <dt>Real name</dt>
            <dd>{{ whois.real_name }}</dd>
          </template>
          <template v-if="meta?.pronouns">
            <dt>Pronouns</dt>
            <dd>{{ meta.pronouns }}</dd>
          </template>
          <template v-if="meta?.status">
            <dt>Status</dt>
            <dd>{{ meta.status }}</dd>
          </template>
          <template v-if="meta?.homepage">
            <dt>Homepage</dt>
            <dd>
              <a class="msg-link" :href="meta.homepage" target="_blank" rel="noreferrer noopener">{{
                meta.homepage
              }}</a>
            </dd>
          </template>
          <template v-if="hostmask">
            <dt>Hostmask</dt>
            <dd>
              <code>{{ hostmask }}</code>
              <button type="button" class="link inline" title="Copy hostmask" @click="copyHostmask">
                <CopyIcon />
              </button>
            </dd>
          </template>
          <template v-if="actualHost">
            <dt>Connected from</dt>
            <dd>
              <code>{{ actualHost }}</code>
            </dd>
          </template>
          <template v-if="account">
            <dt>Account</dt>
            <dd>{{ account }}</dd>
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
                <span class="ch-prefix">{{ ch.prefix }}</span>{{ ch.name }}
              </button>
            </dd>
          </template>
        </dl>
        <div v-if="chips.length" class="chips">
          <span v-for="c in chips" :key="c.label" :class="['chip', c.tone]">
            <component :is="c.icon" v-if="c.icon" /> {{ c.label }}
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
              <component :is="noteText ? PenIcon : PlusIcon" />
              {{ noteText ? 'Edit' : 'Add note' }}
            </button>
          </p>
        </div>
      </section>

      <!-- One status line, chosen in `statusLine` — see the note there for why
           the miss has to be said out loud rather than left to the header
           dot (#818). -->
      <section v-if="statusLine === 'not-found'" class="section status">
        <p class="muted"><CircleQuestionMarkIcon /> {{ nick }} isn't on this network.</p>
      </section>
      <section v-else-if="statusLine === 'waiting'" class="section status">
        <p class="muted"><LoaderCircleIcon class="icon-spin" /> Waiting for whois reply…</p>
      </section>
    </div>

    <footer class="modal-footer">
      <!-- Primary actions only. Send DM is meaningless on yourself and while the
           peer is offline (a DM would bounce), so it's hidden then. Everything
           else (Ignore, relay-bot toggle, Refresh) lives in the More menu so the
           footer never crowds or wraps. -->
      <button
        v-if="!isOffline && !isSelf"
        type="button"
        class="btn-secondary"
        title="Send DM"
        @click="onSendDm"
      >
        <MailIcon /> <span class="label">Send DM</span>
      </button>
      <!-- Yourself: your own metadata on this network (#1189). -->
      <button
        v-if="isSelf"
        type="button"
        class="btn-secondary"
        title="Edit your profile"
        :disabled="!profileEditor.canOpen(networkId)"
        @click="profileEditor.open(networkId)"
      >
        <UserPenIcon /> <span class="label">Edit profile</span>
      </button>
      <span class="spacer"></span>
      <button type="button" class="btn-secondary" title="More actions" @click="openMoreMenu">
        <EllipsisIcon /> <span class="label">More</span>
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
import { useContextMenu, type ContextMenuItem } from '../composables/useContextMenu.js';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { socketSend } from '../composables/useSocket.js';
import { formatDateTime } from '../utils/timestamp.js';
import { splitChannelToken } from '../utils/memberPrefix.js';
import { formattingSegments } from '../utils/nickColor.js';
import RenderSegments from './RenderSegments.vue';
import { isPeerAway, isPeerOffline, isPeerOnline } from '../utils/peerPresence.js';
import {
  BadgeCheckIcon,
  BanIcon,
  BotIcon,
  CircleQuestionMarkIcon,
  CopyIcon,
  EllipsisIcon,
  InfoIcon,
  LoaderCircleIcon,
  LockIcon,
  MailIcon,
  PenIcon,
  PlusIcon,
  RefreshCwIcon,
  SatelliteDishIcon,
  ShieldHalfIcon,
  UserPenIcon,
} from '@lucide/vue';
import type { LucideIcon } from '@lucide/vue';
import { dccActionItems } from '../composables/dccActionItems.js';
import { useProfileEditor } from '../composables/useProfileEditor.js';

const props = defineProps<{
  nick: string;
  networkId: number;
}>();

const whoisStore = useWhoisStore();
const nickNotes = useNickNotesStore();
const relayBots = useRelayBotsStore();
const contextMenu = useContextMenu();
const networks = useNetworksStore();
const profileEditor = useProfileEditor();
const buffers = useBuffersStore();
const ignoreOpen = ref(false);

const isRelay = computed(() => relayBots.isRelay(props.networkId, props.nick));

const entry = computed(() => whoisStore.entryFor(props.networkId, props.nick));
const whois = computed(() => entry.value?.data ?? null);

// IRCv3 metadata (#607), live from the networks store: a WHOIS's 760 lines
// land there too, so this is current whether or not the reply has come.
const meta = computed(() => networks.metadataFor(props.networkId, props.nick));
const displayNameSegments = computed(() => formattingSegments(meta.value?.displayName ?? ''));

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

// Prefer the WHOIS reply, fall back to what extended-join / account-notify
// taught the nicklist (#508) — same precedence as awayMessage above, and for
// the same reason: WHOIS is the richer, freshly-requested source, but it only
// exists once the round-trip lands. The fallback means the row is populated the
// instant the modal opens for anyone who joined while we were watching, and
// account-notify keeps it honest afterwards.
const account = computed(() => {
  const fromWhois = (whois.value?.account as string) || '';
  if (fromWhois) return fromWhois;
  return buffers.knownAccountFor(props.networkId, props.nick) || '';
});

const presenceClass = computed(() => {
  if (isPeerOffline(peer.value)) return 'offline';
  if (isPeerAway(peer.value) || awayMessage.value) return 'away';
  if (isPeerOnline(peer.value)) return 'online';
  // No presence data — the whois reply settles it either way: an identity
  // means they're online, and a not-found means there's nobody there to be
  // anything else. Without the second branch a missing nick showed "Unknown",
  // which is the one thing we do know it isn't (#818).
  if (isNotFound.value) return 'offline';
  if (whois.value) return 'online';
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
  icon?: LucideIcon;
}
const chips = computed<Chip[]>(() => {
  const out: Chip[] = [];
  const w = whois.value;
  if (w) {
    if (w.secure) out.push({ label: 'TLS', tone: 'good', icon: LockIcon });
    if (w.bot) out.push({ label: 'Bot', tone: 'neutral', icon: BotIcon });
    if (w.operator) out.push({ label: 'IRC operator', tone: 'warn', icon: ShieldHalfIcon });
    if (w.helpop) out.push({ label: 'Help', tone: 'neutral', icon: InfoIcon });
    if (w.registered_nick) out.push({ label: 'Registered', tone: 'good', icon: BadgeCheckIcon });
  }
  // Relay-bot mark is local user state, not a whois fact, so it shows even when
  // no whois reply is in (e.g. opening the profile of an offline bot).
  if (isRelay.value) out.push({ label: 'Relay bot', tone: 'neutral', icon: SatelliteDishIcon });
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
// and peel the network's rank symbols off so the name itself is clean for
// join/switch (#1032).
const channelsList = computed(() => {
  const raw = (whois.value?.channels as string) || '';
  if (!raw) return [] as { prefix: string; name: string }[];
  const prefix = networks.prefixFor(props.networkId);
  return raw
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => splitChannelToken(token, prefix));
});

const isLookingUp = computed(() => whoisStore.isRefreshing(props.networkId, props.nick));

// What the body says when it has something to say about the lookup itself.
//
// 'not-found' is the fix for #818: a whois that answers "nobody there" used to
// render a name, a note prompt and nothing else, which is indistinguishable
// from a profile we simply have no details for. The header dot can't carry it
// either — with no MONITOR data a not-found nick read as "Unknown", the one
// status we can rule out.
//
// But only once the claim is current. A cached miss goes stale the instant a
// refresh goes out (they may have connected since), so an in-flight lookup
// demotes it back to 'waiting' rather than asserting they aren't there.
//
// 'waiting' otherwise covers being genuinely in the dark. If MONITOR already
// knows they're offline the presence dot carries that, so we skip the
// redundant line and let "Your note" stand on its own.
//
// ⚠ That last test reads isPeerOffline, NOT isOffline. isOffline folds a
// not-found whois in with MONITOR's verdict, which is right for hiding Send DM
// (a DM bounces either way) and wrong here: it would send a miss we're
// re-checking down the quiet path and blank the modal — the very bug #818 is
// about. The two questions only look like one.
const statusLine = computed<'not-found' | 'waiting' | null>(() => {
  if (isNotFound.value && !isLookingUp.value) return 'not-found';
  if (hasDetails.value) return null;
  if (isNotFound.value) return 'waiting';
  return isPeerOffline(peer.value) ? null : 'waiting';
});

// Any detail row present → render the table. Covers every row (identity +
// activity, including actual host) so the headerless table shows whenever we
// have anything at all to display.
const hasDetails = computed(
  () =>
    !!(
      meta.value &&
      (meta.value.displayName ||
        meta.value.avatarUrl ||
        meta.value.pronouns ||
        meta.value.status ||
        meta.value.homepage)
    ) ||
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
  buffers.openDm(props.networkId, props.nick);
  whoisStore.closeViewer();
}

function onIgnore() {
  if (isSelf.value) return;
  ignoreOpen.value = true;
}

function openNoteEditor() {
  nickNotes.openEditor(props.networkId, props.nick);
}

function onSetRelay(mark: boolean) {
  // Mark/unmark this nick as a relay bot (#277). Marking from here uses the
  // built-in envelope formats; a custom pattern is a power-user concern handled
  // by `/relay add <nick> <pattern>`. The store echoes back over WS so the chip
  // and the re-attributed messages update across every open tab.
  if (isSelf.value) return;
  relayBots.setRelay(props.networkId, props.nick, mark);
}

// Secondary/contextual actions collapse into a "More" overflow menu so the
// footer stays a clean primary-action row no matter how many actions exist.
// Reuses the shared context-menu primitive (z-menu sits above z-modal, so it
// floats over the modal correctly). Built fresh on open so toggle labels and
// presence-gated entries reflect current state.
function openMoreMenu(e: MouseEvent) {
  const items: ContextMenuItem[] = [];
  if (!isOffline.value && !isSelf.value) {
    items.push({ label: 'Ignore…', icon: BanIcon, onClick: onIgnore });
  }
  // The DCC section, as on the nick menu (#1085, #1157); the entries after it
  // are their own group.
  if (!isOffline.value && !isSelf.value) {
    const section = dccActionItems(props.networkId, props.nick, {
      before: () => whoisStore.closeViewer(),
    });
    if (section.length) items.push(...section, { divider: true });
  }
  if (!isSelf.value) {
    // What it says is what it does, however long the menu stays open (#1136).
    const marked = isRelay.value;
    items.push({
      label: marked ? 'Unmark relay bot' : 'Mark relay bot',
      icon: SatelliteDishIcon,
      onClick: () => onSetRelay(!marked),
    });
  }
  items.push({ label: 'Refresh', icon: RefreshCwIcon, onClick: onRefresh });
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

/* The metadata avatar (#607): a square at the top right of the details, the
   rows flowing beside it. Sized in em so it follows the one font size. */
.avatar {
  float: right;
  width: 4em;
  height: 4em;
  object-fit: cover;
  border-radius: var(--radius-md);
  margin: 0 0 var(--space-3) var(--space-5);
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
