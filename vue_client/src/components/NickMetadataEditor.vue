<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<!--
  Metadata the user sets on somebody else (#1449), inside the profile view,
  under the note: what is set, each with Edit and Reset, then "Add metadata" →
  a field → that field's own form. On a network with IRCv3 metadata a value
  here stands in front of the other person's; on one without, it is all there
  is. Nothing changes until the server echoes the save (stores/nickMetadata.ts).
-->

<template>
  <div class="nick-meta">
    <dl v-if="rows.length" class="mine">
      <template v-for="r in rows" :key="r.key">
        <dt>{{ r.label }}</dt>
        <dd :data-key="r.key">
          <span class="value">
            <template v-if="r.key === 'display-name' && r.value">
              <RenderSegments :segments="formattingSegments(r.value)" />
            </template>
            <template v-else-if="r.key === COLOR && r.color">
              <span class="swatch" :style="{ background: r.color }"></span>
              <span :style="{ color: r.color }">{{ nick }}</span>
            </template>
            <template v-else-if="r.key === TZ">{{ r.value }}</template>
            <span v-else class="muted">Hidden</span>
          </span>
          <span class="btn-bar">
            <button v-if="r.key !== 'avatar'" type="button" @click="edit(r.key)">Edit</button>
            <button type="button" @click="store.reset(networkId, nick, r.key)">
              {{ r.theirs ? 'Reset' : 'Remove' }}
            </button>
          </span>
        </dd>
      </template>
    </dl>

    <form v-if="editing" class="editor" @submit.prevent="save">
      <template v-if="editing === 'display-name'">
        <label>
          <span class="title">Display name</span>
          <input
            ref="firstInput"
            :value="draft"
            :maxlength="NAME_MAX"
            autocomplete="off"
            @input="draft = imeSafeValue($event)"
            @keydown.enter="blockImeEnter"
          />
          <small v-if="draft.trim()">
            Shows as <RenderSegments :segments="formattingSegments(draft.trim())" />
          </small>
        </label>
        <div class="actions">
          <button type="submit" class="btn-primary" :disabled="!draft.trim()">Save</button>
          <button v-if="wire?.displayName" type="button" class="btn-secondary" @click="hide">
            Hide theirs
          </button>
          <button type="button" class="btn-secondary" @click="cancel">Cancel</button>
        </div>
      </template>

      <template v-else-if="editing === 'avatar'">
        <p class="muted">A generated tile shows in place of {{ nick }}'s avatar.</p>
        <div class="actions">
          <button type="button" class="btn-primary" @click="hide">Hide avatar</button>
          <button type="button" class="btn-secondary" @click="cancel">Cancel</button>
        </div>
      </template>

      <template v-else-if="editing === COLOR">
        <span class="title">Nick color</span>
        <div class="swatches" role="listbox" aria-label="Nick color">
          <button
            v-for="(c, i) in palette"
            :key="i"
            type="button"
            class="swatch pick"
            role="option"
            :aria-selected="i === currentSlot"
            :class="{ on: i === currentSlot }"
            :style="{ background: c }"
            :title="c"
            @click="pickColor(i)"
          ></button>
        </div>
        <div class="actions">
          <button type="button" class="btn-secondary" @click="cancel">Cancel</button>
        </div>
      </template>

      <template v-else-if="editing === TZ">
        <label>
          <span class="title">Time zone</span>
          <input
            ref="firstInput"
            v-model="draft"
            :list="zonesId"
            placeholder="Europe/Berlin"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
          />
          <datalist :id="zonesId">
            <option v-for="z in zones" :key="z" :value="z"></option>
          </datalist>
          <small v-if="draftZoneTime"> {{ draftZoneTime }} there, {{ localTime }} here </small>
          <small v-else-if="draft.trim()">Not a time zone this browser knows.</small>
        </label>
        <div class="actions">
          <button type="submit" class="btn-primary" :disabled="!draftZoneTime">Save</button>
          <button type="button" class="btn-secondary" @click="cancel">Cancel</button>
        </div>
      </template>
    </form>

    <p v-else-if="picking" class="picker">
      <select ref="fieldSelect" aria-label="Metadata field" @change="onPick">
        <option value="" selected disabled>Choose a field…</option>
        <option v-for="f in addable" :key="f.key" :value="f.key">{{ f.label }}</option>
      </select>
      <button type="button" class="btn-secondary" @click="picking = false">Cancel</button>
    </p>

    <p v-else-if="addable.length" class="meta">
      <button type="button" class="link inline" @click="startAdd">
        <PlusIcon />
        Add metadata
      </button>
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, useId } from 'vue';
import { PlusIcon } from '@lucide/vue';
import RenderSegments from './RenderSegments.vue';
import { useNetworksStore } from '../stores/networks.js';
import { useNickMetadataStore } from '../stores/nickMetadata.js';
import { useSettingsStore } from '../stores/settings.js';
import { useNow } from '../composables/useNow.js';
import { blockImeEnter, imeSafeValue } from '../composables/useImeSafeInput.js';
import { formattingSegments } from '../utils/nickColor.js';
import { is12Hour, knownTimeZones, timeInZone } from '../utils/timeZone.js';
import {
  METADATA_COLOR_KEY as COLOR,
  METADATA_TZ_KEY as TZ,
  METADATA_VALUE_MAX_CHARS,
} from '../../../shared/metadataKeys.js';
import {
  NICK_METADATA_KEYS,
  parseColorSlot,
  type NickMetadataKey,
} from '../../../shared/nickMetadata.js';

