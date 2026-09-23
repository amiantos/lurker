<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<!--
  A channel's topic, modes and lists (#727). Everything is drawn from the
  network's modeSpec, so a network's own modes all show up, named where the
  letter means the same thing everywhere and as `+X` where it doesn't.

  Everyone can open it and read it. Editing modes and lists takes op or
  higher, the topic halfop or higher under +t (anyone without it), ranked by
  the network's own PREFIX. The server has the last word: a refusal shows here.
-->

<template>
  <AppModal :word="target" :title="target" size="lg" fill-height @close="$emit('close')">
    <template v-if="createdLabel" #subtitle>{{ createdLabel }}</template>
    <div class="tabs" role="tablist" aria-label="Channel settings">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        type="button"
        role="tab"
        :aria-selected="tab.id === activeTab"
        :class="{ active: tab.id === activeTab }"
        @click="activeTab = tab.id"
      >
        {{ tab.label }}
      </button>
    </div>

    <form v-if="activeTab === 'settings'" class="modal-form" @submit.prevent="save">
      <div class="body">
        <section class="field">
          <span class="label-text">Topic</span>
          <textarea
            v-if="canSetTopic"
            :value="topicShown"
            rows="3"
            spellcheck="true"
            @input="onTopicInput"
          ></textarea>
          <p v-else-if="topic" class="topic-text"><LinkedText :text="topic" /></p>
          <!-- Out of the channel we don't know it has no topic — or that it
               exists at all; only what we last saw. -->
          <p v-else-if="!joined" class="muted">Join the channel to see its topic.</p>
          <p v-else class="muted">No topic set.</p>
          <p v-if="topicMeta || topicCounter" class="meta">
            <span>{{ topicMeta }}</span>
            <span v-if="topicCounter" :class="{ over: topicOver }">{{ topicCounter }}</span>
          </p>
        </section>

        <hr class="divider" />
        <section class="field">
          <span class="label-text">Modes</span>
          <p v-if="!spec" class="muted">Modes show once the network is connected.</p>
          <p v-else-if="!joined" class="muted">Join the channel to see its modes.</p>
          <template v-else>
            <p v-if="!canEditModes" class="muted">Only channel operators can change modes.</p>
            <p v-if="!canEditModes && !visibleRows.length" class="muted">No modes set.</p>
            <ul v-if="namedRows.length" class="modes">
              <li v-for="row in namedRows" :key="row.letter" class="mode-row">
                <ChannelModeRow v-bind="rowBinding(row)" />
              </li>
            </ul>
            <!-- Letters with no name we can vouch for, folded away so twenty of
                 them don't bury the ones that mean something. The summary says
                 which are set, so folding hides nothing. -->
            <details v-if="otherRows.length" class="other" :open="!canEditModes">
              <summary>
                Other modes
                <span v-if="otherSetLetters" class="tag">+{{ otherSetLetters }}</span>
              </summary>
              <ul v-if="otherParams.length" class="modes">
                <li v-for="row in otherParams" :key="row.letter" class="mode-row">
                  <ChannelModeRow v-bind="rowBinding(row)" />
                </li>
              </ul>
              <ul v-if="otherFlags.length" class="modes bare">
                <li v-for="row in otherFlags" :key="row.letter">
                  <label class="toggle">
                    <input
                      type="checkbox"
                      :checked="shown(row.letter).on"
                      :disabled="!canEditModes"
                      @change="setOn(row.letter, ($event.target as HTMLInputElement).checked)"
                    />
                    <span>+{{ row.letter }}</span>
                  </label>
                </li>
              </ul>
            </details>
          </template>
        </section>

        <p v-if="saveError" class="error">{{ saveError }}</p>
        <p v-for="err in serverErrors" :key="err" class="error">{{ err }}</p>
      </div>
      <footer class="modal-footer">
        <button type="button" class="btn-secondary" @click="$emit('close')">Close</button>
        <button
          v-if="canSetTopic || canEditModes"
          type="submit"
          class="btn-primary"
          :disabled="!dirty || saving"
        >
          Save
        </button>
      </footer>
    </form>

    <div v-else class="list-pane">
      <div class="body">
        <form v-if="canEditModes" class="add" @submit.prevent="addEntry">
          <input
            :value="newMask"
            type="text"
            placeholder="nick!user@host"
            :aria-label="`Add to ${activeList?.label}`"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            @input="onMaskInput"
            @keydown.enter="blockImeEnter"
          />
          <button type="submit" class="btn-secondary" :disabled="!newMask.trim() || listBusy">
            Add
          </button>
        </form>
        <p v-if="listActionError" class="error">{{ listActionError }}</p>
        <p v-for="err in serverErrors" :key="err" class="error">{{ err }}</p>
        <p v-if="listState.status === 'loading'" class="muted">Loading…</p>
        <p v-else-if="listState.status === 'error'" class="error">{{ listState.error }}</p>
        <p v-else-if="listState.status === 'ready' && !entries.length" class="muted">
          Nothing here.
        </p>
        <ul v-if="listState.status === 'ready' && entries.length" class="entries">
          <li v-for="entry in entries" :key="entry.mask" class="entry">
            <div class="entry-text">
              <code class="mask">{{ entry.mask }}</code>
              <span v-if="entryMeta(entry)" class="muted">{{ entryMeta(entry) }}</span>
            </div>
            <button
              v-if="canEditModes"
              type="button"
              class="link remove"
              :title="`Remove ${entry.mask}`"
              :aria-label="`Remove ${entry.mask}`"
              @click="removeEntry(entry.mask)"
            >
              <i class="fa-solid fa-xmark"></i>
            </button>
          </li>
        </ul>
      </div>
      <footer class="modal-footer">
        <span class="spacer"></span>
        <button
          type="button"
          class="btn-secondary"
          :disabled="listState.status === 'loading'"
          @click="loadList(activeTab)"
        >
          Refresh
        </button>
        <button type="button" class="btn-secondary" @click="$emit('close')">Close</button>
      </footer>
    </div>
  </AppModal>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';
