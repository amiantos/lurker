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

    <div class="body">
      <nav class="sidebar" aria-label="settings sections">
        <a
          v-for="s in visibleSections"
          :key="s.id"
          :href="`#${s.id}`"
          @click.prevent="jumpTo(s.id)"
        >{{ s.title }}</a>
      </nav>

      <main class="content">
        <!-- ─── Notifications ──────────────────────────────────────────── -->
        <section v-if="showBespoke" id="notifications" class="section">
          <h2>notifications</h2>
          <p class="section-desc">
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

        <!-- ─── Highlights ─────────────────────────────────────────────── -->
        <section v-if="showBespoke" id="highlights" class="section">
          <h2>highlights</h2>
          <p class="section-desc">
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
              >delete</button>
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

          <hr class="hl-sep" />
          <h3 class="subhead">in-client alerts</h3>
          <p class="section-desc">
            Toast and sound that fire in this tab when a rule above matches.
            Push notifications cover the case where no Lurker tab is visible.
          </p>
          <div class="hl-notif">
            <label class="hl-row">
              <input
                type="checkbox"
                :checked="settings.effective('notifications.highlight.toast.enabled')"
                @change="onCommit('notifications.highlight.toast.enabled', $event.target.checked)"
              />
              <span>show toast in the corner</span>
            </label>

            <label class="hl-row">
              <input
                type="checkbox"
                :checked="settings.effective('notifications.highlight.sound.enabled')"
                @change="onCommit('notifications.highlight.sound.enabled', $event.target.checked)"
              />
              <span>play a sound</span>
            </label>

            <div class="hl-row" :class="{ 'hl-row--dim': !soundEnabled }">
              <span class="hl-label">sound</span>
              <select
                :value="settings.effective('notifications.highlight.sound.choice')"
                :disabled="!soundEnabled"
                @change="onCommit('notifications.highlight.sound.choice', $event.target.value)"
              >
                <option
                  v-for="c in soundChoices"
                  :key="c"
                  :value="c"
                >{{ c }}</option>
              </select>
              <button
                class="link"
                :disabled="!soundEnabled"
                @click="onPreviewSound"
              >preview</button>
            </div>

            <div class="hl-row" :class="{ 'hl-row--dim': !soundEnabled }">
              <span class="hl-label">volume</span>
              <input
                type="range"
                min="0"
                max="100"
                step="1"
                :value="settings.effective('notifications.highlight.sound.volume')"
                :disabled="!soundEnabled"
                @input="onVolumeInput($event.target.value)"
                @change="onCommit('notifications.highlight.sound.volume', Number($event.target.value))"
              />
              <span class="hl-vol-num">{{ settings.effective('notifications.highlight.sound.volume') }}</span>
            </div>
          </div>
        </section>

        <!-- ─── Away / Chat / Appearance (registry-driven) ────────────── -->
        <section
          v-for="cat in visibleCategories"
          :key="cat.id"
          :id="cat.id"
          class="section"
        >
          <h2>{{ cat.title }}</h2>
          <template v-for="grp in cat.groups" :key="grp.id">
            <h3 v-if="cat.groups.length > 1" class="subhead">{{ grp.title }}</h3>
            <ul class="rows">
              <li
                v-for="opt in grp.items"
                :key="opt.key"
                class="row"
                :class="{ modified: settings.isModified(opt.key) }"
                :title="settings.isModified(opt.key) ? 'modified from default' : ''"
              >
                <div class="head">
                  <span class="key">{{ opt.key }}</span>
                  <span class="type">{{ opt.type }}</span>
                  <button v-if="settings.isModified(opt.key)" class="link reset" @click="onReset(opt.key)" title="reset to default">reset</button>
                </div>
                <div class="desc">{{ opt.description }}</div>
                <div class="editor">
                  <label v-if="opt.type === 'bool'" class="bool">
                    <input type="checkbox" :checked="settings.effective(opt.key)" @change="onCommit(opt.key, $event.target.checked)" />
                    <span>{{ settings.effective(opt.key) ? 'on' : 'off' }}</span>
                  </label>
                  <input
                    v-else-if="opt.type === 'int'"
                    type="number"
                    :min="opt.min"
                    :max="opt.max"
                    :value="settings.effective(opt.key)"
                    @change="onCommit(opt.key, Number($event.target.value))"
                  />
                  <select
                    v-else-if="opt.type === 'enum'"
                    :value="settings.effective(opt.key)"
                    @change="onCommit(opt.key, $event.target.value)"
                  >
                    <option v-for="c in opt.choices" :key="c" :value="c">{{ c }}</option>
                  </select>
                  <span v-else-if="opt.type === 'color'" class="color-edit">
                    <span class="swatch" :style="{ background: settings.effective(opt.key) }"></span>
                    <input
                      type="text"
                      :value="settings.effective(opt.key)"
                      @change="onCommit(opt.key, $event.target.value)"
                    />
                  </span>
                  <textarea
                    v-else-if="opt.type === 'string-list'"
                    :value="(settings.effective(opt.key) || []).join('\n')"
                    @change="onCommit(opt.key, $event.target.value.split('\n').map(s => s.trim()).filter(Boolean))"
                    rows="6"
                  ></textarea>
                  <span v-else-if="opt.type === 'secret'" class="secret-edit">
                    <input
                      :type="revealedSecrets.has(opt.key) ? 'text' : 'password'"
                      autocomplete="off"
                      spellcheck="false"
                      :value="settings.effective(opt.key)"
                      @change="onCommit(opt.key, $event.target.value)"
                    />
                    <button
                      type="button"
                      class="link reveal"
                      @click="toggleSecret(opt.key)"
                    >{{ revealedSecrets.has(opt.key) ? 'hide' : 'show' }}</button>
                  </span>
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
          </template>
        </section>

        <p v-if="filtersActive && !visibleCategories.length" class="muted">No settings match.</p>
        <p v-else-if="!settings.loaded && !visibleCategories.length" class="muted">Loading settings…</p>

        <!-- ─── Users (admin only) ─────────────────────────────────────── -->
        <section v-if="showBespoke && isAdmin" id="users" class="section">
          <h2>users</h2>
          <p class="section-desc">
            Invite friends with a one-time link, or remove an account. The last admin
            and your own account can't be deleted.
          </p>
          <p v-if="adminError" class="error inline">{{ adminError }}</p>

          <h3 class="subhead">members</h3>
          <ul v-if="adminStore.users.length" class="device-list">
            <li v-for="u in adminStore.users" :key="u.id" class="device user-row">
              <span class="ua">
                {{ u.username }}
                <span v-if="u.role === 'admin'" class="role-tag">admin</span>
              </span>
              <span class="last-seen" :title="`joined ${u.createdAt}${u.lastSeenAt ? ` · last seen ${u.lastSeenAt}` : ''}`">
                <template v-if="u.lastSeenAt">last seen {{ formatRelative(u.lastSeenAt) }}</template>
                <template v-else>joined {{ formatRelative(u.createdAt) }}</template>
              </span>
              <button
                class="link danger"
                :disabled="u.id === auth.user?.id || adminBusy"
                :title="u.id === auth.user?.id ? 'cannot delete yourself' : 'delete user'"
                @click="onDeleteUser(u)"
              >delete</button>
            </li>
          </ul>
          <p v-else-if="adminStore.usersLoaded" class="muted small">No users.</p>

          <h3 class="subhead">invites</h3>
          <div class="invite-actions">
            <button class="link" :disabled="adminBusy" @click="onCreateInvite">
              generate invite link
            </button>
            <span v-if="lastCreatedInviteUrl" class="invite-fresh" title="copied to clipboard">
              <code>{{ lastCreatedInviteUrl }}</code>
              <button class="link" @click="copyInviteUrl(lastCreatedInviteUrl)">copy</button>
            </span>
          </div>
          <ul v-if="adminStore.invites.length" class="device-list">
            <li v-for="inv in adminStore.invites" :key="inv.token" class="device invite-row">
              <span class="ua">
                <code class="invite-url">{{ inv.url }}</code>
                <span class="invite-status" :class="`status-${inv.status}`">{{ inv.status }}</span>
                <span v-if="inv.usedByUsername" class="invite-used"> → {{ inv.usedByUsername }}</span>
              </span>
              <span class="last-seen" :title="inv.expiresAt">
                <template v-if="inv.status === 'consumed' && inv.usedAt">used {{ formatRelative(inv.usedAt) }}</template>
                <template v-else-if="inv.expiresAt">expires {{ formatRelative(inv.expiresAt) }}</template>
                <template v-else>no expiry</template>
              </span>
              <button
                v-if="inv.status !== 'consumed'"
                class="link danger"
                :disabled="adminBusy"
                @click="onRevokeInvite(inv)"
              >revoke</button>
              <button
                v-else
                class="link"
                disabled
                title="consumed invites are kept as an audit trail"
              >—</button>
            </li>
          </ul>
          <p v-else-if="adminStore.invitesLoaded" class="muted small">No invites yet.</p>
        </section>

        <!-- ─── Account (sign-in) ──────────────────────────────────────── -->
        <section v-if="showBespoke" id="account" class="section">
          <h2>account</h2>
          <p class="section-desc">
            You can sign in with a passkey, a password, or both. Removing your last
            sign-in method would lock you out, so it's blocked.
          </p>
          <p v-if="passkeyError" class="error inline">{{ passkeyError }}</p>

          <h3 class="subhead">passkeys</h3>
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
                :disabled="!canRemovePasskey || passkeyBusy"
                :title="removePasskeyTitle"
                @click="onRemovePasskey(pk)"
              >remove</button>
            </li>
          </ul>
          <p v-else class="muted small">No passkeys registered.</p>
          <div class="passkey-add">
            <button class="link" :disabled="passkeyBusy" @click="onAddPasskey">add passkey</button>
          </div>

          <h3 class="subhead">password</h3>
          <p v-if="passwordError" class="error inline">{{ passwordError }}</p>
          <p v-if="passwordNotice" class="muted small">{{ passwordNotice }}</p>
          <p v-if="!hasPassword" class="muted small">No password set.</p>
          <p v-else class="muted small">Password is set.</p>
          <form class="password-form" @submit.prevent="onSavePassword">
            <label v-if="hasPassword">
              <span>Current password</span>
              <input v-model="currentPasswordInput" type="password" autocomplete="current-password" />
            </label>
            <label>
              <span>{{ hasPassword ? 'New password' : 'Password' }}</span>
              <input
                v-model="newPasswordInput"
                type="password"
                autocomplete="new-password"
                minlength="8"
              />
            </label>
            <div class="password-actions">
              <button
                class="link"
                type="submit"
                :disabled="passwordBusy || !newPasswordInput || (hasPassword && !currentPasswordInput)"
              >{{ hasPassword ? 'change password' : 'set password' }}</button>
              <button
                v-if="hasPassword"
                type="button"
                class="link danger"
                :disabled="passwordBusy || passkeys.length === 0"
                :title="passkeys.length === 0 ? 'add a passkey before removing your password' : 'remove password'"
                @click="onRemovePassword"
              >remove password</button>
            </div>
          </form>

          <div class="signout-row">
            <button class="link danger" @click="signOut">sign out</button>
          </div>
        </section>
      </main>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useSettingsStore } from '../stores/settings.js';
