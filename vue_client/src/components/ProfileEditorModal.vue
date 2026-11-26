<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<!--
  Your own IRCv3 metadata on one network (#1189): what Lurker saves and sets
  again after every connect. The slash commands (/displayname, /avatar,
  /metadata) write the same rows; this is the view of them. Upload sends an
  image through the user's uploader, cropped square, and fills the avatar
  field with its link. Save saves what
  changed, and what's shown from the server but not saved yet, and sets what
  the server lacks. Clear unsets every saved key. It opens only on a connected
  network that carries metadata; one that drops while it's open greys it.
-->

<template>
  <AppModal word="profile" :title="`profile on ${networkName}`" size="sm" @close="close">
    <form class="modal-form" @submit.prevent="save">
      <div class="profile-form">
        <div class="fields">
          <label>
            <span class="title">Display name</span>
            <input
              :disabled="locked"
              :value="form['display-name']"
              @input="form['display-name'] = imeSafeValue($event)"
              @keydown.enter="blockImeEnter"
              :maxlength="max('display-name')"
              autocomplete="off"
            />
            <small v-if="form['display-name']">
              Shows as <RenderSegments :segments="displayNameSegments" />
            </small>
          </label>
          <label>
            <span class="title">Avatar URL</span>
            <div class="avatar-row">
              <img v-if="preview" class="avatar" :src="preview" alt="" />
              <input
                :disabled="locked"
                :value="form.avatar"
                @input="form.avatar = imeSafeValue($event)"
                @keydown.enter="blockImeEnter"
                inputmode="url"
                :maxlength="max('avatar')"
                placeholder="https://…/me.png"
                autocomplete="off"
              />
              <button
                type="button"
                class="btn-secondary"
                :disabled="locked || uploading || !auth.canUpload"
                :title="auth.canUpload ? '' : auth.uploadsOffTitle"
                @click="fileInput?.click()"
              >
                {{ uploading ? 'Uploading…' : 'Upload…' }}
              </button>
              <input
                ref="fileInput"
                type="file"
                accept="image/*"
                class="file-input"
                @change="onPicked"
              />
            </div>
            <small v-if="avatarsUnavailable" class="no-avatars">
              To display avatars, you need <code>lurker-previews</code>.
            </small>
          </label>
          <label>
            <span class="title">Pronouns</span>
            <input
              :disabled="locked"
              :value="form.pronouns"
              @input="form.pronouns = imeSafeValue($event)"
              @keydown.enter="blockImeEnter"
              :maxlength="max('pronouns')"
              autocomplete="off"
            />
          </label>
          <label>
            <span class="title">Homepage</span>
            <input
              :disabled="locked"
              :value="form.homepage"
              @input="form.homepage = imeSafeValue($event)"
              @keydown.enter="blockImeEnter"
              inputmode="url"
              :maxlength="max('homepage')"
              placeholder="https://…"
              autocomplete="off"
            />
          </label>
          <label>
            <span class="title">Status</span>
            <input
              :disabled="locked"
              :value="form.status"
              @input="form.status = imeSafeValue($event)"
              @keydown.enter="blockImeEnter"
              :maxlength="max('status')"
              autocomplete="off"
            />
          </label>
          <!-- Not a <label>: it would hand a click on the title to the swatch. -->
          <div class="field">
            <span class="title">Nick color</span>
            <div class="avatar-row">
              <button
                ref="swatchEl"
                type="button"
                class="swatch"
                :style="{ background: pickedColor ?? 'transparent' }"
                :disabled="locked"
                title="pick a color"
                aria-label="pick a color"
                :aria-expanded="pickerOpen"
                @click="pickerOpen = true"
              ></button>
              <input
                :disabled="locked"
                :value="form.color"
                @input="form.color = imeSafeValue($event)"
                @keydown.enter="blockImeEnter"
                :maxlength="max('color')"
                placeholder="#rrggbb"
                aria-label="Nick color"
                autocomplete="off"
                autocapitalize="off"
                spellcheck="false"
              />
            </div>
            <!-- Nobody paints the colour as sent (#1452): each client keeps its
                 hue and fits the rest to its own theme, this one included. -->
            <small v-if="shownAs">
              Shows as <span class="swatch chip" :style="{ background: shownAs }"></span> in this
              theme.
            </small>
            <small v-else-if="form.color.trim()">Not a color: use #rrggbb.</small>
            <ColorPicker
              v-if="pickerOpen"
              :value="pickedColor ?? ''"
              :anchor="swatchEl"
              @commit="onColorPicked"
              @close="pickerOpen = false"
            />
          </div>
          <label>
            <span class="title">Time zone</span>
            <div class="avatar-row">
              <input
                :disabled="locked"
                :value="form[TZ]"
                @input="form[TZ] = imeSafeValue($event)"
                @keydown.enter="blockImeEnter"
                :list="zonesId"
                :maxlength="max(TZ)"
                placeholder="Europe/Berlin"
                autocomplete="off"
                autocapitalize="off"
                spellcheck="false"
              />
              <!-- Asked for, never assumed: a zone says roughly where you are. -->
              <button
                type="button"
                class="btn-secondary"
                :disabled="locked || !deviceZone"
                @click="form[TZ] = deviceZone ?? ''"
              >
                Use this device's
              </button>
            </div>
            <datalist :id="zonesId">
              <option v-for="z in zoneOptions" :key="z" :value="z"></option>
            </datalist>
            <small v-if="zoneTime">{{ zoneTime }} there now.</small>
            <small v-else-if="form[TZ].trim()">Not a time zone this browser knows.</small>
          </label>
          <label v-if="otherNetworks.length">
            <span class="title">Copy from</span>
            <select
              :disabled="locked"
              :value="''"
              @change="copyFrom(($event.target as HTMLSelectElement).value)"
            >
              <option value="" disabled>another network…</option>
              <option v-for="net in otherNetworks" :key="net.id" :value="String(net.id)">
                {{ net.name }}
              </option>
            </select>
          </label>
        </div>
        <p v-if="limitsText" class="meta">{{ limitsText }}</p>
        <p v-if="error" class="error">{{ error }}</p>
      </div>
      <footer class="modal-footer">
        <button type="button" class="btn-secondary" @click="close">Cancel</button>
        <button
          type="button"
          class="btn-secondary danger"
          :disabled="!!refusal || saving || loading"
          @click="clearAll"
        >
          Clear
        </button>
        <button
          type="submit"
          class="btn-primary"
          :disabled="!dirty || invalid || !!refusal || saving || uploading"
        >
          Save
        </button>
      </footer>
    </form>
  </AppModal>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, useId } from 'vue';
import AppModal from './AppModal.vue';
import ColorPicker from './ColorPicker.vue';
import RenderSegments from './RenderSegments.vue';
import { useNetworksStore } from '../stores/networks.js';
import { useUploadsStore } from '../stores/uploads.js';
import { useAuthStore } from '../stores/auth.js';
import { useConfigStore } from '../stores/config.js';
import { useProfileEditor } from '../composables/useProfileEditor.js';
import { blockImeEnter, imeSafeValue } from '../composables/useImeSafeInput.js';
import { useNickColors } from '../composables/useNickColors.js';
import { useNow } from '../composables/useNow.js';
import { useSettingsStore } from '../stores/settings.js';
import { formattingSegments } from '../utils/nickColor.js';
import {
  deviceTimeZone,
  is12Hour,
  knownTimeZones,
  timeInZone,
  zonesBut,
} from '../utils/timeZone.js';
import { toHex } from '../lib/color.js';
import { resolveCssColor } from '../lib/cssColor.js';
import { ownMetadataRefusal } from '../lib/commands/metadata.js';
import {
  clearOwnMetadata,
  fetchOwnMetadata,
  saveOwnMetadata,
  type OwnMetadata,
} from '../utils/ownMetadata.js';
import {
  METADATA_EXTRA_VALUE_MAX_CHARS,
  METADATA_SUB_KEYS,
  METADATA_TZ_KEY as TZ,
  METADATA_VALUE_MAX_CHARS,
  normalizeMetadataColor,
} from '../../../shared/metadataKeys.js';

const props = defineProps<{ networkId: number }>();

// The keys Lurker shows; the template names each.
type Field =
  | 'display-name'
  | 'avatar'
  | 'pronouns'
  | 'homepage'
  | 'status'
  | 'color'
  | 'lurker.chat/tz';
const FIELDS = METADATA_SUB_KEYS as Field[];

const networks = useNetworksStore();
const uploads = useUploadsStore();
const auth = useAuthStore();
const config = useConfigStore();
const editor = useProfileEditor();

// Avatars other people set reach this client through the previews decoder
// (avatarProxy.ts), so without one every avatar here is a generated tile, the
// user's own included. Said only once /api/config has answered: the flag
// defaults to off, and a failed fetch isn't the server saying so.
const avatarsUnavailable = computed(() => config.checked && !config.linkPreviews);

const form = reactive<Record<Field, string>>(blank());
const initial = ref<Record<Field, string>>(blank());
// Keys with a saved row (a value or an unset); the rest show the server's.
const savedKeys = ref(new Set<string>());
// The saved avatar, and how other people's clients fetch it (the media proxy).
const savedAvatar = ref('');
const avatarPreview = ref<string | null>(null);
// The last upload: its link, and its thumb, which is of the crop.
const uploaded = ref<{ url: string; thumb: string } | null>(null);
const uploading = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);
const loading = ref(true);
const saving = ref(false);
const error = ref('');

