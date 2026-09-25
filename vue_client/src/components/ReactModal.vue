<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<!--
  The react picker. Shows what's already on the line and who put it there (the
  only place a touch screen can see that), a row of quick reactions, and a
  field for anything else: an emoji, a :shortcode:, or plain text like "lol",
  which the spec allows and IRC people actually use. Every choice toggles —
  picking a reaction you already gave takes it back.
-->

<template>
  <AppModal word="react" :title="title" size="md" @close="reactions.closePicker()">
    <form class="modal-form" @submit.prevent="submitTyped">
      <div class="body">
        <p v-if="picker.text" class="quote">{{ picker.text }}</p>

        <ul v-if="groups.length" class="standing">
          <li v-for="g in groups" :key="g.value">
            <button
              type="button"
              class="standing-row"
              :class="{ mine: g.mine }"
              :disabled="!canReact"
              @click="choose(g.value)"
            >
              <span class="value">{{ g.value }}</span>
              <span class="who">{{ g.nicks.join(', ') }}</span>
            </button>
          </li>
        </ul>

        <template v-if="canReact">
          <div class="quick">
            <button
              v-for="q in QUICK"
              :key="q"
              type="button"
              class="quick-btn"
              :class="{ mine: mineValues.has(q) }"
              :title="mineValues.has(q) ? `Take back ${q}` : `React ${q}`"
              @click="choose(q)"
            >
              {{ q }}
            </button>
          </div>

          <input
            ref="inputEl"
            :value="typed"
            @input="onTypedInput"
            class="typed"
            type="text"
            placeholder="emoji, :shortcode, or text"
            autocomplete="off"
            spellcheck="false"
          />
          <div v-if="suggestions.length" class="suggestions">
            <button
              v-for="s in suggestions"
              :key="s.name"
              type="button"
              class="quick-btn"
              :title="`:${s.name}:`"
              @click="choose(s.emoji)"
            >
              {{ s.emoji }}
            </button>
          </div>
          <p v-if="tooLong" class="error inline">That's longer than a reaction can be.</p>
        </template>
        <p v-else class="meta">This network can't carry reactions right now.</p>
      </div>
      <footer class="modal-footer">
        <button type="button" class="btn-secondary" @click="reactions.closePicker()">Cancel</button>
        <button v-if="canReact" type="submit" class="btn-primary" :disabled="!typedValue">
          React
        </button>
      </footer>
    </form>
  </AppModal>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import AppModal from './AppModal.vue';
import { useReactionsStore } from '../stores/reactions.js';
import { useNetworksStore } from '../stores/networks.js';
import { useImeSafeInput } from '../composables/useImeSafeInput.js';
import { emojiGlyph, searchEmojiSync } from '../utils/emojiShortcodes.js';
import { emojiFn, preloadEmoji } from '../composables/useEmoji.js';
import { isValidReactionValue } from '../../../shared/reactions.js';

// The usual suspects. Anything else is a keystroke away in the field.
const QUICK = ['👍', '❤️', '😂', '🎉', '😮', '😢', '👀', '🙏'];

const reactions = useReactionsStore();
const networks = useNetworksStore();
const picker = computed(() => reactions.picker);

const title = computed(() => (picker.value.nick ? `react to ${picker.value.nick}` : 'react'));
const groups = computed(() => reactions.groupsFor(picker.value.messageId));
const mineValues = computed(() => new Set(groups.value.filter((g) => g.mine).map((g) => g.value)));

const canReact = computed(() => {
  const id = picker.value.networkId;
  if (id == null) return false;
  const state = networks.states[id];
  return state?.state === 'connected' && !!state.canReact;
});

const typed = ref('');
const onTypedInput = useImeSafeInput(typed);
const inputEl = ref<HTMLInputElement | null>(null);

// A whole-field `:shortcode:` (or `:shortcode` — the closing colon is optional
// here, there's nothing after it to be ambiguous with) sends its glyph.
const typedValue = computed(() => {
  const raw = typed.value.trim();
  if (!raw) return '';
  const m = raw.match(/^:([\w+-]+):?$/);
  if (m) return emojiGlyph(m[1]) ?? raw;
  return raw;
});
const tooLong = computed(() => !!typedValue.value && !isValidReactionValue(typedValue.value));

// Shortcode suggestions while the field reads like one. emojiFn() makes this
// recompute once the lazily-loaded table lands.
const suggestions = computed(() => {
  if (!emojiFn()) return [];
  const m = typed.value.trim().match(/^:([\w+-]{2,})$/);
  return m ? searchEmojiSync(m[1], 16) : [];
});

function choose(value: string) {
  if (picker.value.messageId == null || !isValidReactionValue(value)) return;
  reactions.toggle(picker.value.messageId, value);
  reactions.closePicker();
}

function submitTyped() {
  if (!typedValue.value || tooLong.value) return;
  choose(typedValue.value);
}

onMounted(() => {
  preloadEmoji();
  // Desktop only: a focused field on a phone throws the keyboard over the quick
  // row, which is what most people came for.
  if (window.matchMedia?.('(hover: hover)').matches) inputEl.value?.focus();
});
</script>

<style scoped>
.body {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
  padding-bottom: var(--space-7);
}
.quote {
  margin: 0;
  color: var(--fg-muted);
  border-left: 2px solid var(--border);
  padding-left: var(--space-4);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.standing {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.standing-row {
  display: flex;
  gap: var(--space-4);
  width: 100%;
  text-align: left;
  background: none;
  border: 1px solid transparent;
  color: var(--fg);
  font: inherit;
  padding: var(--space-2) var(--space-3);
  cursor: pointer;
}
.standing-row:hover:not(:disabled) {
  border-color: var(--border);
}
.standing-row.mine .value {
  color: var(--accent);
}
.standing-row .who {
  color: var(--fg-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.quick,
.suggestions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.quick-btn {
  background: var(--bg-soft);
  border: 1px solid var(--border);
  color: var(--fg);
  font: inherit;
  min-width: 2.4em;
  padding: var(--space-2) var(--space-3);
  cursor: pointer;
}
.quick-btn:hover {
  border-color: var(--accent);
}
.quick-btn.mine {
  border-color: var(--accent);
}
.typed {
  background: var(--bg-soft);
  color: var(--fg);
  border: 1px solid var(--border);
  padding: var(--space-3) var(--space-4);
  font: inherit;
}
.typed:focus {
  outline: 1px solid var(--accent);
}
.meta {
  margin: 0;
  color: var(--fg-muted);
}
</style>
