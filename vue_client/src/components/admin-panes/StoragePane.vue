<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0

  Storage stats (lurker-dev/RETENTION_PLAN.md §3.4): how much history each
  account holds, what the database file costs on disk, and which retention
  ceilings the deployment declares. Visibility only — the plan deliberately
  ships no per-account quotas, so this pane is how an operator notices
  buffer-farming before designing any automated defense.
-->

<template>
  <section id="admin-storage" class="settings-pane">
    <h2>storage</h2>
    <p class="section-desc">What message history costs on this instance.</p>

    <p v-if="error" class="error inline">{{ error }}</p>
    <p v-else-if="!stats" class="muted small">Loading storage stats…</p>

    <template v-if="stats">
      <ul class="counts">
        <li>database file: {{ formatBytes(stats.database.fileBytes) }}</li>
        <li>write-ahead log: {{ formatBytes(stats.database.walBytes) }}</li>
        <li>
          reclaimable free pages: {{ formatBytes(stats.database.reclaimableBytes) }}
          <span class="muted small">(reused by new writes before the file grows)</span>
        </li>
      </ul>

      <!-- States, not null-guesses: "unset" and "declared but unparseable"
           are different operator situations, and this pane is exactly where
           someone comes to check a ceiling that isn't taking effect. -->
      <p class="muted small">Line ceiling: {{ linesCeilingText }}</p>
      <p class="muted small">Event-noise ceiling: {{ hoursCeilingText }}</p>
      <p class="muted small">Closed-buffer ceiling: {{ daysCeilingText }}</p>

      <h3 class="subhead">per account</h3>
      <p v-if="stats.approxBytesPerRow != null" class="muted small">
        Sizes marked ≈ use this instance's measured average of
        {{ stats.approxBytesPerRow }} bytes per stored line.
      </p>
      <ul class="device-list">
        <li v-for="u in stats.users" :key="u.id" class="device storage-row">
          <span class="who">{{ u.username }}</span>
          <span class="muted small">
            {{ u.messageRows.toLocaleString() }} lines · {{ u.buffers }} buffer(s)
            <template v-if="stats.approxBytesPerRow != null">
              · ≈ {{ formatBytes(u.messageRows * stats.approxBytesPerRow) }}
            </template>
          </span>
        </li>
      </ul>
      <div class="actions">
        <span class="muted small">Refreshed {{ formatDateTime(stats.generatedAt) }}.</span>
        <button :disabled="refreshing" @click="load(true)">
          {{ refreshing ? 'refreshing…' : 'refresh now' }}
        </button>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { api } from '../../api.js';
import { formatBytes } from '../../utils/formatBytes.js';
import { formatDateTime } from '../../utils/timestamp.js';

type CeilingState = 'set' | 'none' | 'invalid';

interface StorageStats {
  generatedAt: string;
  approxBytesPerRow: number | null;
  database: { fileBytes: number; walBytes: number; reclaimableBytes: number };
  ceilings: {
    maxLines: number | null;
    maxLinesState: CeilingState;
    maxEventHours: number | null;
    maxEventHoursState: CeilingState;
    maxClosedBufferDays: number | null;
    maxClosedBufferDaysState: CeilingState;
  };
  users: Array<{ id: number; username: string; messageRows: number; buffers: number }>;
}

const stats = ref<StorageStats | null>(null);
const error = ref('');
const refreshing = ref(false);

async function load(force = false) {
  refreshing.value = force;
  error.value = '';
  try {
    stats.value = await api(`/api/admin/storage${force ? '?refresh=1' : ''}`);
  } catch (e: any) {
    error.value = e.message || 'failed to load storage stats';
  } finally {
    refreshing.value = false;
  }
}
onMounted(() => load());

const linesCeilingText = computed(() => {
  const c = stats.value?.ceilings;
  if (!c) return '';
  if (c.maxLinesState === 'set' && c.maxLines != null) {
    return `${c.maxLines.toLocaleString()} lines per buffer (LURKER_MAX_RETENTION_LINES)`;
  }
  if (c.maxLinesState === 'invalid') {
    return 'LURKER_MAX_RETENTION_LINES is set but unparseable — NOT in effect, see the server log';
  }
  return 'none — history is unbounded for users who set no limit';
});

const hoursCeilingText = computed(() => {
  const c = stats.value?.ceilings;
  if (!c) return '';
  if (c.maxEventHoursState === 'set' && c.maxEventHours != null) {
    return `${c.maxEventHours} hours (LURKER_MAX_EVENT_RETENTION_HOURS)`;
  }
  if (c.maxEventHoursState === 'invalid') {
    return 'LURKER_MAX_EVENT_RETENTION_HOURS is set but unparseable — NOT in effect, see the server log';
  }
  // Not "off": the per-user default (168h) keeps pruning without a ceiling.
  return 'none — users default to pruning event noise after a week';
});

const daysCeilingText = computed(() => {
  const c = stats.value?.ceilings;
  if (!c) return '';
  if (c.maxClosedBufferDaysState === 'set' && c.maxClosedBufferDays != null) {
    return `${c.maxClosedBufferDays} days (LURKER_MAX_CLOSED_BUFFER_DAYS) — closed buffers are collected for everyone`;
  }
  if (c.maxClosedBufferDaysState === 'invalid') {
    return 'LURKER_MAX_CLOSED_BUFFER_DAYS is set but unparseable — NOT in effect, see the server log';
  }
  return 'none — closed buffers are kept unless a user opts in';
});
</script>

<style src="../settings-panes/panes.css"></style>
<style scoped>
.counts {
  list-style: disc;
  padding-left: var(--space-9);
  margin: var(--space-2) 0 var(--space-5);
  color: var(--fg-muted);
}
.storage-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-4);
}
.storage-row .who {
  color: var(--fg);
}
.actions {
  display: flex;
  gap: 1ch;
  align-items: center;
  padding-top: var(--space-3);
}
</style>