import AppModal from './AppModal.vue';
import LinkedText from './LinkedText.vue';
import ChannelModeRow from './ChannelModeRow.vue';
import { useBuffersStore } from '../stores/buffers.js';
import { useNetworksStore } from '../stores/networks.js';
import { onIrcEvent, onSocketOpen, socketSendWithAck } from '../composables/useSocket.js';
import { blockImeEnter } from '../composables/useImeSafeInput.js';
import { formatDate, formatDateTime } from '../utils/timestamp.js';
import {
  LIST_NAMES,
  liveRow,
  modeChanges,
  modeRows,
  topicBytes,
  type DraftRow,
  type LiveModes,
  type ModeRow,
} from '../utils/channelModeForm.js';
import { patchModeList, type ListEntry, type ModeRowLike } from '../utils/modeListPatch.js';
import { DEFAULT_PREFIX, hasRankAtLeast } from '../../../shared/channelModes.js';
import type { OutgoingModeChange } from '../../../shared/channelModes.js';

const props = defineProps<{ networkId: number; target: string }>();
defineEmits<{ close: [] }>();

const buffers = useBuffersStore();
const networks = useNetworksStore();

// The server's reply timeout is 30 s; the ACK has to outlast it or a slow list
// reads as a timeout while the server is still waiting.
const LIST_ACK_TIMEOUT_MS = 35_000;

const buffer = computed(() => buffers.findByTarget(props.networkId, props.target));
const spec = computed(() => networks.states[props.networkId]?.modeSpec ?? null);

// This channel's live `mode` and `error` rows since the modal opened. Taken
// straight off the socket rather than from buffer.messages: a detached buffer
// (the user jumped back in history) drops live rows, and the modal still needs
// them — to patch an open list and to show what a Save was refused with.
const modeRowsSeen = ref<ModeRowLike[]>([]);
const errorsSeen = ref<{ text: string; at: number }[]>([]);
const stopListening = onIrcEvent((event) => {
  if (event.networkId !== props.networkId) return;
  if (String(event.target ?? '').toLowerCase() !== props.target.toLowerCase()) return;
  if (event.type === 'mode') modeRowsSeen.value.push(event as ModeRowLike);
  else if (event.type === 'error') {
    errorsSeen.value.push({ text: String(event.text ?? ''), at: Date.now() });
  }
});
onBeforeUnmount(stopListening);

// ─── Who may do what ────────────────────────────────────────────────────────

