<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <section id="highlights" class="settings-pane">
    <h2>highlights</h2>
    <p class="section-desc">
      A highlight marks a message and its channel. A rule matches a word, a sender
      (<code>nick!user@host</code>, <code>*</code> for wildcards), or both, on every network or one.
      Also managed with <code>/highlight</code>.
    </p>

    <p v-if="formError && !formOpen" class="error inline">{{ formError }}</p>
    <p v-if="rulesError" class="error inline">{{ rulesError }}</p>

    <!-- The automatic rule for your nick on each network is not listed: it can't
         be edited, disabled or removed, so a row for it was three dead buttons
         per network. This line is what says it exists. -->
    <p class="muted small">Your nick on each network always highlights.</p>
    <p v-if="!highlightGroups.length" class="muted small">
      No highlights yet. Add one below, or type <code>/highlight &lt;word&gt;</code> in any buffer.
    </p>

    <template v-for="group in highlightGroups" :key="group.key">
      <h3 class="subhead sibling">{{ group.name }}</h3>
      <ul class="device-list">
        <li v-for="entry in group.entries" :key="entry.id" class="device">
          <span class="ua">
            {{ entry.mask ?? entry.pattern ?? '*' }}
            <span class="muted small hl-detail">{{ describe(entry) }}</span>
          </span>
          <span class="btn-bar">
            <IconButton
              :icon="entry.enabled ? ToggleRightIcon : ToggleLeftIcon"
              label="toggle highlight rule"
              :aria-pressed="entry.enabled"
              :title="entry.enabled ? 'enabled — click to disable' : 'disabled — click to enable'"
              @click="toggleEnabled(entry, !entry.enabled)"
            />
            <IconButton :icon="PenIcon" label="edit" @click="startEdit(entry)" />
            <IconButton :icon="TrashIcon" label="remove" danger @click="onRemove(entry)" />
          </span>
        </li>
      </ul>
    </template>

    <p class="add-row">
      <button class="btn-secondary" @click="startAdd">add highlight</button>
    </p>

    <FormModal
      v-if="formOpen"
      word="highlight"
      :title="editing ? 'edit highlight' : 'add highlight'"
      :submit-label="editing ? 'Save' : 'Add highlight'"
      :can-submit="canSubmit"
      :error="formError"
      @submit="submit"
      @close="closeForm"
    >
      <div class="rule-form">
        <!-- Scope -->
        <div class="field">
          <span class="field-label">Scope</span>
          <div class="row">
            <div class="seg" role="group" aria-label="Scope">
              <button
                type="button"
                :aria-pressed="scopeMode === 'global'"
                :class="{ active: scopeMode === 'global' }"
                @click="scopeMode = 'global'"
              >
                Global
              </button>
              <button
                type="button"
                :aria-pressed="scopeMode === 'network'"
                :class="{ active: scopeMode === 'network' }"
                :disabled="!networkOptions.length"
                @click="selectNetworkScope"
              >
                One network
              </button>
            </div>
            <select v-if="scopeMode === 'network'" v-model.number="scopeNetworkId">
              <option v-for="opt in networkOptions" :key="opt.id" :value="opt.id">
                {{ opt.name }}
              </option>
            </select>
          </div>
        </div>

        <!-- What (keyword) -->
        <div class="field">
          <span class="field-label"
            >Highlight word
            <span class="muted small">(what — blank to match by sender only)</span></span
          >
          <div class="row">
            <input
              :value="form.pattern"
              @input="onPatternInput"
              type="text"
              class="grow"
              placeholder="word or phrase to highlight"
              spellcheck="false"
            />
            <select v-model="form.kind">
              <option value="substr">contains</option>
              <option value="full">whole word</option>
              <option value="glob">glob</option>
              <option value="regex">regex</option>
            </select>
          </div>
          <label class="ck">
            <input v-model="form.caseSensitive" type="checkbox" />
            <span>Case-sensitive</span>
          </label>
        </div>

        <!-- Who (mask) -->
        <label class="field">
          <span class="field-label"
            >Sender mask <span class="muted small">(who — blank = anyone)</span></span
          >
          <input
            :value="form.mask"
            @input="onMaskInput"
            type="text"
            placeholder="nick or nick!user@host — highlights everything they say"
            spellcheck="false"
            autocapitalize="off"
            autocomplete="off"
          />
        </label>

        <!-- Where (channels) -->
        <label class="field">
          <span class="field-label"
            >Channels <span class="muted small">(where — blank = all buffers)</span></span
          >
          <input
            :value="form.channels"
            @input="onChannelsInput"
            type="text"
            placeholder="#chan #other (space-separated)"
            spellcheck="false"
            autocapitalize="off"
            autocomplete="off"
          />
        </label>

        <!-- Options -->
        <div class="field">
          <span class="field-label">Options</span>
          <label class="ck">
            <input v-model="form.enabled" type="checkbox" />
            <span>Enabled</span>
          </label>
        </div>
      </div>
    </FormModal>
  </section>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue';
