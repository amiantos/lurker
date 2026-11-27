// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { defineStore } from 'pinia';
import { api } from '../api.js';
import { REGISTRY, getDefault, getOption } from '../utils/settingsRegistry.js';
import type { SettingValue } from '../../../shared/settingsRegistry.js';
import { useThemesStore } from './themes.js';

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  return false;
}

export const useSettingsStore = defineStore('settings', {
  state: () => ({
    values: {} as Record<string, SettingValue>,
    loaded: false,
    loading: null as Promise<void> | null,
  }),
  getters: {
    registry: () => REGISTRY,
    /**
     * What a key renders as WITHOUT a per-key override: the active theme's
     * value for `themed` keys, the registry default otherwise. Split out from
     * effective() because isModified() compares against this — an override is
     * only a modification relative to what removing it would show.
     */
    baseline() {
      return (key: string): SettingValue | undefined => {
        if (getOption(key)?.themed) {
          const themed = useThemesStore().activeThemeValues?.[key];
          if (themed !== undefined) return themed;
        }
        return getDefault(key);
      };
    },
    effective(state) {
      return (key: string) => (key in state.values ? state.values[key] : this.baseline(key));
    },
    isModified(state) {
      return (key: string) => {
        if (!(key in state.values)) return false;
        // Defensive: stale rows can survive from older versions with a value
        // equal to the baseline. Treat them as unmodified so the UI stays
        // correct. (The server only auto-drops rows for non-themed keys.)
        return !valuesEqual(state.values[key], this.baseline(key));
      };
    },
    /** Themed keys currently overridden away from the active theme — the "(modified)" drift. */
    themeDriftKeys(state): string[] {
      return Object.keys(state.values).filter(
        (key) => getOption(key)?.themed && !valuesEqual(state.values[key], this.baseline(key)),
      );
    },
  },
  actions: {
    async fetchAll() {
      if (this.loading) return this.loading;
      this.loading = (async () => {
        const { values, themes } = await api('/api/settings/bootstrap');
        this.values = { ...values };
        // Saved themes ride the bootstrap so the theme resolver never runs
        // against values whose pointed-at theme is still in flight.
        if (Array.isArray(themes)) useThemesStore().hydrate(themes);
        this.loaded = true;
      })();
      try {
        await this.loading;
        this.syncDetectedTimezone().catch(() => {});
      } finally {
        this.loading = null;
      }
    },
    // The server uses system.timezone when formatting time strings for the
    // user (e.g. the timestamp baked into the auto-away message), and that
    // formatting runs when no client is connected — so the value has to live
    // server-side. Push the browser's current zone on every bootstrap so the
    // setting tracks the user across devices and travel.
    async syncDetectedTimezone() {
      let detected: string | undefined;
      try {
        detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
      } catch {
        return;
      }
      if (!detected) return;
      const current = this.values['system.timezone'];
      if (current === detected) return;
      try {
        await this.setValue('system.timezone', detected);
      } catch {
        // Non-critical — fall through silently.
      }
    },
    async setValue(key: string, value: SettingValue) {
      // A themed key written at exactly its current baseline is "no override" —
      // persist it as a reset, not a row. The row would be invisible everywhere
      // (isModified is baseline-relative) yet spring back as a wrong-theme
      // override the next time the active theme changes under it (mode switch,
      // OS light/dark flip — neither clears overrides; only applying does).
      const opt = getOption(key);
      if (opt?.themed && valuesEqual(value, this.baseline(key))) {
        await this.patchMany({}, [key]);
        return;
      }
      await this.patchMany({ [key]: value });
    },
    /**
     * One PATCH carrying writes and deletions together — applying a theme sets
     * its pointer and clears every themed override atomically.
     */
    async patchMany(changes: Record<string, SettingValue>, resets: string[] = []) {
      const { values } = await api('/api/settings', {
        method: 'PATCH',
        body: { changes, resets },
      });
      this.values = { ...values };
    },
    async reset(key: string) {
      const { values } = await api(`/api/settings/${encodeURIComponent(key)}`, {
        method: 'DELETE',
      });
      this.values = { ...values };
    },
    // The override map restated on a connect snapshot (#1464): a `settings`
    // frame sent while this device was disconnected never arrived, so the
    // snapshot is what catches it up. Only once the bootstrap has LANDED. Before
    // that it answers a question nobody asked yet: the bootstrap brings the
    // saved themes with the values, so the resolver never sees a pointer at a
    // theme still in flight, and values alone here would break that.
    applySnapshot(values: Record<string, SettingValue>) {
      if (!this.loaded) return;
      this.values = { ...values };
    },
    applyRemote({
      changes,
      resets,
    }: {
      changes?: Record<string, SettingValue>;
      resets?: string[];
    }) {
      const next = { ...this.values };
      for (const [key, value] of Object.entries(changes || {})) {
        const def = getDefault(key);
        // A deletion still arrives as { key: default } in `changes` (the frame
        // shape pre-resets clients understand); dropping the local entry keeps
        // this map override-only. Themed keys are exempt — a default-valued
        // override is a real statement under a non-default theme, so only the
        // explicit resets list below may remove those.
        if (!getOption(key)?.themed && def !== undefined && valuesEqual(value, def)) {
          delete next[key];
        } else {
          next[key] = value;
        }
      }
      for (const key of resets || []) delete next[key];
      this.values = next;
    },
  },
});