const props = defineProps<{ networkId: number; nick: string }>();

const networks = useNetworksStore();
const store = useNickMetadataStore();
const settings = useSettingsStore();
const now = useNow();

const NAME_MAX = METADATA_VALUE_MAX_CHARS['display-name'];
const LABELS: Record<NickMetadataKey, string> = {
  'display-name': 'Display name',
  avatar: 'Avatar',
  [COLOR]: 'Nick color',
  [TZ]: 'Time zone',
};

const mine = computed(() => store.valuesFor(props.networkId, props.nick) ?? {});
// What the other person set themselves: "theirs", for Reset and Hide.
const wire = computed(() => networks.wireMetadataFor(props.networkId, props.nick));
const palette = computed(() => settings.effective('look.nick.colors') as string[]);
const hour12 = computed(() => is12Hour(settings.effective('look.buffer.time_format') as string));

function theirs(key: NickMetadataKey): boolean {
  const w = wire.value;
  if (!w) return false;
  if (key === 'display-name') return !!w.displayName;
  if (key === 'avatar') return w.avatarUrl !== undefined;
  if (key === COLOR) return !!w.color;
  return !!w.tz;
}

const currentSlot = computed(() => {
  const slot = parseColorSlot(mine.value[COLOR]);
  return slot === null || !palette.value.length ? null : slot % palette.value.length;
});

const rows = computed(() =>
  NICK_METADATA_KEYS.filter((key) => Object.hasOwn(mine.value, key)).map((key) => ({
    key,
    label: LABELS[key],
    value: mine.value[key],
    color: key === COLOR && currentSlot.value !== null ? palette.value[currentSlot.value] : null,
    theirs: theirs(key),
  })),
);

// What "Add metadata" offers: the fields not set yet. An avatar can only be
// hidden, so it is offered only when there is one to hide.
const addable = computed(() =>
  NICK_METADATA_KEYS.filter(
    (key) => !Object.hasOwn(mine.value, key) && (key !== 'avatar' || theirs('avatar')),
  ).map((key) => ({ key, label: LABELS[key] })),
);

const picking = ref(false);
const editing = ref<NickMetadataKey | null>(null);
const draft = ref('');
const firstInput = ref<HTMLInputElement | null>(null);
const fieldSelect = ref<HTMLSelectElement | null>(null);
const zonesId = useId();
// Read once per open form: a few hundred names.
const zones = computed(() => (editing.value === TZ ? knownTimeZones() : []));

const draftZoneTime = computed(() => timeInZone(now.value, draft.value.trim(), hour12.value));
const localTime = computed(() =>
  new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    hourCycle: hour12.value ? 'h12' : 'h23',
  }).format(now.value),
);

async function startAdd(): Promise<void> {
  picking.value = true;
  await nextTick();
  fieldSelect.value?.focus();
}

function onPick(e: Event): void {
  const key = (e.target as HTMLSelectElement).value as NickMetadataKey;
  picking.value = false;
  if (key) void edit(key);
}

async function edit(key: NickMetadataKey): Promise<void> {
  editing.value = key;
  // Start from what is set, else from theirs: editing a name usually means fixing it.
  if (key === 'display-name') draft.value = mine.value[key] ?? wire.value?.displayName ?? '';
  else if (key === TZ) draft.value = mine.value[key] ?? wire.value?.tz ?? '';
  else draft.value = '';
  await nextTick();
  firstInput.value?.focus();
}

function cancel(): void {
  editing.value = null;
  picking.value = false;
}

function save(): void {
  const key = editing.value;
  const value = draft.value.trim();
  if (!key || !value) return;
  if (key === TZ && !draftZoneTime.value) return;
  store.set(props.networkId, props.nick, key, value);
  editing.value = null;
}

function hide(): void {
  if (editing.value) store.set(props.networkId, props.nick, editing.value, null);
  editing.value = null;
}

function pickColor(slot: number): void {
  store.set(props.networkId, props.nick, COLOR, String(slot));
  editing.value = null;
}
</script>

<style scoped>
.nick-meta {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
  margin-top: var(--space-4);
}
.mine {
  display: grid;
  grid-template-columns: max-content 1fr;
  column-gap: var(--space-7);
  row-gap: var(--space-3);
  margin: 0;
}
.mine dt {
  color: var(--fg-muted);
  font-weight: 400;
  align-self: center;
}
.mine dd {
  margin: 0;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-5);
}
.value {
  min-width: 0;
  word-break: break-word;
  display: inline-flex;
  align-items: center;
  gap: var(--space-3);
}
.muted {
  color: var(--fg-muted);
}
.swatch {
  display: inline-block;
  width: 1em;
  height: 1em;
  border-radius: var(--radius-sm);
  flex: none;
}
.editor {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
.editor label {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  color: var(--fg-muted);
}
.editor input {
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
.editor p {
  margin: 0;
}
.title {
  color: var(--fg-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.actions,
.picker {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  margin: 0;
}
.picker select {
  flex: 1;
  min-width: 0;
}
.swatches {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
}
.swatch.pick {
  width: 2em;
  height: 2em;
  padding: 0;
  border: 2px solid transparent;
  cursor: pointer;
}
.swatch.pick.on {
  border-color: var(--fg);
}
.swatch.pick:hover {
  border-color: var(--fg-muted);
}
.meta {
  margin: 0;
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
</style>