import { useHighlightRulesStore } from '../stores/highlightRules.js';
import { usePushSubscriptionsStore } from '../stores/pushSubscriptions.js';
import { useAuthStore } from '../stores/auth.js';
import { useAdminStore } from '../stores/admin.js';
import { useSocket } from '../composables/useSocket.js';
import { formatRelative } from '../utils/timestamp.js';
import {
  isSupported as isPushSupported,
  registerSW,
  enable as enablePush,
  disable as disablePush,
  getCurrentEndpoint,
} from '../composables/usePush.js';
import { playHighlightSound } from '../composables/useHighlightNotifier.js';
import { getOption } from '../utils/settingsRegistry.js';

useSocket();

const settings = useSettingsStore();
const rulesStore = useHighlightRulesStore();
const pushSubsStore = usePushSubscriptionsStore();
const auth = useAuthStore();
const adminStore = useAdminStore();
const router = useRouter();

const isAdmin = computed(() => auth.user?.role === 'admin');
const revealedSecrets = ref(new Set());
function toggleSecret(key) {
  const s = new Set(revealedSecrets.value);
  if (s.has(key)) s.delete(key); else s.add(key);
  revealedSecrets.value = s;
}
const adminError = ref('');
const adminBusy = ref(false);
const lastCreatedInviteUrl = ref('');
const search = ref('');
const passkeys = ref([]);
const passkeyError = ref('');
const passkeyBusy = ref(false);
const hasPassword = ref(false);
const passwordError = ref('');
const passwordNotice = ref('');
const passwordBusy = ref(false);
const currentPasswordInput = ref('');
const newPasswordInput = ref('');