const selfModes = computed<string[]>(() => {
  const nick = networks.states[props.networkId]?.nick?.toLowerCase();
  const me = nick ? buffer.value?.members.find((m) => m.nick.toLowerCase() === nick) : undefined;
  return me?.modes ?? [];
});
const prefix = computed(() => spec.value?.prefix ?? DEFAULT_PREFIX);
// Editing needs us in the channel: a parted one's modes are last-known, and a
// TOPIC or MODE from outside it only draws a 442.
// No buffer at all (closed from another device) is out of the channel too.
const joined = computed(() => !!buffer.value && buffer.value.joined !== false);
const canEditModes = computed(
  () => joined.value && hasRankAtLeast(selfModes.value, prefix.value, 'o'),
);
const canSetTopic = computed(
  () =>
    joined.value &&
    (!(buffer.value?.modes ?? '').includes('t') ||
      hasRankAtLeast(selfModes.value, prefix.value, 'h')),
);

// ─── Tabs ───────────────────────────────────────────────────────────────────

const tabs = computed(() => [
  { id: 'settings', label: 'Settings' },
  ...Object.keys(LIST_NAMES)
    .filter((letter) => spec.value?.list.includes(letter))
    .map((letter) => ({ id: letter, label: LIST_NAMES[letter] })),
]);
const activeTab = ref('settings');
const activeList = computed(() => tabs.value.find((t) => t.id === activeTab.value));

// ─── Topic ──────────────────────────────────────────────────────────────────

const topic = computed(() => buffer.value?.topic ?? '');
// Null until the user types: the field shows the live topic until then.
const topicDraft = ref<string | null>(null);
const topicShown = computed(() => topicDraft.value ?? topic.value);
function onTopicInput(event: Event) {
  topicDraft.value = (event.target as HTMLTextAreaElement).value;
}
// A topic is one line on the wire; a pasted newline becomes a space. The byte
// count is of what goes out.
const topicToSend = computed(() => topicShown.value.replace(/[\r\n]+/g, ' '));
const topicChanged = computed(() => topicDraft.value !== null && topicToSend.value !== topic.value);
const topicLen = computed(() => spec.value?.topicLen ?? null);
const topicSize = computed(() => topicBytes(topicToSend.value));
const topicOver = computed(() => topicLen.value != null && topicSize.value > topicLen.value);
const topicCounter = computed(() =>
  canSetTopic.value && topicLen.value != null ? `${topicSize.value} / ${topicLen.value}` : '',
);
const topicMeta = computed(() => {
  const by = buffer.value?.topicSetBy;
  const at = buffer.value?.topicSetAt;
  if (!topic.value || (!by && !at)) return '';
  return [by ? `Set by ${by}` : 'Set', at ? formatDateTime(at) : ''].filter(Boolean).join(' · ');
});
const createdLabel = computed(() =>
  buffer.value?.createdAt ? `Created ${formatDate(buffer.value.createdAt)}` : '',
);

// ─── Modes ──────────────────────────────────────────────────────────────────

