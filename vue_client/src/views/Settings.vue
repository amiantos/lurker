<template>
  <div class="settings-page">
    <header class="bar">
      <RouterLink to="/" class="back">← back</RouterLink>
      <h1>settings</h1>
      <input v-model="search" placeholder="Search keys or descriptions…" class="search" />
      <label class="toggle">
        <input type="checkbox" v-model="modifiedOnly" />
        <span>modified only</span>
      </label>
      <button class="link danger" :disabled="!anyModified || working" @click="onResetAll">reset all</button>
    </header>

    <p v-if="error" class="error">{{ error }}</p>

    <section class="rules-section">
      <h2>highlight rules</h2>
      <p class="rules-desc">
        Rules whose pattern matches an incoming message mark it as a highlight (line accent + sidebar dot).
        Auto-managed entries track each network's current nick and can only be enabled/disabled.
      </p>
      <p v-if="rulesError" class="error inline">{{ rulesError }}</p>
      <ul class="rule-list">
        <li v-for="rule in rulesStore.rules" :key="rule.id" class="rule" :class="{ auto: rule.auto_managed_network_id != null }">
          <span class="lock" :title="rule.auto_managed_network_id != null ? 'auto-managed (network nick)' : 'user rule'">
            {{ rule.auto_managed_network_id != null ? '🔒' : '' }}
          </span>
          <input
            type="text"
            class="pattern"
            :value="rule.pattern"
            :disabled="rule.auto_managed_network_id != null"
            @change="onRuleField(rule, 'pattern', $event.target.value)"
            placeholder="pattern"
          />
          <select
            :value="rule.kind"
            :disabled="rule.auto_managed_network_id != null"
            @change="onRuleField(rule, 'kind', $event.target.value)"
          >
            <option value="plain">plain</option>
            <option value="glob">glob</option>
            <option value="regex">regex</option>
          </select>
          <label class="ck" title="case sensitive">
            <input
              type="checkbox"
              :checked="rule.case_sensitive"
              :disabled="rule.auto_managed_network_id != null"
              @change="onRuleField(rule, 'case_sensitive', $event.target.checked)"
            />
            <span>Aa</span>
          </label>
          <label class="ck" title="enabled">
            <input
              type="checkbox"
              :checked="rule.enabled"
              @change="onRuleField(rule, 'enabled', $event.target.checked)"
            />
            <span>{{ rule.enabled ? 'on' : 'off' }}</span>
          </label>
          <button
            class="link danger"
            :disabled="rule.auto_managed_network_id != null"
            @click="onRuleDelete(rule)"
            title="delete rule"
          >×</button>
        </li>
      </ul>
      <div class="rule-add">
        <input
          v-model="newPattern"
          type="text"
          placeholder="add highlight pattern…"
          @keydown.enter="onRuleAdd"
        />
        <select v-model="newKind">
          <option value="plain">plain</option>
          <option value="glob">glob</option>
          <option value="regex">regex</option>
        </select>
        <label class="ck">
          <input type="checkbox" v-model="newCaseSensitive" />
          <span>Aa</span>
        </label>
        <button class="link" :disabled="!newPattern.trim()" @click="onRuleAdd">add</button>
      </div>
    </section>

    <p v-if="!settings.loaded && !filtered.length" class="muted">Loading settings…</p>
    <p v-else-if="!filtered.length" class="muted">No settings match.</p>

    <ul class="rows">
      <li v-for="opt in filtered" :key="opt.key" class="row" :class="{ modified: settings.isModified(opt.key) }">
        <span class="marker" :title="settings.isModified(opt.key) ? 'modified from default' : ''">{{ settings.isModified(opt.key) ? '*' : '' }}</span>
        <div class="head">
          <span class="key">{{ opt.key }}</span>
          <span class="type">{{ opt.type }}</span>
          <button v-if="settings.isModified(opt.key)" class="link reset" @click="onReset(opt.key)" title="reset to default">reset</button>
        </div>
        <div class="desc">{{ opt.description }}</div>
        <div class="editor">
          <!-- bool -->
          <label v-if="opt.type === 'bool'" class="bool">
            <input type="checkbox" :checked="settings.effective(opt.key)" @change="onCommit(opt.key, $event.target.checked)" />
            <span>{{ settings.effective(opt.key) ? 'on' : 'off' }}</span>
          </label>
          <!-- int -->
          <input
            v-else-if="opt.type === 'int'"
            type="number"
            :min="opt.min"
            :max="opt.max"
            :value="settings.effective(opt.key)"
            @change="onCommit(opt.key, Number($event.target.value))"
          />
          <!-- enum -->
          <select
            v-else-if="opt.type === 'enum'"
            :value="settings.effective(opt.key)"
            @change="onCommit(opt.key, $event.target.value)"
          >
            <option v-for="c in opt.choices" :key="c" :value="c">{{ c }}</option>
          </select>
          <!-- color -->
          <span v-else-if="opt.type === 'color'" class="color-edit">
            <span class="swatch" :style="{ background: settings.effective(opt.key) }"></span>
            <input
              type="text"
              :value="settings.effective(opt.key)"
              @change="onCommit(opt.key, $event.target.value)"
            />
          </span>
          <!-- string-list -->
          <textarea
            v-else-if="opt.type === 'string-list'"
            :value="(settings.effective(opt.key) || []).join('\n')"
            @change="onCommit(opt.key, $event.target.value.split('\n').map(s => s.trim()).filter(Boolean))"
            rows="6"
          ></textarea>
          <!-- string (default) -->
          <input
            v-else
            type="text"
            :value="settings.effective(opt.key)"
            @change="onCommit(opt.key, $event.target.value)"
          />
        </div>
        <div v-if="settings.isModified(opt.key)" class="default-line">
          default: <code>{{ formatDefault(opt) }}</code>
        </div>
      </li>
    </ul>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useSettingsStore } from '../stores/settings.js';
