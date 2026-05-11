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
      <h2>passkeys</h2>
      <p class="rules-desc">
        Sign in is passkey-only. Add a passkey for each device you want to use.
        Removing your last passkey would lock you out, so it's blocked.
      </p>
      <p v-if="passkeyError" class="error inline">{{ passkeyError }}</p>
      <ul v-if="passkeys.length" class="device-list">
        <li v-for="pk in passkeys" :key="pk.id" class="device passkey">
          <span class="ua">
            <input
              type="text"
              :value="pk.label || ''"
              :placeholder="defaultPasskeyLabel(pk)"
              @change="onRenamePasskey(pk, $event.target.value)"
            />
          </span>
          <span class="last-seen" :title="pk.lastUsedAt || pk.createdAt">
            {{ pk.lastUsedAt ? `last used ${formatRelative(pk.lastUsedAt)}` : `added ${formatRelative(pk.createdAt)}` }}
          </span>
          <button
            class="link danger"
            :disabled="passkeys.length <= 1 || passkeyBusy"
            :title="passkeys.length <= 1 ? 'cannot remove your only passkey' : 'remove this passkey'"
            @click="onRemovePasskey(pk)"
          >remove</button>
        </li>
      </ul>
      <p v-else class="muted small">No passkeys registered.</p>
      <div class="passkey-add">
        <button class="link" :disabled="passkeyBusy" @click="onAddPasskey">add passkey</button>
        <button class="link danger" @click="signOut">sign out</button>
      </div>
    </section>

    <section class="rules-section push-section">
      <h2>push notifications</h2>
      <p class="rules-desc">
        Each browser/device subscribes independently. Enable here to receive system
        notifications on this device when a highlight or DM arrives and no other
        client of yours is currently visible.
      </p>
      <p v-if="pushError" class="error inline">{{ pushError }}</p>

      <div class="this-client">
        <span class="this-label">this client</span>
        <button
          v-if="!pushSupported"
          class="link"
          disabled
        >push not supported in this browser</button>
        <button
          v-else-if="thisClientEnabled"
          class="link danger"
          :disabled="pushBusy"
          @click="onDisableThisClient"
        >disable for this client</button>
        <button
          v-else
          class="link"
          :disabled="pushBusy"
          @click="onEnableThisClient"
        >enable for this client</button>
      </div>

      <ul v-if="otherSubscriptions.length" class="device-list">
        <li v-for="sub in otherSubscriptions" :key="sub.id" class="device">
          <span class="ua">{{ formatUA(sub.user_agent) }}</span>
          <span class="last-seen" :title="sub.last_seen_at">last seen {{ formatRelative(sub.last_seen_at) }}</span>
          <button class="link danger" @click="onRemoveOther(sub)" :disabled="pushBusy">remove</button>
        </li>
      </ul>
      <p v-else-if="pushSubsStore.loaded && thisClientEnabled" class="muted small">No other devices registered.</p>
    </section>

    <section class="rules-section">
      <h2>highlight rules</h2>
      <p class="rules-desc">
        Rules whose pattern matches an incoming message mark it as a highlight (line accent + sidebar dot).
        Auto-managed entries track each network's current nick and can only be enabled/disabled.
      </p>
      <p v-if="rulesError" class="error inline">{{ rulesError }}</p>
      <ul class="rule-list">
        <li v-for="rule in rulesStore.rules" :key="rule.id" class="rule" :class="{ auto: rule.auto_managed }">
          <span class="lock" :title="rule.auto_managed ? 'auto-managed (network nick)' : 'user rule'">
            {{ rule.auto_managed ? '🔒' : '' }}
          </span>
          <input
            type="text"
            class="pattern"
            :value="rule.pattern"
            :disabled="rule.auto_managed"
            @change="onRuleField(rule, 'pattern', $event.target.value)"
            placeholder="pattern"
          />
          <select
            :value="rule.kind"
            :disabled="rule.auto_managed"
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
              :disabled="rule.auto_managed"
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
            :disabled="rule.auto_managed"
            @click="onRuleDelete(rule)"
            title="delete rule"
          ><i class="fa-solid fa-xmark"></i></button>
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
import { useRouter } from 'vue-router';
import { useSettingsStore } from '../stores/settings.js';
import { useHighlightRulesStore } from '../stores/highlightRules.js';
import { usePushSubscriptionsStore } from '../stores/pushSubscriptions.js';
import { useAuthStore } from '../stores/auth.js';
import { useSocket } from '../composables/useSocket.js';
import {
  isSupported as isPushSupported,
  registerSW,
  enable as enablePush,
  disable as disablePush,
  getCurrentEndpoint,
} from '../composables/usePush.js';

useSocket();

const settings = useSettingsStore();
const rulesStore = useHighlightRulesStore();
const pushSubsStore = usePushSubscriptionsStore();
const auth = useAuthStore();
const router = useRouter();
const search = ref('');
const passkeys = ref([]);
const passkeyError = ref('');
const passkeyBusy = ref(false);
const modifiedOnly = ref(false);
const error = ref('');
const rulesError = ref('');
const pushError = ref('');
const pushBusy = ref(false);
const pushSupported = isPushSupported();
const currentEndpoint = ref(null);
const working = ref(false);