import { useNetworksStore } from '../../stores/networks.js';
import { useHighlightRulesStore } from '../../stores/highlightRules.js';
import type { HighlightRule } from '../../stores/highlightRules.js';
import IconButton from '../IconButton.vue';
import FormModal from '../FormModal.vue';
import { parseChannelList } from '../../../../shared/channels.js';
import { highlightRuleDetailParts } from '../../utils/highlightFormat.js';
import { joinMeta } from '../../utils/metaLine.js';
import { imeSafeValue } from '../../composables/useImeSafeInput.js';
import { PenIcon, ToggleLeftIcon, ToggleRightIcon, TrashIcon } from '@lucide/vue';

type RuleKind = 'substr' | 'full' | 'glob' | 'regex';

// Mirrors MAX_PATTERN_LENGTH in server/services/highlightRulesService.ts.
const MAX_PATTERN_LENGTH = 256;

const networksStore = useNetworksStore();
const rulesStore = useHighlightRulesStore();

const rulesError = ref('');
onMounted(() => {
  if (!rulesStore.loaded) {
    rulesStore.fetchAll().catch((e: any) => {
      rulesError.value = e.message || 'failed to load rules';
    });
  }
});

interface HighlightGroup {
  key: string;
  name: string;
  entries: HighlightRule[];
}

// One-line summary of a rule's secondary dimensions for the list (the mask or
// pattern is the main label rendered separately). Shared with the /highlight
// command listing so the two never drift — including the separator, which is why
// both go through joinMeta rather than each picking a glyph.
function describe(entry: HighlightRule): string {
  return joinMeta(highlightRuleDetailParts(entry));
}

// Global group first (no network scope), then per-network groups sorted by name.
// Only the rules the user wrote: the auto-managed nick rules are left out (see
// the template). /highlight still lists them.
const highlightGroups = computed<HighlightGroup[]>(() => {
  const globals: HighlightRule[] = [];
  const byNet = new Map<number, HighlightRule[]>();
  for (const entry of rulesStore.userRules) {
    if (entry.networkIds.length === 0) {
      globals.push(entry);
    } else {
      for (const nid of entry.networkIds) {
        const list = byNet.get(nid);
        if (list) list.push(entry);
        else byNet.set(nid, [entry]);
      }
    }
  }
  const groups: HighlightGroup[] = [];
  if (globals.length)
    groups.push({ key: 'global', name: 'Global (all networks)', entries: globals });
  const netGroups: HighlightGroup[] = [];
  for (const [networkId, entries] of byNet) {
    netGroups.push({
      key: `net:${networkId}`,
      name: networksStore.networkById(networkId)?.name || `net:${networkId}`,
      entries,
    });
  }
  netGroups.sort((a, b) => a.name.localeCompare(b.name));
  return [...groups, ...netGroups];
});

const networkOptions = computed(() =>
  (networksStore.networks || [])
    .map((n) => ({ id: n.id, name: n.name }))
    .toSorted((a, b) => a.name.localeCompare(b.name)),
);

// ---- form state ----
const scopeMode = ref<'global' | 'network'>('global');
const scopeNetworkId = ref<number | null>(null);
const editing = ref<{ id: number } | null>(null);
const formError = ref('');

const form = reactive({
  mask: '',
  channels: '',
  pattern: '',
  kind: 'substr' as RuleKind,
  caseSensitive: false,
  enabled: true,
});

// `form` is a reactive object, not three refs, so these take the value off the
// element directly rather than through useImeSafeInput. Bound this way because
// canSubmit reads pattern/mask as you type, and because all three are written
// programmatically — cleared after a save, repopulated when you edit a rule.
function onPatternInput(e: Event) {
  form.pattern = imeSafeValue(e);
}
function onMaskInput(e: Event) {
  form.mask = imeSafeValue(e);
}
function onChannelsInput(e: Event) {
  form.channels = imeSafeValue(e);
}

const canSubmit = computed(() => {
  if (scopeMode.value === 'network' && !scopeNetworkId.value) return false;
  return !!form.pattern.trim() || !!form.mask.trim();
});

function selectNetworkScope() {
  if (!networkOptions.value.length) return;
  scopeMode.value = 'network';
  if (!scopeNetworkId.value) scopeNetworkId.value = networkOptions.value[0].id;
}

function parseChannels(s: string): string[] | null {
  const list = parseChannelList(s);
  return list.length ? list : null;
}