import { useHighlightRulesStore } from '../stores/highlightRules.js';
import { useSocket } from '../composables/useSocket.js';

useSocket();

const settings = useSettingsStore();
const rulesStore = useHighlightRulesStore();
const search = ref('');
const modifiedOnly = ref(false);
const error = ref('');
const rulesError = ref('');
const working = ref(false);

const newPattern = ref('');
const newKind = ref('plain');
const newCaseSensitive = ref(false);

onMounted(() => {
  if (!settings.loaded) settings.fetchAll().catch((e) => { error.value = e.message; });
  if (!rulesStore.loaded) rulesStore.fetchAll().catch((e) => { rulesError.value = e.message; });
});

async function onRuleField(rule, field, value) {
  rulesError.value = '';
  try {
    await rulesStore.update(rule.id, { [field]: value });
  } catch (e) {
    rulesError.value = e.message || 'update failed';
    rulesStore.fetchAll().catch(() => { /* ignore */ });
  }
}

async function onRuleDelete(rule) {
  rulesError.value = '';
  try {
    await rulesStore.remove(rule.id);
  } catch (e) {
    rulesError.value = e.message || 'delete failed';
  }
}

async function onRuleAdd() {
  const pattern = newPattern.value.trim();
  if (!pattern) return;
  rulesError.value = '';
  try {
    await rulesStore.create({
      pattern,
      kind: newKind.value,
      case_sensitive: newCaseSensitive.value,
      enabled: true,
    });
    newPattern.value = '';
    newKind.value = 'plain';
    newCaseSensitive.value = false;
  } catch (e) {
    rulesError.value = e.message || 'create failed';
  }
}

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase();
  return settings.registry.filter((opt) => {
    if (modifiedOnly.value && !settings.isModified(opt.key)) return false;
    if (!q) return true;
    return opt.key.toLowerCase().includes(q) || (opt.description || '').toLowerCase().includes(q);
  });
});

const anyModified = computed(() => settings.registry.some((o) => settings.isModified(o.key)));

function formatDefault(opt) {
  const v = opt.default;
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  return String(v);
}

async function onCommit(key, value) {
  error.value = '';
  working.value = true;
  try {
    await settings.setValue(key, value);
  } catch (e) {
    error.value = e.message || 'failed to save';
  } finally {
    working.value = false;
  }
}