const newPattern = ref('');
const newKind = ref('plain');
const newCaseSensitive = ref(false);

const thisClientEnabled = computed(() => {
  if (!currentEndpoint.value) return false;
  return pushSubsStore.subscriptions.some((s) => s.endpoint === currentEndpoint.value);
});

const otherSubscriptions = computed(() =>
  pushSubsStore.subscriptions.filter((s) => s.endpoint !== currentEndpoint.value)
);

async function refreshPushState() {
  if (!pushSupported) return;
  try {
    currentEndpoint.value = await getCurrentEndpoint();
  } catch { currentEndpoint.value = null; }
  try {
    await pushSubsStore.fetchAll();
  } catch (e) {
    pushError.value = e.message || 'failed to load devices';
  }
}

onMounted(async () => {
  if (!settings.loaded) settings.fetchAll().catch((e) => { error.value = e.message; });
  if (!rulesStore.loaded) rulesStore.fetchAll().catch((e) => { rulesError.value = e.message; });
  if (pushSupported) {
    registerSW().catch(() => { /* registration is best-effort here */ });
    refreshPushState();
  }
  refreshPasskeys();
});

async function refreshPasskeys() {
  try {
    passkeys.value = await auth.listPasskeys();
  } catch (e) {
    passkeyError.value = e.message || 'failed to load passkeys';
  }
}

function defaultPasskeyLabel(pk) {
  const where = pk.backedUp ? 'synced' : 'this device';
  return `passkey (${where})`;
}

async function onAddPasskey() {
  passkeyError.value = '';
  passkeyBusy.value = true;
  try {
    await auth.addPasskey({});
    await refreshPasskeys();
  } catch (e) {
    if (e.name !== 'NotAllowedError') {
      passkeyError.value = e.message || 'failed to add passkey';
    }
  } finally {
    passkeyBusy.value = false;
  }
}

async function onRenamePasskey(pk, label) {
  passkeyError.value = '';
  try {
    await auth.renamePasskey(pk.id, label);
    await refreshPasskeys();
  } catch (e) {
    passkeyError.value = e.message || 'rename failed';
  }
}

async function onRemovePasskey(pk) {
  if (!confirm(`Remove ${pk.label || 'this passkey'}?`)) return;
  passkeyError.value = '';
  passkeyBusy.value = true;
  try {
    await auth.deletePasskey(pk.id);
    await refreshPasskeys();
  } catch (e) {
    passkeyError.value = e.message || 'remove failed';
  } finally {
    passkeyBusy.value = false;
  }
}

async function signOut() {
  await auth.logout();
  router.replace('/login');
}

async function onEnableThisClient() {
  pushError.value = '';
  pushBusy.value = true;
  try {
    await enablePush();
    await refreshPushState();
  } catch (e) {
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
  } catch (e) {
    pushError.value = e.message || 'failed to disable';
  } finally {
    pushBusy.value = false;
  }
}

async function onRemoveOther(sub) {
  pushError.value = '';
  pushBusy.value = true;
  try {
    await pushSubsStore.removeByEndpoint(sub.endpoint);
  } catch (e) {
    pushError.value = e.message || 'failed to remove';
  } finally {
    pushBusy.value = false;
  }
}

function formatUA(ua) {
  if (!ua) return 'unknown device';
  // Cheap parser: extract a recognizable browser + OS pair from a UA string.
  // Avoids pulling in a heavy UA-parsing dep for what's basically a label.
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

function formatRelative(iso) {
  if (!iso) return '';
  // SQLite's `datetime('now')` returns 'YYYY-MM-DD HH:MM:SS' with no TZ
  // marker; Date.parse() then treats it as local time and reports a future
  // moment for users east of UTC offset zero. Treat unmarked timestamps as UTC.
  const hasTz = /[zZ]|[+-]\d{2}:?\d{2}$/.test(iso);
  const normalized = hasTz ? iso : iso.replace(' ', 'T') + 'Z';
  const t = Date.parse(normalized);
  if (!t) return iso;
  const diff = Date.now() - t;
  const sec = Math.max(0, Math.round(diff / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}

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

.push-section .this-client {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 4px 0 8px;
}
.push-section .this-label {
  color: var(--fg-muted);
  font-weight: 600;
}
.device-list { list-style: none; margin: 0; padding: 0; }
.device {
  display: grid;
  grid-template-columns: 1fr max-content max-content;
  gap: 12px;
  align-items: center;
  padding: 4px 0;
  border-top: 1px solid var(--border);
}
.device .ua { color: var(--fg); }
.device .last-seen { color: var(--fg-muted); font-size: 0.95em; }
.muted.small { font-size: 0.95em; padding: 4px 0; }

.passkey .ua input[type="text"] {
  width: 100%;
  background: transparent;
  border: 1px solid transparent;
  color: var(--fg);
  padding: 2px 4px;
}
.passkey .ua input[type="text"]:hover,
.passkey .ua input[type="text"]:focus {
  border-color: var(--border);
}
.passkey-add {
  margin-top: 4px;
  display: flex;
  gap: 1ch;
  align-items: center;
}
</style>
