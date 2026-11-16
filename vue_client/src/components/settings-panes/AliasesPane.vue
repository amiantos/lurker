<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0

  Command aliases (#276): the list `/alias` prints, editable. A view over the
  same store the command writes through.
-->

<template>
  <section id="aliases" class="settings-pane">
    <h2>aliases</h2>
    <p class="section-desc">
      Commands of your own. An alias runs one or more commands, with what you type after it filled
      in. Also managed with <code>/alias</code>.
    </p>

    <p v-if="formError" class="error inline">{{ formError }}</p>
    <p v-if="loadError" class="error inline">{{ loadError }}</p>

    <p v-if="!store.aliases.length" class="muted small">
      No aliases yet. Add one below, or type <code>/alias wii /whois $1 $1</code> in any buffer.
    </p>
    <ul v-else class="device-list">
      <li v-for="alias in store.aliases" :key="alias.name" class="device">
        <span class="ua">
          <span class="alias-name">/{{ alias.name }}</span>
          <code class="alias-body">{{ alias.body }}</code>
          <span v-if="replaces(alias.name)" class="muted small">
            replaces the /{{ alias.name }} command
          </span>
        </span>
        <div class="row-actions">
          <IconButton :icon="PenIcon" label="edit" @click="startEdit(alias)" />
          <IconButton :icon="TrashIcon" label="remove" danger @click="onRemove(alias)" />
        </div>
      </li>
    </ul>

    <h3 class="subhead">{{ editing ? `edit /${editing}` : 'add alias' }}</h3>
    <form class="alias-form" @submit.prevent="submit">
      <label class="field">
        <span class="field-label">Name</span>
        <input
          :value="name"
          @input="onNameInput"
          @keydown.enter="blockImeEnter"
          type="text"
          :maxlength="ALIAS_NAME_MAX + 1"
          placeholder="wii"
          spellcheck="false"
          autocapitalize="off"
          autocomplete="off"
        />
      </label>
      <label class="field">
        <span class="field-label">Command</span>
        <input
          :value="body"
          @input="onBodyInput"
          @keydown.enter="blockImeEnter"
          type="text"
          placeholder="/whois $1 $1"
          spellcheck="false"
          autocapitalize="off"
          autocomplete="off"
        />
        <span class="muted small">
          <code>;</code> between commands (<code>\;</code> for a real one). <code>$1</code>…<code
            >$9</code
          >
          are the words typed after the alias, <code>$2-</code> the second to the end,
          <code>$*</code> all of them. <code>$channel</code>, <code>$nick</code> and
          <code>$network</code> are where you ran it.
        </span>
      </label>
      <div class="actions">
        <button v-if="editing" class="link" type="button" @click="cancelEdit">cancel</button>
        <button class="link" type="submit" :disabled="!canSubmit || busy">
          {{ editing ? 'save' : 'add alias' }}
        </button>
      </div>
    </form>
  </section>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useAliasesStore } from '../../stores/aliases.js';
import IconButton from '../IconButton.vue';
import { blockImeEnter, useImeSafeInput } from '../../composables/useImeSafeInput.js';
import { resolveVerb } from '../../lib/commands/registry.js';
import {
  ALIAS_NAME_MAX,
  normalizeAliasBody,
  normalizeAliasName,
  type Alias,
} from '../../../../shared/aliases.js';
import { PenIcon, TrashIcon } from '@lucide/vue';

const store = useAliasesStore();

const loadError = ref('');
onMounted(() => {
  if (!store.loaded) {
    store.fetchAll().catch((e: any) => {
      loadError.value = e.message || 'failed to load aliases';
    });
  }
});

/** An alias of this name runs in place of a command Lurker has. */
const replaces = (aliasName: string): boolean => resolveVerb(aliasName) !== null;

// The name of the alias being edited, as it is stored; null while adding.
const editing = ref<string | null>(null);
const name = ref('');
const body = ref('');
const onNameInput = useImeSafeInput(name);
const onBodyInput = useImeSafeInput(body);
const formError = ref('');
const busy = ref(false);

const canSubmit = computed(() => !!name.value.trim() && !!body.value.trim());

function startEdit(alias: Alias) {
  editing.value = alias.name;
  name.value = alias.name;
  body.value = alias.body;
  formError.value = '';
}

function cancelEdit() {
  editing.value = null;
  name.value = '';
  body.value = '';
  formError.value = '';
}

async function submit() {
  if (!canSubmit.value || busy.value) return;
  // Checked here with the server's own rules, so the message is immediate.
  const checkedName = normalizeAliasName(name.value);
  if (!checkedName.ok) {
    formError.value = checkedName.error;
    return;
  }
  const checkedBody = normalizeAliasBody(body.value);
  if (!checkedBody.ok) {
    formError.value = checkedBody.error;
    return;
  }
  // `/alias name body` replaces; a form that did would lose an alias to a typo.
  if (checkedName.name !== editing.value && store.find(checkedName.name)) {
    formError.value = `there is already an alias called /${checkedName.name}`;
    return;
  }
  formError.value = '';
  busy.value = true;
  try {
    if (editing.value) {
      await store.update(editing.value, { name: checkedName.name, body: checkedBody.body });
    } else {
      await store.set(checkedName.name, checkedBody.body);
    }
    cancelEdit();
  } catch (e: any) {
    formError.value = e.message || 'save failed';
  } finally {
    busy.value = false;
  }
}

async function onRemove(alias: Alias) {
  if (editing.value === alias.name) cancelEdit();
  formError.value = '';
  try {
    await store.remove(alias.name);
  } catch (e: any) {
    formError.value = e.message || 'delete failed';
  }
}
</script>

<style src="./panes.css"></style>
<style scoped>
.device .ua {
  min-width: 0;
  overflow-wrap: anywhere;
}
.alias-name {
  color: var(--accent);
}
.alias-body {
  color: var(--fg);
}
.alias-form {
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
.alias-form input[type='text'] {
  background: var(--bg-soft);
  color: var(--fg);
  border: 1px solid var(--border);
  padding: var(--space-2) var(--space-3);
  font: inherit;
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-4);
  padding-top: var(--space-2);
}
</style>