const networkName = computed(
  () => networks.networks.find((n) => n.id === props.networkId)?.name ?? 'network',
);
const netState = computed(() => networks.states[props.networkId]);
const refusal = computed(() => ownMetadataRefusal(netState.value));
const otherNetworks = computed(() => networks.networks.filter((n) => n.id !== props.networkId));
const displayNameSegments = computed(() => formattingSegments(form['display-name']));
// What the field's link shows as, where Lurker knows: an upload's thumb, or
// the saved avatar. A typed link isn't fetched just to preview it.
const preview = computed(() => {
  const url = form.avatar.trim();
  if (uploaded.value && url === uploaded.value.url) return uploaded.value.thumb;
  return url && url === savedAvatar.value ? avatarPreview.value : null;
});
const locked = computed(() => !!refusal.value || loading.value);

// The colour (#1452): a free pick, published as #rrggbb. `shownAs` is what
// this theme makes of it, which is all anyone ever sees of it.
const nicks = useNickColors();
const settings = useSettingsStore();
const pickerOpen = ref(false);
const swatchEl = ref<HTMLElement | null>(null);
const pickedColor = computed(() => normalizeMetadataColor(form.color));
const shownAs = computed(() => nicks.adapted(pickedColor.value));
// The picker can hand back anything CSS takes (a theme reference); the wire takes hex.
function onColorPicked(value: string): void {
  const rgb = resolveCssColor(value, document.body);
  form.color = rgb ? toHex(rgb) : value;
}

