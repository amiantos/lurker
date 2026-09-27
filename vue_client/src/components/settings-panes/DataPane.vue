<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <section id="data" class="settings-pane">
    <h2>data</h2>
    <p class="section-desc">
      Move your account between Lurker instances. The export contains your settings, networks, and
      channels; message history is optional. The import side restores into a fresh account on
      another instance.
    </p>

    <h3 class="subhead">export</h3>
    <p v-if="exportError" class="error inline">{{ exportError }}</p>
    <p v-if="!preview" class="muted small">Loading data summary…</p>
    <div v-else>
      <ul class="counts">
        <li>{{ preview.settingsOnly.networks || 0 }} network(s)</li>
        <li>{{ totalSmallRows }} small rows (settings, highlights, ignores, drafts, etc.)</li>
        <li v-if="preview.withMessages.messages > 0">
          {{ preview.withMessages.messages.toLocaleString() }} message(s) available with history
        </li>
      </ul>
      <label class="opt">
        <input type="checkbox" v-model="includeMessages" :disabled="isBuilding" />
        Include message history ({{ preview.withMessages.messages.toLocaleString() }})
      </label>

      <!-- Building: large exports run in the background; progress arrives over
           the WebSocket. -->
      <div v-if="isBuilding" class="export-state">
        <p class="muted small">Preparing your export… {{ progressLabel }}</p>
      </div>

      <!-- Ready: the artifact is on the server; download it from the
           authenticated, resumable endpoint. -->
      <div v-else-if="readyJob" class="export-state">
        <p class="muted small">
          Export ready — {{ formatBytes(readyJob.byteSize || 0)
          }}<span v-if="readyJob.includeMessages"> with message history</span>{{ expiryNote }}.
        </p>
        <div class="actions">
          <a class="link" :href="`/api/exports/${readyJob.id}/download`">download .lurk</a>
          <button class="link" @click="onStart">rebuild</button>
        </div>
      </div>

      <!-- Idle / after a failure: offer to (re)start. -->
      <div v-else class="actions">
        <button class="link" @click="onStart">prepare export</button>
      </div>

      <p v-if="failedJob" class="error inline">
        Export failed: {{ failedJob.error || 'unknown error' }}.
      </p>
    </div>

    <hr class="hl-sep" />

    <h3 class="subhead">import</h3>
    <p class="section-desc">
      Imports replace nothing — the target account must be empty. Sign in to the new instance as a
      fresh user, then drop the .zip file here.
    </p>
    <p v-if="tooLargeMessage" class="error inline">{{ tooLargeMessage }}</p>
    <p v-if="importError" class="error inline">{{ importError }}</p>
    <p v-if="importNotice" class="muted small">{{ importNotice }}</p>

    <div v-if="!chosenFile" class="picker">
      <input ref="fileInputEl" type="file" accept=".lurk,.zip" @change="onFileChosen" />
    </div>
    <div v-else class="chosen">
      <div class="chosen-row">
        <span class="filename">{{ chosenFile.name }}</span>
        <span class="muted small">({{ formatBytes(chosenFile.size) }})</span>
      </div>
      <div class="actions">
        <button class="link" :disabled="importing || !confirmed || tooLarge" @click="onImport">
          {{ importing ? `importing… ${progress}%` : 'import' }}
        </button>
        <button v-if="!importing" class="link danger" @click="onCancelFile">cancel</button>
      </div>
      <label v-if="!importing && !importNotice" class="opt">
        <input type="checkbox" v-model="confirmed" />
        I understand this will populate my empty account with the imported data.
      </label>
    </div>

    <hr class="hl-sep" />

    <!-- Retention (lurker-dev/RETENTION_PLAN.md). Preset selects rather than
         raw number fields: deletion is permanent, and a preset list can't
         fat-finger 50 where 5000 was meant. Presets above the instance
         ceiling are hidden; a stored custom value renders as its own option
         so the pane never shows something that isn't true. Custom values go
         through /set, per-buffer overrides through /retention. -->
    <h3 class="subhead">retention</h3>
    <p v-if="ceilingNote" class="muted small">{{ ceilingNote }}</p>
    <p v-if="retError" class="error inline">{{ retError }}</p>

    <div class="ret-row">
      <label for="ret-lines">History limit (lines per buffer)</label>
      <p class="muted small">
        Oldest lines beyond the limit are deleted permanently — bookmarked messages are never
        deleted, and reply threads are kept together, up to twice the limit. Export first if you
        want an archive. Per-buffer: type /retention in any buffer.
      </p>
      <div class="editor-line">
        <select
          id="ret-lines"
          :key="retTick"
          :value="String(linesValue)"
          @change="
            onRetentionChange('data.retention.lines', ($event.target as HTMLSelectElement).value)
          "
        >
          <option v-for="p in linePresets" :key="p.value" :value="String(p.value)">
            {{ p.label }}
          </option>
        </select>
        <span v-if="linesHint" class="muted small">{{ linesHint }}</span>
      </div>
    </div>

    <div class="ret-row">
      <label for="ret-hours">Event noise age limit</label>
      <p class="muted small">
        Joins, parts, quits, nick and mode changes, MOTDs older than this are deleted permanently,
        regardless of the line limit.
      </p>
      <div class="editor-line">
        <select
          id="ret-hours"
          :key="retTick"
          :value="String(hoursValue)"
          @change="
            onRetentionChange(
              'data.retention.event_hours',
              ($event.target as HTMLSelectElement).value,
            )
          "
        >
          <option v-for="p in hourPresets" :key="p.value" :value="String(p.value)">
            {{ p.label }}
          </option>
        </select>
      </div>
    </div>

    <div class="ret-row">
      <label for="ret-days">Delete closed buffers after</label>
      <p class="muted small">
        A buffer closed for longer than this is deleted entirely, history included. Buffers
        containing a bookmarked message are never deleted.
      </p>
      <div class="editor-line">
        <select
          id="ret-days"
          :key="retTick"
          :value="String(daysValue)"
          @change="
            onRetentionChange(
              'data.retention.closed_buffer_days',
              ($event.target as HTMLSelectElement).value,
            )
          "
        >
          <option v-for="p in dayPresets" :key="p.value" :value="String(p.value)">
            {{ p.label }}
          </option>
        </select>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { api, apiMultipart } from '../../api.js';