const rows = computed(() => (spec.value ? modeRows(spec.value) : []));
// Someone who can't change modes sees only the ones that are set.
const visibleRows = computed(() =>
  canEditModes.value ? rows.value : rows.value.filter((r) => shown(r.letter).on),
);
const namedRows = computed(() => visibleRows.value.filter((r) => r.name));
const otherRows = computed(() => visibleRows.value.filter((r) => !r.name));
const otherParams = computed(() => otherRows.value.filter((r) => r.kind !== 'flag'));
const otherFlags = computed(() => otherRows.value.filter((r) => r.kind === 'flag'));
// Shown on the folded summary, so a set mode is never out of sight.
const otherSetLetters = computed(() =>
  otherRows.value
    .filter((r) => shown(r.letter).on)
    .map((r) => r.letter)
    .join(''),
);
// The channel's key, which the server never puts in channel state: the newest
// ±k we've seen — a `+k <key>` names it, a `-k` means there's none (so a key the
// config still remembers doesn't come back) — else the one we joined with from
// the network config. `*` is a mask, not a key. Undefined: no ±k seen.
function lastKeyChange(seenRows: readonly ModeRowLike[]): string | null | undefined {
  for (let i = seenRows.length - 1; i >= 0; i--) {
    const changes = seenRows[i].modes ?? [];
    for (let j = changes.length - 1; j >= 0; j--) {
      const change = changes[j];
      if (change.mode === '-k') return null;
      if (change.mode === '+k' && change.param && change.param !== '*') return change.param;
    }
  }
  return undefined;
}
// The config copy is the key the server holds (buffers.key, kept current by
// every live ±k) — as of when it was fetched. Fetched afresh on open for a keyed
// channel, since the page's copy dates from load; live rows cover the rest.
const configKey = computed(() => {
  const network = networks.networks.find((n) => n.id === props.networkId);
  const channels = (network?.channels ?? []) as { name: string; key?: string | null }[];
  return channels.find((c) => c.name.toLowerCase() === props.target.toLowerCase())?.key ?? null;
});
const storedKey = computed(() => {
  const fromLive = lastKeyChange(modeRowsSeen.value);
  return fromLive !== undefined ? fromLive : configKey.value;
});
if ((buffer.value?.modes ?? '').includes('k')) void networks.fetchAll().catch(() => {});
const keyRevealed = ref(false);
const live = computed<LiveModes>(() => {
  const modes = buffer.value?.modes ?? '';
  return {
    modes,
    params: {
      ...buffer.value?.modeParams,
      // Only while the channel has a key: ticking +k back on must start empty,
      // not quietly re-send an old one.
      ...(storedKey.value && modes.includes('k') ? { k: storedKey.value } : {}),
    },
  };
});
// Only the rows the user touched; everything else reads live (channelModeForm.ts).
const draft = reactive<Record<string, DraftRow>>({});
function shown(letter: string): DraftRow {
  return draft[letter] ?? liveRow(live.value, letter);
}
function setOn(letter: string, on: boolean) {
  draft[letter] = { on, value: shown(letter).value };
}
function setValue(letter: string, value: string) {
  draft[letter] = { on: shown(letter).on, value };
}

// Props and handlers for a ChannelModeRow, the same wherever the row is drawn.
function rowBinding(row: ModeRow) {
  return {
    row,
    state: shown(row.letter),
    disabled: !canEditModes.value,
    revealed: keyRevealed.value,
    canReveal: !!storedKey.value && live.value.modes.includes('k'),
    onToggle: (on: boolean) => setOn(row.letter, on),
    onValue: (value: string) => setValue(row.letter, value),
    onReveal: () => (keyRevealed.value = !keyRevealed.value),
  };
}

const pending = computed(() =>
  spec.value ? modeChanges(spec.value, live.value, draft) : { changes: [] },
);

// An edit stays until the channel answers it. Never cleared on Save: the ACK
// only means the line went out. It goes when the live state matches it, or —
// for a row that was saved — when that row's live state moves at all, since a
// server may echo a value normalized (`+l 050` comes back as 50). A refusal
// (482 …) moves nothing, so the edit stands beside the error.
const savedFrom = new Map<string, string>();
const rowKey = (row: DraftRow) => `${row.on}:${row.value}`;
watch(live, (now) => {
  for (const [letter, want] of Object.entries(draft)) {
    const was = liveRow(now, letter);
    const matches = want.on === was.on && (!want.on || want.value.trim() === was.value);
    const moved = savedFrom.has(letter) && savedFrom.get(letter) !== rowKey(was);
    if (matches || moved) {
      delete draft[letter];
      savedFrom.delete(letter);
    }
  }
});
let topicSavedFrom: string | null = null;
watch(topic, (now) => {
  if (topicDraft.value === null) return;
  if (topicToSend.value === now || (topicSavedFrom !== null && now !== topicSavedFrom)) {
    topicDraft.value = null;
    topicSavedFrom = null;
  }
});
const dirty = computed(
  () => topicChanged.value || 'error' in pending.value || pending.value.changes.length > 0,
);

// ─── Save ───────────────────────────────────────────────────────────────────

const saving = ref(false);
const saveError = ref('');
// The channel's error rows (#434: 482, 467, 478 …) that arrive after a change
// goes out are its answer — MODE changes aren't correlated server-side (see
// modeList.ts). Armed by a Save and by a list add/remove alike.
// Only the rows that come soon after, on the tab that acted: a server answers a
// MODE in moments, and a 404 or a /kick's 441 minutes later is not this Save's.
const ERROR_WINDOW_MS = 10_000;
const armed = ref<{ from: number; at: number; tab: string } | null>(null);
const serverErrors = computed(() => {
  const a = armed.value;
  if (!a || a.tab !== activeTab.value) return [];
  return errorsSeen.value
    .slice(a.from)
    .filter((e) => e.at - a.at < ERROR_WINDOW_MS)
    .map((e) => e.text);
});
function armServerErrors() {
  armed.value = { from: errorsSeen.value.length, at: Date.now(), tab: activeTab.value };
}