const canRemovePasskey = computed(() => {
  // Server blocks removing the last sign-in method. So removing a passkey is
  // safe when there's another passkey, OR when a password exists.
  if (passkeys.value.length > 1) return true;
  return hasPassword.value;
});
const removePasskeyTitle = computed(() => {
  if (canRemovePasskey.value) return 'remove this passkey';
  return 'set a password first — this is your only sign-in method';
});
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

const soundChoices = computed(() => getOption('notifications.highlight.sound.choice')?.choices || []);
const soundEnabled = computed(() => !!settings.effective('notifications.highlight.sound.enabled'));

function onPreviewSound() {
  playHighlightSound();
}

// Live-update volume on drag without spamming the server: the range input's
// `input` event tweaks the local optimistic value, and `change` commits.
function onVolumeInput(raw) {
  const n = Number(raw);
  if (Number.isFinite(n)) settings.values = { ...settings.values, 'notifications.highlight.sound.volume': n };
}

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
  refreshPasswordStatus();
  if (isAdmin.value) {
    adminStore.fetchUsers().catch((e) => { adminError.value = e.message; });
    adminStore.fetchInvites().catch((e) => { adminError.value = e.message; });
  }
});

async function onCreateInvite() {
  adminError.value = '';
  adminBusy.value = true;
  lastCreatedInviteUrl.value = '';
  try {
    const invite = await adminStore.createInvite();
    lastCreatedInviteUrl.value = invite.url;
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(invite.url).catch(() => { /* clipboard is best-effort */ });
    }
  } catch (e) {
    adminError.value = e.message || 'failed to create invite';
  } finally {
    adminBusy.value = false;
  }
}