import { resetSession } from '../../composables/useSessionReset.js';
import { useDataExportStore } from '../../stores/dataExport.js';
import { useSettingsStore } from '../../stores/settings.js';

interface ExportPreview {
  settingsOnly: Record<string, number>;
  withMessages: { messages: number };
  // The largest archive this instance can actually receive — the 500 MB limit,
  // lowered to whatever proxy sits in front of it (#649).
  maxImportBytes?: number;
}

const router = useRouter();

const preview = ref<ExportPreview | null>(null);
const exportError = ref('');
const includeMessages = ref(false);

// Background-export job state, kept live by `export` WS events (see useSocket).
const exportStore = useDataExportStore();
const job = computed(() => exportStore.job);
const isBuilding = computed(
  () => job.value?.status === 'pending' || job.value?.status === 'running',
);
const readyJob = computed(() => (job.value?.status === 'done' ? job.value : null));
const failedJob = computed(() => (job.value?.status === 'error' ? job.value : null));
const progressLabel = computed(() => {
  const j = job.value;
  if (!j) return '';
  if (j.includeMessages && j.total > 0) {
    const pct = Math.min(100, Math.round((j.processed / j.total) * 100));
    return `${j.processed.toLocaleString()} / ${j.total.toLocaleString()} messages (${pct}%)`;
  }
  return 'almost done';
});
const expiryNote = computed(() => {
  const iso = readyJob.value?.expiresAt;
  if (!iso) return '';
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const hours = Math.round(ms / (60 * 60 * 1000));
  return hours >= 1 ? `, expires in ~${hours}h` : ', expires soon';
});

const fileInputEl = ref<HTMLInputElement | null>(null);
const chosenFile = ref<File | null>(null);
const importError = ref('');
const importNotice = ref('');
const importing = ref(false);
const progress = ref(0);
const confirmed = ref(false);

// An archive this instance can't receive (#649). Derived, not set once at pick
// time: `preview` arrives asynchronously while the file input is already
// interactive, so a file chosen before it lands would otherwise disable the
// import button with no explanation of why — a dead end whose only exit is
// cancel. As a computed, the message appears the moment the cap is known.
//
// A cap we never learned (the preview fetch failed) means no client-side gate,
// which is a graceful degradation rather than a hole: the server enforces the
// same number and now answers with a real 413 naming it (#649) instead of the
// edge reset that made this worth pre-flighting in the first place.
const tooLarge = computed(() => {
  const cap = preview.value?.maxImportBytes;
  return Boolean(cap && chosenFile.value && chosenFile.value.size > cap);
});
const tooLargeMessage = computed(() =>
  tooLarge.value
    ? `This archive is ${formatBytes(chosenFile.value!.size)}, but this instance can ` +
      `only accept ${formatBytes(preview.value!.maxImportBytes!)}. Uploading it would ` +
      `fail partway through.`
    : '',
);