// The time zone (#1450).
const now = useNow();
const zonesId = useId();
const zones = knownTimeZones();
// Without the zone already in the field: Chrome would keep offering it, alone,
// under the field it was just picked into.
const zoneOptions = computed(() => zonesBut(zones, form[TZ]));
const deviceZone = deviceTimeZone();
const zoneTime = computed(() =>
  timeInZone(
    now.value,
    form[TZ].trim(),
    is12Hour(settings.effective('look.buffer.time_format') as string),
  ),
);
// A value the server would drop is not sent: Save waits for a real one.
const invalid = computed(
  () => (!!form.color.trim() && !pickedColor.value) || (!!form[TZ].trim() && !zoneTime.value),
);
const dirty = computed(() => FIELDS.some((f) => form[f].trim() !== initial.value[f]));

const limitsText = computed(() => {
  const limits = netState.value?.metadataLimits;
  if (!limits || refusal.value) return '';
  const parts: string[] = [];
  if (limits.maxKeys) parts.push(`${limits.maxKeys} keys`);
  if (limits.maxValueBytes) parts.push(`${limits.maxValueBytes} bytes a value`);
  return parts.length ? `This server allows ${parts.join(', ')}.` : '';
});

function blank(): Record<Field, string> {
  return Object.fromEntries(FIELDS.map((f) => [f, ''])) as Record<Field, string>;
}

function max(field: Field): number {
  return METADATA_VALUE_MAX_CHARS[field] ?? METADATA_EXTRA_VALUE_MAX_CHARS;
}