interface BuiltFields {
  pattern: string | null;
  mask: string | null;
  channels: string[] | null;
  kind: RuleKind;
  case_sensitive: boolean;
  enabled: boolean;
  networkId: number | null;
}

function buildFields(): BuiltFields | null {
  formError.value = '';
  const pattern = form.pattern.trim();
  let mask = form.mask.trim();
  if (mask === '*') mask = '';
  if (!pattern && !mask) {
    formError.value = 'enter a highlight word or a sender mask.';
    return null;
  }
  if (pattern.length > MAX_PATTERN_LENGTH) {
    formError.value = `highlight word is too long (max ${MAX_PATTERN_LENGTH} characters).`;
    return null;
  }
  if (pattern && form.kind === 'regex') {
    try {
      void new RegExp(pattern);
    } catch (e) {
      formError.value = `invalid regex: ${(e as Error).message}`;
      return null;
    }
  }
  return {
    pattern: pattern || null,
    mask: mask || null,
    channels: parseChannels(form.channels),
    kind: form.kind,
    case_sensitive: form.caseSensitive,
    enabled: form.enabled,
    networkId: scopeMode.value === 'network' ? scopeNetworkId.value : null,
  };
}

function resetForm() {
  form.mask = '';
  form.channels = '';
  form.pattern = '';
  form.kind = 'substr';
  form.caseSensitive = false;
  form.enabled = true;
  scopeMode.value = 'global';
  scopeNetworkId.value = null;
  editing.value = null;
}

/** The add/edit modal is open. */
const formOpen = ref(false);

function startAdd() {
  resetForm();
  formError.value = '';
  formOpen.value = true;
}

function closeForm() {
  formOpen.value = false;
  resetForm();
  formError.value = '';
}

function startEdit(entry: HighlightRule) {
  formOpen.value = true;
  editing.value = { id: entry.id };
  form.mask = entry.mask ?? '';
  form.channels = (entry.channels || []).join(' ');
  form.pattern = entry.pattern ?? '';
  form.kind = (entry.kind as RuleKind) || 'substr';
  form.caseSensitive = entry.case_sensitive;
  form.enabled = entry.enabled;
  // A user rule is global or scoped to exactly one network (only auto rules span
  // several, and those aren't editable).
  if (entry.networkIds.length) {
    scopeMode.value = 'network';
    scopeNetworkId.value = entry.networkIds[0];
  } else {
    scopeMode.value = 'global';
    scopeNetworkId.value = null;
  }
  formError.value = '';
}

// Add = create; edit = a single atomic update (the service re-scopes via the
// junction), so the rule keeps its id and list position and there's no
// create-then-delete window that could orphan a duplicate.
async function submit() {
  const fields = buildFields();
  if (!fields) return;
  try {
    if (editing.value) {
      await rulesStore.update(editing.value.id, fields);
    } else {
      await rulesStore.create(fields);
    }
    closeForm();
  } catch (e: any) {
    formError.value = e.message || 'failed to save highlight';
  }
}

async function toggleEnabled(entry: HighlightRule, value: boolean) {
  formError.value = '';
  try {
    await rulesStore.update(entry.id, { enabled: value });
  } catch (e: any) {
    formError.value = e.message || 'update failed';
    rulesStore.fetchAll().catch(() => {
      /* ignore */
    });
  }
}

async function onRemove(entry: HighlightRule) {
  if (editing.value?.id === entry.id) closeForm();
  formError.value = '';
  try {
    await rulesStore.remove(entry.id);
  } catch (e: any) {
    formError.value = e.message || 'delete failed';
  }
}
</script>

<style src="./panes.css"></style>
<style scoped>
.hl-detail {
  margin-left: var(--space-3);
}
.device .ua {
  min-width: 0;
  overflow-wrap: anywhere;
}
/* Enabled toggle: muted when off, accent when on; the glyph (toggle-on/off)
   plus aria-pressed carry the state. */
.rule-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-7);
}
.field {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.field-label {
  color: var(--fg-muted);
}
.row {
  display: flex;
  align-items: center;
  gap: var(--space-4);
}
.grow {
  flex: 1;
  min-width: 0;
}
.seg {
  display: flex;
  gap: var(--space-2);
}
.seg button {
  background: var(--bg-soft);
  color: var(--fg-muted);
  border: 1px solid var(--border);
  padding: var(--space-2) var(--space-4);
  font: inherit;
  cursor: pointer;
}
.seg button.active {
  color: var(--fg);
  border-color: var(--accent);
  outline: 1px solid var(--accent);
}
.seg button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.ck {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  color: var(--fg-muted);
  cursor: pointer;
}
.add-row {
  margin: var(--space-4) 0 0;
}
</style>