// `users` is always 1 (the row representing the caller); excluding it so a
// brand-new account with no real activity reads as 0 small rows instead of 1.
const SMALL_ROW_EXCLUDE = new Set(['networks', 'messages', 'user_bookmarks', 'users']);
const totalSmallRows = computed(() => {
  if (!preview.value) return 0;
  const s = preview.value.settingsOnly;
  return Object.entries(s)
    .filter(([t]) => !SMALL_ROW_EXCLUDE.has(t))
    .reduce((acc, [, n]) => acc + (n || 0), 0);
});

onMounted(async () => {
  try {
    preview.value = await api('/api/exports/preview');
  } catch (e: any) {
    exportError.value = e.message || 'failed to load export preview';
  }
  // Restore any in-flight or ready export so the pane reflects reality on load
  // (WS events keep it current after this).
  try {
    const res = await api('/api/exports/latest');
    if (res.job) exportStore.apply(res.job);
  } catch {
    /* non-fatal — the pane just starts in the idle state */
  }
});

async function onStart() {
  exportError.value = '';
  try {
    const res = await api('/api/exports', {
      method: 'POST',
      body: { include_messages: includeMessages.value },
    });
    exportStore.apply(res.job);
  } catch (e: any) {
    exportError.value = e.message || 'failed to start export';
  }
}

function onFileChosen(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) return;
  chosenFile.value = f;
  importError.value = '';
  importNotice.value = '';
  confirmed.value = false;
  // The over-limit warning is NOT set here — see tooLargeMessage. It has to
  // survive `preview` landing after the file was picked.
}

function onCancelFile() {
  chosenFile.value = null;
  importError.value = '';
  importNotice.value = '';
  confirmed.value = false;
  if (fileInputEl.value) fileInputEl.value.value = '';
}