async function save() {
  if (!dirty.value || saving.value) return;
  saveError.value = '';
  if ('error' in pending.value) {
    saveError.value = pending.value.error;
    return;
  }
  if (topicChanged.value && topicOver.value) {
    saveError.value = `The topic is over the network's ${topicLen.value}-byte limit.`;
    return;
  }
  // Both decided now, before any await: the fields stay editable while an ACK
  // is out, and what goes out is what the user saved.
  const topicToSave = topicChanged.value ? topicToSend.value : null;
  const changes = pending.value.changes;
  if (topicToSave !== null) topicSavedFrom = topic.value;
  for (const change of changes)
    savedFrom.set(change.letter, rowKey(liveRow(live.value, change.letter)));
  armServerErrors();
  saving.value = true;
  try {
    if (topicToSave !== null) {
      // Through the set_topic verb, not a raw line: a raw TOPIC to a network
      // that's down is dropped without a word.
      const result = await ack({
        type: 'set-topic',
        networkId: props.networkId,
        channel: props.target,
        topic: topicToSave,
      });
      if (result) {
        saveError.value = result;
        return;
      }
    }
    if (changes.length) {
      const result = await sendChanges(changes);
      if (result) saveError.value = result;
    }
  } finally {
    saving.value = false;
  }
}

// Send one acked message; resolves to an error message, or '' when it went out.
async function ack(payload: Record<string, unknown>): Promise<string> {
  const pendingAck = socketSendWithAck(payload);
  if (!pendingAck) return 'Not connected.';
  const result = await pendingAck;
  if (result.ok) return '';
  return result.error === 'not-connected' ? 'Not connected.' : `Couldn't save (${result.error}).`;
}

function sendChanges(changes: OutgoingModeChange[]): Promise<string> {
  return ack({
    type: 'set-channel-modes',
    networkId: props.networkId,
    channel: props.target,
    changes,
  });
}

// ─── Lists ──────────────────────────────────────────────────────────────────

interface ListState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  entries: ListEntry[];
  error: string;
  // Mode rows seen from here on patch the fetched list (modeListPatch.ts).
  fromRow: number;
}
const lists = reactive<Record<string, ListState>>({});
const listState = computed<ListState>(
  () => lists[activeTab.value] ?? { status: 'idle', entries: [], error: '', fromRow: 0 },
);
const entries = computed(() => {
  const state = listState.value;
  return patchModeList(state.entries, modeRowsSeen.value.slice(state.fromRow), activeTab.value);
});

function listError(data: { error?: string; numeric?: string; text?: string } | undefined) {
  if (data?.error === 'refused') {
    return data.numeric === '482'
      ? 'Only channel operators can see this list.'
      : `The server refused: ${data.text || data.numeric}`;
  }
  if (data?.error === 'not-connected') return 'Not connected.';
  return "The server didn't answer.";
}

// The latest load per letter. A plain counter, not the state object: `lists`
// is reactive, so what reads back out of it is a proxy, never === the object
// that went in.
const listLoads: Record<string, number> = {};
async function loadList(letter: string) {
  if (!LIST_NAMES[letter]) return;
  const load = (listLoads[letter] ?? 0) + 1;
  listLoads[letter] = load;
  const state: ListState = {
    status: 'loading',
    entries: [],
    error: '',
    fromRow: modeRowsSeen.value.length,
  };
  lists[letter] = state;
  const pendingAck = socketSendWithAck(
    { type: 'get-mode-list', networkId: props.networkId, channel: props.target, letter },
    { timeoutMs: LIST_ACK_TIMEOUT_MS },
  );
  const result = pendingAck ? await pendingAck : { ok: false, error: 'not-connected' };
  // A Refresh while this was out started a newer load; that one owns the tab.
  if (listLoads[letter] !== load) return;
  const data = (
    result as { data?: { entries?: ListEntry[]; error?: string; numeric?: string; text?: string } }
  ).data;
  if (result.ok && data?.entries) {
    lists[letter] = { ...state, status: 'ready', entries: data.entries };
  } else {
    lists[letter] = { ...state, status: 'error', error: listError(data ?? result) };
  }
}