async function onRevokeInvite(invite) {
  if (!confirm(`Revoke this invite?`)) return;
  adminError.value = '';
  adminBusy.value = true;
  try {
    await adminStore.deleteInvite(invite.token);
  } catch (e) {
    adminError.value = e.message || 'failed to revoke invite';
  } finally {
    adminBusy.value = false;
  }
}

async function onDeleteUser(user) {
  if (!confirm(`Delete user ${user.username}? This is irreversible.`)) return;
  adminError.value = '';
  adminBusy.value = true;
  try {
    await adminStore.deleteUser(user.id);
  } catch (e) {
    adminError.value = e.message || 'failed to delete user';
  } finally {
    adminBusy.value = false;
  }
}

function copyInviteUrl(url) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(url).catch(() => { /* ignore */ });
  }
}

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

async function refreshPasswordStatus() {
  hasPassword.value = await auth.fetchPasswordStatus();
}

async function onSavePassword() {
  passwordError.value = '';
  passwordNotice.value = '';
  if (!newPasswordInput.value) return;
  passwordBusy.value = true;
  try {
    await auth.setPassword({
      password: newPasswordInput.value,
      currentPassword: hasPassword.value ? currentPasswordInput.value : undefined,
    });
    currentPasswordInput.value = '';
    newPasswordInput.value = '';
    await refreshPasswordStatus();
    passwordNotice.value = 'Password saved.';
  } catch (e) {
    passwordError.value = e.message || 'failed to save password';
  } finally {
    passwordBusy.value = false;
  }
}