async function onReset(key) {
  error.value = '';
  working.value = true;
  try {
    await settings.reset(key);
  } catch (e) {
    error.value = e.message || 'failed to reset';
  } finally {
    working.value = false;
  }
}

async function onResetAll() {
  if (!confirm('Reset every setting to its default?')) return;
  error.value = '';
  working.value = true;
  try {
    await settings.resetAll();
  } catch (e) {
    error.value = e.message || 'failed to reset';
  } finally {
    working.value = false;
  }
}
</script>

<style scoped>
.settings-page {
  height: 100vh;
  display: flex;
  flex-direction: column;
}
.bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--border);
  flex: 0 0 auto;
}
.bar h1 { margin: 0; color: var(--fg-muted); text-transform: uppercase; letter-spacing: 0.04em; flex: 0 0 auto; font-size: inherit; font-weight: 600; }
.bar .back { color: var(--accent); text-decoration: none; }
.bar .back:hover { color: var(--fg); }
.bar .search { flex: 1; }
.bar .search:focus { outline: none; border-color: var(--accent); }
.bar .toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--fg-muted);
}
.link {
  background: none;
  border: none;
  color: var(--accent);
  padding: 2px 6px;
  cursor: pointer;
  font: inherit;
}
.link:hover:not(:disabled) { color: var(--fg); background: transparent; }
.link:disabled { opacity: 0.4; cursor: not-allowed; }
.link.danger { color: var(--bad); }

.error {
  color: var(--bad);
  padding: 6px 12px;
  border-bottom: 1px solid var(--border);
  margin: 0;
}
.muted {
  text-align: center;
  color: var(--fg-muted);
  padding: 32px;
  font-style: italic;
}

.rows {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  flex: 1;
  min-height: 0;
}
.row {
  display: grid;
  grid-template-columns: 14px 1fr;
  grid-template-areas:
    "marker head"
    ".      desc"
    ".      editor"
    ".      default";
  gap: 2px 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
}
.row:hover { background: var(--bg-soft); }
.row.modified .key { color: var(--warn); }

.marker { grid-area: marker; color: var(--warn); }
.head { grid-area: head; display: flex; align-items: center; gap: 10px; }
.key { font-weight: 600; color: var(--accent); }
.type {
  color: var(--fg-muted);
  border: 1px solid var(--border);
  padding: 0 4px;
  text-transform: lowercase;
}
.desc { grid-area: desc; color: var(--fg-muted); }

.editor { grid-area: editor; margin-top: 4px; }
.editor input[type="text"],
.editor select { min-width: 280px; }
.editor input[type="number"] { width: 120px; }
.editor textarea {
  width: 100%;
  max-width: 480px;
  resize: vertical;
}
.editor .bool { display: flex; align-items: center; gap: 6px; cursor: pointer; }
.editor .color-edit { display: flex; align-items: center; gap: 8px; }
.editor .swatch {
  width: 14px;
  height: 14px;
  border: 1px solid var(--border);
  display: inline-block;
}
.default-line { grid-area: default; color: var(--fg-muted); }
.default-line code {
  background: var(--bg-soft);
  padding: 0 4px;
}

.rules-section {
  padding: 8px 12px 12px;
  border-bottom: 1px solid var(--border);
  flex: 0 0 auto;
}
.rules-section h2 {
  margin: 0 0 4px;
  color: var(--fg-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-size: inherit;
  font-weight: 600;
}
.rules-desc { color: var(--fg-muted); margin: 0 0 8px; }
.error.inline { padding: 4px 0; border: none; }
.rule-list { list-style: none; margin: 0 0 6px; padding: 0; }
.rule {
  display: grid;
  grid-template-columns: 18px minmax(120px, 1fr) max-content max-content max-content max-content;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
}
.rule.auto .pattern { color: var(--fg-muted); }
.lock { font-size: 12px; color: var(--fg-muted); text-align: center; }
.rule .ck { display: flex; align-items: center; gap: 4px; color: var(--fg-muted); cursor: pointer; }
.rule-add {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
}
.rule-add input[type="text"] { flex: 1; min-width: 200px; }
</style>