async function onImport() {
  if (!chosenFile.value || importing.value) return;
  importing.value = true;
  importError.value = '';
  importNotice.value = '';
  progress.value = 0;
  try {
    const fd = new FormData();
    fd.append('archive', chosenFile.value, chosenFile.value.name);
    const result = await apiMultipart('/api/imports', fd, {
      onProgress: (p) => {
        progress.value = p;
      },
    });
    const counts = result.counts || {};
    const summary = [
      `${counts.networks || 0} network(s)`,
      `${(counts.messages || 0).toLocaleString()} message(s)`,
    ].join(', ');
    importNotice.value = `Imported ${summary}. Reloading…`;
    // Wipe stores so the post-reset bootstrap rehydrates from the server.
    resetSession();
    setTimeout(() => {
      router.replace('/');
      window.location.reload();
    }, 800);
  } catch (e: any) {
    importError.value = e.message || 'import failed';
  } finally {
    importing.value = false;
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// ─── Retention ─────────────────────────────────────────────────────────────

const settings = useSettingsStore();
const limits = ref<{
  maxLines: number | null;
  maxEventHours: number | null;
  maxClosedBufferDays: number | null;
} | null>(null);
onMounted(async () => {
  try {
    limits.value = await api('/api/retention/limits');
  } catch {
    /* no ceilings shown; the server still enforces them */
  }
});

const ceilingNote = computed(() => {
  const l = limits.value;
  if (!l) return '';
  const parts: string[] = [];
  if (l.maxLines != null) parts.push(`${l.maxLines.toLocaleString()} lines per buffer`);
  if (l.maxEventHours != null) parts.push(`${l.maxEventHours} hours of event noise`);
  const sentences: string[] = [];
  if (parts.length) sentences.push(`This server keeps at most ${parts.join(' and ')}.`);
  if (l.maxClosedBufferDays != null) {
    sentences.push(`Closed buffers are deleted after at most ${l.maxClosedBufferDays} days.`);
  }
  return sentences.join(' ');
});

// ~281 bytes/line all-in (row + indexes + search index), measured on the
// reference database — mental math for the preset labels, not a promise.
const BYTES_PER_LINE = 281;

const LINE_PRESETS = [0, 1_000, 5_000, 10_000, 25_000, 50_000, 100_000];
const HOUR_PRESETS = [0, 24, 72, 168, 720];
const DAY_PRESETS = [0, 7, 30, 90, 365];

const linesValue = computed(() => Number(settings.effective('data.retention.lines') ?? 0));
const hoursValue = computed(() => Number(settings.effective('data.retention.event_hours') ?? 168));
const daysValue = computed(() =>
  Number(settings.effective('data.retention.closed_buffer_days') ?? 0),
);

// Every label must say what will actually HAPPEN, ceiling included: the
// server clamps a stored 0 (and any over-ceiling value) TO the ceiling, so
// "Unlimited" under a ceiling is a lie — the 0 option relabels to say the
// ceiling applies, and an over-ceiling custom value says what it's capped to.
function presetList(
  presets: number[],
  current: number,
  ceiling: number | null,
  label: (v: number) => string,
  ceilingLabel: (ceiling: number) => string,
): Array<{ value: number; label: string }> {
  const name = (v: number) => {
    if (ceiling != null && v === 0) return ceilingLabel(ceiling);
    if (ceiling != null && v > ceiling) return `${label(v)} — capped at ${label(ceiling)}`;
    return label(v);
  };
  const list = presets
    .filter((v) => ceiling == null || v <= ceiling)
    .map((v) => ({ value: v, label: name(v) }));
  if (!list.some((p) => p.value === current)) {
    list.push({ value: current, label: `${name(current)} (custom)` });
    list.sort((a, b) => (a.value === 0 ? -1 : b.value === 0 ? 1 : a.value - b.value));
  }
  return list;
}

const linePresets = computed(() =>
  presetList(
    LINE_PRESETS,
    linesValue.value,
    limits.value?.maxLines ?? null,
    (v) => (v === 0 ? 'Unlimited' : `${v.toLocaleString()} lines`),
    (c) => `Server maximum (${c.toLocaleString()} lines)`,
  ),
);
const hourPresets = computed(() =>
  presetList(
    HOUR_PRESETS,
    hoursValue.value,
    limits.value?.maxEventHours ?? null,
    (v) =>
      v === 0
        ? 'Keep as long as messages'
        : v === 24
          ? '1 day'
          : v === 72
            ? '3 days'
            : v === 168
              ? '1 week'
              : v === 720
                ? '30 days'
                : `${v} hours`,
    (c) => `Server maximum (${c} hours)`,
  ),
);
const dayPresets = computed(() =>
  presetList(
    DAY_PRESETS,
    daysValue.value,
    limits.value?.maxClosedBufferDays ?? null,
    (v) =>
      v === 0
        ? 'Never'
        : v === 7
          ? '1 week'
          : v === 30
            ? '30 days'
            : v === 90
              ? '90 days'
              : v === 365
                ? '1 year'
                : `${v} days`,
    (c) => `Server maximum (${c} days)`,
  ),
);

const linesHint = computed(() => {
  if (linesValue.value <= 0) return '';
  const mb = (linesValue.value * BYTES_PER_LINE) / 1_000_000;
  return `≈ ${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB per full buffer`;
});

const retError = ref('');
// Bumped on a FAILED write: the bound value never changed, so Vue would skip
// the DOM patch and the select would keep displaying the unsaved (and
// destructive-looking) choice. The :key change forces the element to rebuild
// at the stored value.
const retTick = ref(0);

async function onRetentionChange(key: string, raw: string) {
  const n = Number(raw);
  if (!Number.isInteger(n)) return;
  retError.value = '';
  try {
    await settings.setValue(key, n);
  } catch (e: any) {
    retError.value = e.message || 'failed to save — the stored value is unchanged';
    retTick.value++;
  }
}
</script>

<style src="./panes.css"></style>
<style scoped>
.counts {
  list-style: disc;
  padding-left: var(--space-9);
  margin: var(--space-2) 0 var(--space-5);
  color: var(--fg-muted);
}
.counts li {
  padding: var(--space-1) 0;
}

.opt {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-3) 0;
}

.actions {
  display: flex;
  gap: 1ch;
  align-items: center;
  padding-top: var(--space-3);
}

.export-state {
  padding-top: var(--space-3);
}

.picker {
  padding-top: var(--space-3);
}
.chosen-row {
  display: flex;
  align-items: center;
  gap: var(--space-6);
  padding: var(--space-3) 0;
}
.chosen-row .filename {
  color: var(--fg);
}

.ret-row {
  padding: var(--space-3) 0;
}
.ret-row label {
  color: var(--fg);
}
.ret-row .editor-line {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding-top: var(--space-2);
}
</style>