async function onRemovePassword() {
  if (!confirm('Remove your password? You will only be able to sign in with a passkey.')) return;
  passwordError.value = '';
  passwordNotice.value = '';
  passwordBusy.value = true;
  try {
    await auth.removePassword();
    currentPasswordInput.value = '';
    newPasswordInput.value = '';
    await refreshPasswordStatus();
    passwordNotice.value = 'Password removed.';
  } catch (e) {
    passwordError.value = e.message || 'failed to remove password';
  } finally {
    passwordBusy.value = false;
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

// Category / group titles for the sidebar TOC and subheadings.
const CATEGORY_ORDER = ['uploads', 'away', 'chat', 'appearance'];
const CATEGORY_TITLES = {
  appearance: 'appearance',
  chat: 'chat',
  away: 'away',
  uploads: 'uploads',
};
const GROUP_TITLES = {
  fonts: 'fonts',
  palette: 'colors',
  messages: 'message rows',
  members: 'member prefixes',
  nicks: 'nick coloring',
  layout: 'layout',
  misc: 'misc',
  consolidate: 'join/part consolidation',
  'smart-filter': 'smart filter',
  'auto-away': 'auto-away',
  provider: 'provider',
  pipeline: 'image pipeline',
  catbox: 'catbox.moe',
  hoarder: 'hoarder',
};

const filtersActive = computed(() => !!search.value.trim() || modifiedOnly.value);
const showBespoke = computed(() => !filtersActive.value);

function matchesSearch(opt) {
  const q = search.value.trim().toLowerCase();
  if (!q) return true;
  return opt.key.toLowerCase().includes(q) || (opt.description || '').toLowerCase().includes(q);
}

const visibleCategories = computed(() => {
  const cats = [];
  for (const id of CATEGORY_ORDER) {
    const items = settings.registry.filter((opt) => {
      if (opt.category !== id) return false;
      if (modifiedOnly.value && !settings.isModified(opt.key)) return false;
      return matchesSearch(opt);
    });
    if (!items.length) continue;
    const groupsMap = new Map();
    for (const opt of items) {
      const gid = opt.group || '_';
      if (!groupsMap.has(gid)) groupsMap.set(gid, []);
      groupsMap.get(gid).push(opt);
    }
    const groups = Array.from(groupsMap, ([gid, gItems]) => ({
      id: gid,
      title: GROUP_TITLES[gid] || gid,
      items: gItems,
    }));
    cats.push({ id, title: CATEGORY_TITLES[id], groups });
  }
  return cats;
});

const visibleSections = computed(() => {
  const sections = [];
  if (showBespoke.value) {
    sections.push({ id: 'notifications', title: 'notifications' });
    sections.push({ id: 'highlights', title: 'highlights' });
  }
  for (const cat of visibleCategories.value) {
    sections.push({ id: cat.id, title: cat.title });
  }
  if (showBespoke.value) {
    if (isAdmin.value) sections.push({ id: 'users', title: 'users' });
    sections.push({ id: 'account', title: 'account' });
  }
  return sections;
});

function jumpTo(id) {
  const el = document.getElementById(id);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

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

/* ── Top bar ──────────────────────────────────────────────────────── */
.bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--border);
  flex: 0 0 auto;
}
.bar h1 {
  margin: 0;
  color: var(--fg-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  flex: 0 0 auto;
  font-size: inherit;
  font-weight: 600;
}
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

/* ── Text-button (link-style) ─────────────────────────────────────── */
.link {
  background: none;
  border: none;
  color: var(--accent);
  padding: 2px 6px;
  cursor: pointer;
  font: inherit;
}
.link:hover:not(:disabled) { color: var(--fg); }
.link:disabled { opacity: 0.4; cursor: not-allowed; }
.link.danger { color: var(--bad); }

/* ── Errors and muted placeholders ────────────────────────────────── */
.error {
  color: var(--bad);
  padding: 6px 12px;
  border-bottom: 1px solid var(--border);
  margin: 0;
}
.error.inline { padding: 0 0 6px; border: none; }
.muted {
  color: var(--fg-muted);
  padding: 16px;
  font-style: italic;
}
.muted.small { font-size: 0.95em; padding: 4px 0; font-style: normal; }

/* ── Body: sidebar + scrolling content ───────────────────────────── */
.body {
  flex: 1;
  min-height: 0;
  display: flex;
}
.sidebar {
  flex: 0 0 auto;
  width: 13em;
  border-right: 1px solid var(--border);
  padding: 12px 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.sidebar a {
  color: var(--fg-muted);
  text-decoration: none;
  padding: 4px 16px;
  text-transform: lowercase;
  letter-spacing: 0.04em;
  border-left: 2px solid transparent;
}
.sidebar a:hover {
  color: var(--fg);
  background: var(--bg-soft);
  border-left-color: var(--accent);
}
.content {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
}
@media (max-width: 720px) {
  .sidebar { display: none; }
}

/* ── Section block (used by every section) ───────────────────────── */
.section {
  padding: 16px;
  border-bottom: 1px solid var(--border);
}
/* Cap every direct child at a comfortable reading column so prose,
   lists, forms, and rows all align to the same right edge. */
.section > * { max-width: 70ch; }
.section h2 {
  margin: 0 0 6px;
  color: var(--accent);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-size: 1.05em;
  font-weight: 600;
}
.section .section-desc {
  color: var(--fg-muted);
  margin: 0 0 12px;
}
.section .subhead {
  margin: 18px 0 6px;
  color: var(--fg-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-size: 0.9em;
  font-weight: 600;
}
/* When a subhead immediately follows the section header (no description
   in between), pull it up so the first group hugs the title. */
.section > .subhead:first-of-type { margin-top: 4px; }

/* ── Param row (registry-driven settings) ────────────────────────── */
.rows {
  list-style: none;
  margin: 0;
  padding: 0;
}
.row {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 0 8px 8px;
  border-top: 1px solid var(--border);
  border-left: 2px solid transparent;
}
.row:first-child { border-top: none; }
.row:hover { background: var(--bg-soft); }
.row.modified { border-left-color: var(--warn); }
.row.modified .key { color: var(--warn); }

.head { display: flex; align-items: center; gap: 10px; }
.key { font-weight: 600; color: var(--accent); }
.type {
  color: var(--fg-muted);
  border: 1px solid var(--border);
  padding: 0 4px;
  text-transform: lowercase;
  font-size: 0.85em;
}
.desc { color: var(--fg-muted); }

.editor { margin-top: 2px; }
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
.editor .secret-edit { display: flex; align-items: center; gap: 8px; }
.editor .secret-edit input { flex: 1; }
.editor .secret-edit .reveal { white-space: nowrap; }
.editor .swatch {
  width: 14px;
  height: 14px;
  border: 1px solid var(--border);
  display: inline-block;
}
.default-line { color: var(--fg-muted); font-size: 0.9em; }
.default-line code {
  background: var(--bg-soft);
  padding: 0 4px;
}

/* ── Highlight rule row ──────────────────────────────────────────── */
.rule-list { list-style: none; margin: 0; padding: 0; }
.rule {
  display: grid;
  grid-template-columns: 18px minmax(120px, 1fr) max-content max-content max-content max-content;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  border-top: 1px solid var(--border);
}
.rule:first-child { border-top: none; }
.rule:hover { background: var(--bg-soft); }
.rule.auto .pattern { color: var(--fg-muted); }
.lock { font-size: 12px; color: var(--fg-muted); text-align: center; }
.rule .ck { display: flex; align-items: center; gap: 4px; color: var(--fg-muted); cursor: pointer; }
.rule-add {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-top: 10px;
}
.rule-add input[type="text"] { flex: 1; min-width: 200px; }
.hl-sep {
  border: none;
  border-top: 1px solid var(--border);
  /* Explicit margin-inline:0 overrides the user-agent `margin-inline:auto`
     that would otherwise center the hr within its 70ch cap. */
  margin: 28px 0 22px;
  width: 100%;
}

/* ── Highlight notification controls ─────────────────────────────── */
.hl-notif {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 4px 0 0;
}
.hl-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.hl-row select { min-width: 160px; }
.hl-row input[type="range"] { width: 220px; }
.hl-row--dim { color: var(--fg-muted); }
.hl-label {
  color: var(--fg-muted);
  min-width: 7em;
}
.hl-vol-num {
  color: var(--fg-muted);
  font-variant-numeric: tabular-nums;
  min-width: 2.5em;
  text-align: right;
}

/* ── Compact single-line row (devices, passkeys, users, invites) ── */
.this-client {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 0 10px;
}
.this-label {
  color: var(--fg-muted);
  font-weight: 600;
}
.device-list { list-style: none; margin: 0; padding: 0; }
.device {
  display: grid;
  grid-template-columns: 1fr max-content max-content;
  gap: 12px;
  align-items: center;
  padding: 6px 0;
  border-top: 1px solid var(--border);
}
.device:first-child { border-top: none; }
.device:hover { background: var(--bg-soft); }
.device .ua { color: var(--fg); }
.device .last-seen { color: var(--fg-muted); font-size: 0.95em; }

/* Inline-editable passkey label. */
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
.passkey-add { padding-top: 8px; }

/* ── Password form ──────────────────────────────────────────────── */
.password-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 4px;
  max-width: 360px;
}
.password-form label {
  display: flex;
  flex-direction: column;
  gap: 2px;
  color: var(--fg-muted);
}
.password-form label span {
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-size: 0.85em;
}
.password-actions {
  display: flex;
  gap: 1ch;
  align-items: center;
  margin-top: 2px;
}
.signout-row {
  margin-top: 16px;
  display: flex;
  justify-content: flex-start;
}

/* ── Admin: users + invites ─────────────────────────────────────── */
.user-row .role-tag {
  color: var(--accent);
  border: 1px solid var(--accent);
  padding: 0 4px;
  margin-left: 6px;
  font-size: 0.85em;
  text-transform: uppercase;
}
.invite-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 0 10px;
  flex-wrap: wrap;
}
.invite-fresh {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--fg-muted);
  font-size: 0.95em;
}
.invite-fresh code {
  background: var(--bg-soft);
  padding: 1px 4px;
  word-break: break-all;
}
.invite-row .ua {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.invite-url {
  background: var(--bg-soft);
  padding: 1px 4px;
  word-break: break-all;
  font-size: 0.9em;
}
.invite-status {
  text-transform: uppercase;
  font-size: 0.8em;
  padding: 0 4px;
  border: 1px solid var(--border);
}
.invite-status.status-pending { color: var(--accent); border-color: var(--accent); }
.invite-status.status-consumed { color: var(--fg-muted); }
.invite-status.status-expired { color: var(--bad); border-color: var(--bad); }
.invite-used { color: var(--fg-muted); }
</style>