// A reconnect's gap arrives as backlog, not as live rows, so a list fetched
// before the drop can't be patched up to date: fetch the open one again, and
// let the others reload when their tab next opens.
const stopReopen = onSocketOpen(() => {
  for (const letter of Object.keys(lists)) {
    if (letter === activeTab.value) void loadList(letter);
    else delete lists[letter];
  }
});
onBeforeUnmount(stopReopen);

watch(activeTab, (tab) => {
  if (tab !== 'settings' && !lists[tab]) void loadList(tab);
});

const newMask = ref('');
function onMaskInput(event: Event) {
  newMask.value = (event.target as HTMLInputElement).value;
}
// Per list, so an error lands on the tab whose action it answers.
const listActionErrors = reactive<Record<string, string>>({});
const listActionError = computed(() => listActionErrors[activeTab.value] ?? '');
// One change at a time: a double click must not send the ban twice.
const listBusy = ref(false);
// No refetch after a change: the MODE echo patches the list (modeListPatch.ts).
async function listChange(sign: '+' | '-', mask: string): Promise<boolean> {
  if (listBusy.value) return false;
  const letter = activeTab.value;
  listBusy.value = true;
  armServerErrors();
  try {
    listActionErrors[letter] = await sendChanges([{ sign, letter, param: mask }]);
    return !listActionErrors[letter];
  } finally {
    listBusy.value = false;
  }
}
async function addEntry() {
  const mask = newMask.value.trim();
  if (mask && (await listChange('+', mask))) newMask.value = '';
}
function removeEntry(mask: string) {
  void listChange('-', mask);
}

function entryMeta(entry: ListEntry): string {
  return [entry.setBy ? `by ${entry.setBy}` : '', entry.setAt ? formatDateTime(entry.setAt) : '']
    .filter(Boolean)
    .join(' · ');
}
</script>

<style scoped>
.tabs {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  padding-bottom: var(--space-4);
}
.tabs button {
  background: var(--bg-soft);
  color: var(--fg-muted);
  border: 1px solid var(--border);
  padding: var(--space-2) var(--space-4);
}
.tabs button.active {
  color: var(--fg);
  border-color: var(--accent);
  outline: 1px solid var(--accent);
}
.list-pane {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
.body {
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding-bottom: var(--space-7);
}
.field {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.label-text {
  color: var(--fg-muted);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
textarea {
  resize: vertical;
  background: var(--bg-soft);
  padding: var(--space-3) var(--space-4);
}
.topic-text {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.55;
}
.meta {
  display: flex;
  justify-content: space-between;
  gap: var(--space-4);
  margin: 0;
  color: var(--fg-muted);
}
.meta .over {
  color: var(--bad);
}
.meta span:last-child {
  white-space: nowrap;
}
.muted {
  margin: 0;
  color: var(--fg-muted);
}
.error {
  margin: 0;
  color: var(--bad);
}
.modes,
.entries {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.mode-row {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  min-height: 2em;
}
.toggle {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex: 1;
  min-width: 0;
  cursor: pointer;
}
.toggle input {
  accent-color: var(--accent);
}
.modes.bare {
  flex-direction: row;
  flex-wrap: wrap;
  gap: var(--space-3) var(--space-6);
}
.divider {
  height: 1px;
  width: 100%;
  border: 0;
  margin: 0;
  background: var(--border);
}
.other summary {
  cursor: pointer;
  color: var(--fg-muted);
  padding: var(--space-2) 0;
}
.other summary:hover {
  color: var(--fg);
}
.other[open] summary {
  margin-bottom: var(--space-3);
}
.tag {
  color: var(--fg-muted);
  margin-left: var(--space-3);
}
code {
  background: var(--bg-soft);
  padding: 0 var(--space-2);
  border-radius: var(--radius-sm);
}
.add {
  display: flex;
  gap: var(--space-3);
}
.add input {
  flex: 1;
  min-width: 0;
  background: var(--bg-soft);
  padding: var(--space-3) var(--space-4);
}
.entry {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-2) 0;
  border-bottom: 1px solid var(--border);
}
.entry-text {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  flex: 1;
  min-width: 0;
}
.mask {
  align-self: flex-start;
  word-break: break-all;
}
.link {
  background: none;
  border: none;
  color: var(--fg-muted);
  cursor: pointer;
  font: inherit;
  padding: 0 var(--space-2);
}
.link:hover {
  color: var(--accent);
}
</style>
