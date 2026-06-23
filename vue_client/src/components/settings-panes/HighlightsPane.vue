<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <section id="highlights" class="settings-pane">
    <h2>highlights</h2>
    <p class="section-desc">
      Highlight rules mark matching messages (line accent + sidebar dot). A rule matches a keyword
      (<code>contains</code>, <code>whole word</code>, <code>glob</code>, or <code>regex</code>)
      and/or a sender hostmask (<code>nick!user@host</code> with <code>*</code> wildcards), and can
      be narrowed to specific channels. Rules are <strong>global</strong> by default; scope one to a
      single network if you only want it there. Everything here is also available through the
      <code>/highlight</code> command. Configure notification delivery in the Notifications pane.
    </p>

    <p v-if="formError" class="error inline">{{ formError }}</p>
    <p v-if="rulesError" class="error inline">{{ rulesError }}</p>

    <p v-if="!highlightGroups.length" class="muted small">
      No highlights yet. Add one below, or type <code>/highlight &lt;word&gt;</code> in any buffer.
    </p>

    <template v-for="group in highlightGroups" :key="group.key">
      <h3 class="subhead">{{ group.name }}</h3>
      <ul class="device-list">
        <li v-for="entry in group.entries" :key="entry.id" class="device">
          <span class="ua">
            {{ entry.mask ?? entry.pattern ?? '*' }}
            <span class="muted small hl-detail">{{ describe(entry) }}</span>
          </span>
          <div class="row-actions">
            <button
              type="button"
              class="toggle"
              :class="{ on: entry.enabled }"
              :disabled="entry.auto_managed"
              :aria-pressed="entry.enabled"
              :title="
                entry.auto_managed
                  ? 'auto-managed (network nick) — always on'
                  : entry.enabled
                    ? 'enabled — click to disable'
                    : 'disabled — click to enable'
              "
              aria-label="toggle highlight rule"
              @click="toggleEnabled(entry, !entry.enabled)"
            >
              <i
                :class="['fa-solid', entry.enabled ? 'fa-toggle-on' : 'fa-toggle-off']"
                aria-hidden="true"
              ></i>
            </button>
            <!-- Auto-managed (network nick) rules are fully system-managed, so the
                 toggle (above) and edit/remove are all disabled. -->
            <IconButton
              icon="fa-pen"
              label="edit"
              :disabled="entry.auto_managed"
              @click="startEdit(entry)"
            />
            <IconButton
              icon="fa-trash"
              label="remove"
              danger
              :disabled="entry.auto_managed"
              @click="onRemove(entry)"
            />
          </div>
        </li>
      </ul>
    </template>

    <h3 class="subhead">{{ editing ? 'edit highlight' : 'add highlight' }}</h3>
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
            v-model="form.pattern"
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
          v-model="form.mask"
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
          v-model="form.channels"
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

      <div class="actions">
        <button v-if="editing" class="link" @click="cancelEdit">cancel</button>
        <button class="link" :disabled="!canSubmit" @click="submit">
          {{ editing ? 'save' : 'add highlight' }}
        </button>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue';
import { useNetworksStore } from '../../stores/networks.js';
import { useHighlightRulesStore } from '../../stores/highlightRules.js';
import type { HighlightRule } from '../../stores/highlightRules.js';
import IconButton from '../IconButton.vue';
import { parseChannelList } from '../../../../shared/channels.js';
import { highlightRuleDetailParts } from '../../utils/highlightFormat.js';

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
// command listing so the two never drift.
function describe(entry: HighlightRule): string {
  return highlightRuleDetailParts(entry).join(' · ');
}

// Global group first (no network scope), then per-network groups sorted by name.
// A multi-network rule (an auto-nick rule spanning networks that share your nick)
// appears under each of its networks — it genuinely applies to all of them.
const highlightGroups = computed<HighlightGroup[]>(() => {
  const globals: HighlightRule[] = [];
  const byNet = new Map<number, HighlightRule[]>();
  for (const entry of rulesStore.rules) {
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

function startEdit(entry: HighlightRule) {
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

function cancelEdit() {
  resetForm();
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
    resetForm();
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
  if (editing.value?.id === entry.id) cancelEdit();
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
.toggle {
  background: none;
  border: none;
  cursor: pointer;
  font: inherit;
  line-height: 1;
  padding: var(--space-1) var(--space-2);
  color: var(--fg-muted);
}
.toggle.on {
  color: var(--accent);
}
.toggle:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.rule-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
  padding-top: var(--space-3);
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
.rule-form input[type='text'] {
  background: var(--bg-soft);
  color: var(--fg);
  border: 1px solid var(--border);
  padding: var(--space-2) var(--space-3);
  font: inherit;
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
.actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-4);
  padding-top: var(--space-2);
}
</style>