// A saved key wins, a saved unset included; one never saved shows what the
// server has now (set from another client), so saving keeps it.
function shown(data: OwnMetadata): Record<Field, string> {
  const next = blank();
  for (const f of FIELDS) {
    next[f] = data.unset.includes(f) ? '' : (data.values[f] ?? data.live?.[f] ?? '');
  }
  return next;
}

function fill(data: OwnMetadata): void {
  const next = shown(data);
  savedKeys.value = new Set([...Object.keys(data.values), ...data.unset]);
  initial.value = next;
  Object.assign(form, next);
  savedAvatar.value = data.values.avatar ?? '';
  avatarPreview.value = data.avatarPreview;
}

async function copyFrom(id: string): Promise<void> {
  error.value = '';
  try {
    Object.assign(form, shown(await fetchOwnMetadata(Number(id))));
  } catch (e) {
    error.value = `Couldn't read that network's profile: ${(e as Error).message}`;
  }
}

async function onPicked(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  uploading.value = true;
  error.value = '';
  try {
    const result = await uploads.upload(file, file.name, { avatar: true });
    if (!result) {
      error.value = 'Another upload is still going; try again when it finishes.';
      return;
    }
    uploaded.value = {
      url: result.url,
      thumb: result.thumbnail_url || `/api/uploads/${result.id}/thumb`,
    };
    form.avatar = result.url;
  } catch (e) {
    error.value = `Upload failed: ${(e as Error).message}`;
  } finally {
    uploading.value = false;
  }
}

async function save(): Promise<void> {
  if (!dirty.value || refusal.value) return;
  // What changed, and what's shown from the server but not saved yet (kept by
  // saving). A saved field left alone isn't sent: another client may have
  // changed it since this opened.
  const values: Record<string, string | null> = {};
  for (const f of FIELDS) {
    // A colour goes out in the one spelling every client reads.
    const value = (f === 'color' && normalizeMetadataColor(form[f])) || form[f].trim();
    if (value !== initial.value[f] || (value && !savedKeys.value.has(f))) values[f] = value || null;
  }
  saving.value = true;
  error.value = '';
  try {
    fill(await saveOwnMetadata(props.networkId, values));
    close();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    saving.value = false;
  }
}

// Every saved key unset, here and on the server, the ones this form doesn't
// show (set by /metadata or a bouncer client) included.
async function clearAll(): Promise<void> {
  saving.value = true;
  error.value = '';
  try {
    await clearOwnMetadata(props.networkId);
    close();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    saving.value = false;
  }
}

function close(): void {
  editor.close();
}

onMounted(async () => {
  try {
    fill(await fetchOwnMetadata(props.networkId));
  } catch (e) {
    error.value = `Couldn't load your profile: ${(e as Error).message}`;
  } finally {
    loading.value = false;
  }
});
</script>

<style scoped>
.profile-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  margin: 0 calc(-1 * var(--card-pad-x));
  padding: 0 var(--card-pad-x) var(--space-7);
}
.fields {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}
label {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  color: var(--fg-muted);
}
.field {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  color: var(--fg-muted);
}
.field input {
  color: var(--fg);
  width: 100%;
  box-sizing: border-box;
}
/* The time zone field's suggestion list is the browser's own (a datalist),
   and Chrome draws a drop-down arrow inside the field for it. Typing already
   opens the list, so the arrow goes. */
input[list]::-webkit-calendar-picker-indicator {
  display: none !important;
}
.field small {
  color: var(--fg-muted);
}
.swatch {
  width: 1.3em;
  height: 1.3em;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  display: inline-block;
  cursor: pointer;
  flex: none;
}
.swatch:disabled {
  cursor: not-allowed;
}
.swatch.chip {
  width: 0.9em;
  height: 0.9em;
  cursor: default;
  vertical-align: middle;
}
.title {
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
label input,
label select {
  color: var(--fg);
  width: 100%;
  box-sizing: border-box;
}
label small {
  color: var(--fg-muted);
}
.avatar-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}
.avatar-row input:not(.file-input) {
  flex: 1;
  min-width: 0;
}
.avatar-row button {
  flex: none;
}
.file-input {
  display: none;
}
.avatar {
  width: 2.5em;
  height: 2.5em;
  object-fit: cover;
  flex: none;
}
.meta {
  margin: 0;
  color: var(--fg-muted);
}
.error {
  margin: 0;
  color: var(--bad);
}
</style>
