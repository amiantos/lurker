<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <section id="ignores" class="settings-pane">
    <h2>ignores</h2>
    <p class="section-desc">
      Ignore rules hide matching messages. A rule matches by nick/hostmask (<code
        >nick!user@host</code
      >
      with <code>*</code> wildcards) and can be narrowed to specific channels, message text, and
      event types. Rules are <strong>global</strong> by default; scope one to a single network if
      you only want it there. Everything here is also available through the
      <code>/ignore</code> command.
    </p>

    <p v-if="!ignoreGroups.length" class="muted small">
      No ignores yet. Add one below, right-click a nick in the member list, or type
      <code>/ignore &lt;nick&gt;</code> in any buffer.
    </p>

    <template v-for="group in ignoreGroups" :key="group.key">
      <h3 class="subhead sibling">{{ group.name }}</h3>
      <ul class="device-list">
        <li v-for="entry in group.entries" :key="entry.id" class="device">
          <span class="ua">
            {{ entry.mask ?? '*' }}
            <span class="muted small ignore-detail">{{ describe(entry) }}</span>
          </span>
          <span class="btn-bar">
            <IconButton :icon="PenIcon" label="edit" @click="startEdit(entry)" />
            <IconButton :icon="TrashIcon" label="remove" danger @click="onRemove(entry)" />
          </span>
        </li>
      </ul>
    </template>

    <h3 class="subhead">{{ editing ? 'edit ignore' : 'add ignore' }}</h3>
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

      <!-- Who -->
      <label class="field">
        <span class="field-label"
          >Mask <span class="muted small">(who — blank = anyone)</span></span
        >
        <input
          v-model="form.mask"
          type="text"
          placeholder="nick or nick!user@host"
          spellcheck="false"
          autocapitalize="off"
          autocomplete="off"
        />
      </label>

      <!-- Where -->
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

      <!-- What -->
      <div class="field">
        <span class="field-label"
          >Message text <span class="muted small">(what — blank = any)</span></span
        >
        <div class="row">
          <input
            v-model="form.pattern"
            type="text"
            class="grow"
            placeholder="text to match in the message"
            spellcheck="false"
          />
          <select v-model="form.patternKind">
            <option value="substr">contains</option>
            <option value="full">whole word</option>
            <option value="regex">regex</option>
          </select>
        </div>
      </div>

      <!-- Which (levels) -->
      <div class="field">
        <span class="field-label">Event types</span>
        <div class="chips">
          <button
            type="button"
            class="chip"
            :class="{ active: useAll }"
            :aria-pressed="useAll"
            @click="toggleAllLevels"
          >
            ALL
          </button>
          <button
            v-for="lvl in GRANULAR_LEVELS"
            :key="lvl"
            type="button"
            class="chip"
            :class="{ active: !useAll && form.levels.includes(lvl) }"
            :aria-pressed="!useAll && form.levels.includes(lvl)"
            @click="toggleLevel(lvl)"
          >
            {{ lvl }}
          </button>
        </div>
        <label class="ck">
          <input v-model="form.noHighlight" type="checkbox" />
          <span>Suppress highlights only (don't hide) — NOHIGHLIGHT</span>
        </label>
      </div>

      <!-- Modifiers -->
      <div class="field">
        <span class="field-label">Options</span>
        <label class="ck">
          <input v-model="form.isExcept" type="checkbox" />
          <span>Exception (whitelist — keep these even if another rule would hide them)</span>
        </label>
        <div class="row">
          <span class="muted small expiry-label">Expires in</span>
          <input
            v-model="form.expiry"
            type="text"
            class="expiry"
            placeholder="e.g. 7 days — blank = never"
            spellcheck="false"
          />
        </div>
        <p v-if="editing && editingExpiresAt" class="muted small">
          Currently expires {{ formatWhen(editingExpiresAt) }}. Leave blank to remove the expiry, or
          enter a new duration to reset it.
        </p>
      </div>

      <!-- ⚠ Next to the button, not at the top of the pane. It used to render above the section
           description and above the whole rule list, so for anyone with a few ignores the
           explanation for a refused submit was off-screen and the click read as doing nothing.
           Every one of these errors comes from buildRule, so the form is where they belong —
           and the empty-levels one below is far likelier to be hit than the regex/duration
           ones this markup was written for. -->
      <p v-if="formError" class="error inline">{{ formError }}</p>

      <div class="actions">
        <button v-if="editing" class="btn-secondary" @click="cancelEdit">cancel</button>
        <button class="btn-primary" :disabled="!canSubmit" @click="submit">
          {{ editing ? 'save' : 'add ignore' }}
        </button>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { ref, reactive, computed } from 'vue';
import { useNetworksStore } from '../../stores/networks.js';
import { useIgnoresStore, type IgnoreEntryWithNetwork } from '../../stores/ignores.js';
import IconButton from '../IconButton.vue';
import type { IgnoreRule } from '../../utils/ignoreMatch.js';
import { durationToExpiry, type IgnorePatternKind } from '../../../../shared/parseIgnore.js';
import { CANONICAL_ORDER } from '../../../../shared/ignoreLevels.js';
import { PenIcon, TrashIcon } from '@lucide/vue';

// Granular event types for the chip row: every level except the special ALL,
// the never-surfaced CTCPS, and NOHIGHLIGHT (its own modifier checkbox).
const GRANULAR_LEVELS = CANONICAL_ORDER.filter(
  (l) => l !== 'ALL' && l !== 'CTCPS' && l !== 'NOHIGHLIGHT',
);

// Mirrors MAX_PATTERN_LENGTH in server/services/ignoreRulesService.ts.
const MAX_PATTERN_LENGTH = 512;

const networksStore = useNetworksStore();
const ignores = useIgnoresStore();

interface IgnoreGroup {
  key: string;
  name: string;
  entries: IgnoreEntryWithNetwork[];
}

// One-line summary of a rule's non-mask dimensions for the list.
function describe(entry: IgnoreEntryWithNetwork): string {
  const parts: string[] = [];
  if (entry.levels?.length) parts.push(entry.levels.join(','));
  if (entry.channels?.length) parts.push(entry.channels.join(','));
  if (entry.pattern) {
    parts.push(entry.patternKind === 'regex' ? `/${entry.pattern}/` : `"${entry.pattern}"`);
  }
  if (entry.isExcept) parts.push('except');
  if (entry.expiresAt) parts.push(`expires ${formatWhen(entry.expiresAt)}`);
  return parts.join('  ');
}

function formatWhen(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : new Date(t).toLocaleString();
}

// Global group first (networkId null), then per-network groups sorted by name.
const ignoreGroups = computed<IgnoreGroup[]>(() => {
  const globals: IgnoreEntryWithNetwork[] = [];
  const byNet = new Map<number, IgnoreEntryWithNetwork[]>();
  for (const entry of ignores.allEntries) {
    if (entry.networkId == null) {
      globals.push(entry);
    } else {
      const list = byNet.get(entry.networkId);
      if (list) list.push(entry);
      else byNet.set(entry.networkId, [entry]);
    }
  }
  const groups: IgnoreGroup[] = [];
  if (globals.length)
    groups.push({ key: 'global', name: 'Global (all networks)', entries: globals });
  const netGroups: IgnoreGroup[] = [];
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
const useAll = ref(true);
const editing = ref<{ id: number; scope: number | null } | null>(null);
const editingExpiresAt = ref<string | null>(null);
const formError = ref('');

const form = reactive({
  mask: '',
  channels: '',
  pattern: '',
  patternKind: 'substr' as IgnorePatternKind,
  levels: [] as string[],
  noHighlight: false,
  isExcept: false,
  expiry: '',
});

const canSubmit = computed(() => {
  if (scopeMode.value === 'network' && !scopeNetworkId.value) return false;
  // A non-except rule needs at least one dimension or a level selection to do
  // anything; an except rule needs a mask to whitelist someone.
  return true;
});

function selectNetworkScope() {
  if (!networkOptions.value.length) return;
  scopeMode.value = 'network';
  if (!scopeNetworkId.value) scopeNetworkId.value = networkOptions.value[0].id;
}

// ⚠⚠ A toggle, not a select. ALL used to be switch-on-only, and with the granular
// chips snapping back to it whenever the last one was cleared, "no hide levels"
// was a state the GUI could not express at all — which is exactly a NOHIGHLIGHT-only
// rule, the one that suppresses a nick's highlights without hiding anything. They
// could be written with `/ignore bob NOHIGHLIGHT` and then not edited here, because
// opening one re-selected ALL and saving changed what the rule meant (#775).
//
// An empty selection is now a legitimate state to be IN. Whether it is a legitimate
// state to SUBMIT is buildRule's question, and it answers with an error rather than
// by quietly reinstating ALL.
function toggleAllLevels() {
  useAll.value = !useAll.value;
  if (useAll.value) form.levels = [];
}

function toggleLevel(lvl: string) {
  useAll.value = false;
  const i = form.levels.indexOf(lvl);
  if (i >= 0) form.levels.splice(i, 1);
  else form.levels.push(lvl);
}

function parseChannels(s: string): string[] | null {
  const list = s
    .split(/[\s,]+/)
    .map((c) => c.trim().toLowerCase())
    .filter(Boolean);
  return list.length ? list : null;
}

// ⚠ No `|| ['ALL']` fallback. It was what turned an empty selection back into
// "hide everything" on the way to the server — silently, and in the one case
// (NOHIGHLIGHT-only) where empty is what the user meant. buildRule rejects a
// genuinely empty rule instead, where the user can see it happen.
function buildLevels(): string[] {
  const out: string[] = useAll.value ? ['ALL'] : [...form.levels];
  if (form.noHighlight) out.push('NOHIGHLIGHT');
  return out;
}

function buildRule(): IgnoreRule | null {
  formError.value = '';
  let mask: string | null = form.mask.trim() || null;
  if (mask === '*') mask = null;
  const channels = parseChannels(form.channels);
  const pattern = form.pattern.trim() || null;
  const patternKind = form.patternKind;
  // Mirror the server's cap so the add can't be rejected after the edit's remove
  // has already fired (which would lose the original rule). buildRule runs before
  // the remove in submit(), so every check here is a safe pre-flight.
  if (pattern && pattern.length > MAX_PATTERN_LENGTH) {
    formError.value = `message text is too long (max ${MAX_PATTERN_LENGTH} characters).`;
    return null;
  }
  if (pattern && patternKind === 'regex') {
    try {
      void new RegExp(pattern);
    } catch (e) {
      formError.value = `invalid regex: ${(e as Error).message}`;
      return null;
    }
  }
  const levels = buildLevels();
  // An empty selection is now reachable (ALL is a toggle), so it has to be
  // answered here — visibly — instead of buildLevels quietly turning it back into
  // "hide everything". Tick the modifier and it IS a valid rule: hide nothing,
  // suppress this nick's highlights. That is the rule #775 was about.
  if (levels.length === 0) {
    formError.value =
      'pick at least one event type, or tick “Suppress highlights only” — as written this rule would do nothing.';
    return null;
  }
  // Guard the footgun rules a GUI shouldn't make easy. A rule with no who/where/
  // what matches the whole feed: as a hide rule with ALL it hides everything; as
  // an exception it whitelists everyone, neutralizing real ignores. Broad-but-
  // targeted rules (all notices, all joins on #chan) stay fine.
  const unscoped = !mask && !channels && !pattern;
  if (unscoped && form.isExcept) {
    formError.value = 'an exception needs a mask, channel, or text pattern to whitelist.';
    return null;
  }
  if (unscoped && levels.includes('ALL')) {
    formError.value = 'that would hide everything — add a mask, channel, or text pattern.';
    return null;
  }
  // ⚠⚠ The same footgun, in the shape this change newly made reachable. A modifier-only rule
  // with no who/where/what compiles to matchesNick = () => true with hides:false, and
  // evaluateIgnores' no-applies branch is unbounded for a non-hiding rule — so it silently kills
  // every highlight on every network, and the list shows it as nothing but `*  NOHIGHLIGHT`.
  // Two clicks away from the default form, which is exactly why it needs saying out loud.
  if (unscoped && !useAll.value && form.levels.length === 0) {
    formError.value = 'that would silence every highlight — add a mask, channel, or text pattern.';
    return null;
  }
  let expiresAt: string | null = null;
  const dur = form.expiry.trim();
  if (dur) {
    const iso = durationToExpiry(dur);
    if (!iso) {
      formError.value = `invalid duration: ${dur}`;
      return null;
    }
    expiresAt = iso;
  }
  return { mask, channels, pattern, patternKind, levels, isExcept: form.isExcept, expiresAt };
}

function resetForm() {
  form.mask = '';
  form.channels = '';
  form.pattern = '';
  form.patternKind = 'substr';
  form.levels = [];
  form.noHighlight = false;
  form.isExcept = false;
  form.expiry = '';
  useAll.value = true;
  editing.value = null;
  editingExpiresAt.value = null;
}

function startEdit(entry: IgnoreEntryWithNetwork) {
  editing.value = { id: entry.id, scope: entry.networkId };
  editingExpiresAt.value = entry.expiresAt ?? null;
  form.mask = entry.mask ?? '';
  form.channels = (entry.channels || []).join(' ');
  form.pattern = entry.pattern ?? '';
  form.patternKind = entry.patternKind;
  form.isExcept = entry.isExcept;
  form.expiry = '';
  const lv = entry.levels || [];
  // ⚠⚠ Read the HIDE levels, and only them. The old test also lit ALL when every
  // level was NOHIGHLIGHT — `[].every()` and `['NOHIGHLIGHT'].every()` are both
  // true — so opening a NOHIGHLIGHT-only rule showed ALL selected, and saving
  // wrote back ['ALL','NOHIGHLIGHT']: the edit turned "don't highlight me for bob"
  // into "hide bob entirely". That is the "they get the ALL option added by
  // default" half of #775, and it silently rewrote rules people had already made
  // with /ignore.
  const hideLevels = lv.filter((l) => l !== 'NOHIGHLIGHT');
  useAll.value = hideLevels.includes('ALL');
  form.levels = useAll.value ? [] : hideLevels;
  form.noHighlight = lv.includes('NOHIGHLIGHT');
  if (entry.networkId == null) {
    scopeMode.value = 'global';
  } else {
    scopeMode.value = 'network';
    scopeNetworkId.value = entry.networkId;
  }
  formError.value = '';
}

function cancelEdit() {
  resetForm();
  formError.value = '';
}

function submit() {
  const rule = buildRule();
  if (!rule) return;
  const scope = scopeMode.value === 'network' ? scopeNetworkId.value : null;
  if (scopeMode.value === 'network' && !scope) {
    formError.value = 'choose a network';
    return;
  }
  // Edit = remove the old rule (in its original scope) then add the new one.
  if (editing.value) ignores.removeRule(editing.value.scope, { id: editing.value.id });
  ignores.addRule(scope, rule);
  resetForm();
}

function onRemove(entry: IgnoreEntryWithNetwork) {
  if (editing.value?.id === entry.id) cancelEdit();
  ignores.removeRule(entry.networkId, { id: entry.id });
}
</script>

<style src="./panes.css"></style>
<style scoped>
.ignore-detail {
  margin-left: var(--space-3);
}
.device .ua {
  min-width: 0;
  overflow-wrap: anywhere;
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
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.chip {
  background: var(--bg-soft);
  color: var(--fg-muted);
  border: 1px solid var(--border);
  padding: var(--space-1) var(--space-3);
  font: inherit;
  cursor: pointer;
}
.chip.active {
  color: var(--fg);
  border-color: var(--accent);
  outline: 1px solid var(--accent);
}
.ck {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  color: var(--fg-muted);
  cursor: pointer;
}
.expiry-label {
  min-width: 6em;
}
.expiry {
  flex: 1;
  min-width: 0;
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-4);
  padding-top: var(--space-2);
}
</style>
