<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: Elastic-2.0
-->

<template>
  <section id="highlights" class="settings-pane">
    <h2>highlights</h2>
    <p class="section-desc">
      Rules whose pattern matches an incoming message mark it as a highlight (line accent + sidebar dot).
      Auto-managed entries track each network's current nick and can only be enabled/disabled.
      Configure notification delivery for matched highlights in the Notifications pane.
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
  </section>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { useHighlightRulesStore } from '../../stores/highlightRules.js';

const rulesStore = useHighlightRulesStore();

const rulesError = ref('');
const newPattern = ref('');
const newKind = ref('plain');
const newCaseSensitive = ref(false);

onMounted(() => {
  if (!rulesStore.loaded) {
    rulesStore.fetchAll().catch((e) => { rulesError.value = e.message; });
  }
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
</script>

<style src="./panes.css"></style>
<style scoped>
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
</style>
