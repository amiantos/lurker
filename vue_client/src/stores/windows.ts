// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { defineStore } from 'pinia';

// Windowed-buffer geometry and stacking, for the mIRC-style canvas
// (look.layout.windowed). One entry per open window, keyed by buffer.
//
// Deliberately client-only and un-persisted for now: this is a prototype, and
// where a window sits is a property of a screen, not of an account. Persisting
// it means deciding what happens when the same account opens a second browser
// at a different size, which is a real design question and not this layer's.
//
// Coordinates are pixels relative to the canvas's top-left, not the viewport,
// so the canvas can be positioned however the shell likes.
export type WindowState = 'normal' | 'minimized' | 'maximized';

export interface BufferWindow {
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  state: WindowState;
  // Geometry to restore to when un-maximizing. Captured at maximize time.
  restore: { x: number; y: number; w: number; h: number } | null;
}

const DEFAULT_W = 640;
const DEFAULT_H = 420;
const MIN_W = 260;
const MIN_H = 160;
// New windows step down-right from the origin so a fresh one never lands
// exactly on the last, then wrap before they march off the canvas.
const CASCADE_STEP = 28;
const CASCADE_WRAP = 8;

export const useWindowsStore = defineStore('windows', {
  state: () => ({
    // Array order IS stacking order: last element is on top. Focusing moves a
    // window to the end and renumbers, which keeps z dense (1..N) rather than
    // monotonically increasing. That matters because the frames render at
    // `calc(var(--z-window) + z)` — a counter that climbed with every click
    // would eventually cross --z-modal and paint windows over modals.
    windows: [] as BufferWindow[],
    // How many windows have been opened, for cascade placement.
    opened: 0,
  }),
  getters: {
    byKey: (state) => (key: string) => state.windows.find((w) => w.key === key) ?? null,
    isOpen: (state) => (key: string) => state.windows.some((w) => w.key === key),
    // Windows that should render a pane. A minimized window keeps its geometry
    // but unmounts its BufferPane — with no virtualized message list, keeping a
    // hidden pane mounted would cost a full DOM tree per minimized buffer.
    visible: (state) => state.windows.filter((w) => w.state !== 'minimized'),
    minimized: (state) => state.windows.filter((w) => w.state === 'minimized'),
    // Topmost visible window: the one the shortcuts and stray clicks act on.
    focusedKey(state): string | null {
      for (let i = state.windows.length - 1; i >= 0; i--) {
        const w = state.windows[i];
        if (w.state !== 'minimized') return w.key;
      }
      return null;
    },
  },
  actions: {
    // Open (or focus, if already open) a window for a buffer. Returns it.
    open(key: string): BufferWindow {
      const existing = this.byKey(key);
      if (existing) {
        if (existing.state === 'minimized') existing.state = 'normal';
        this.focus(key);
        return existing;
      }
      const step = this.opened % CASCADE_WRAP;
      const win: BufferWindow = {
        key,
        x: CASCADE_STEP * step,
        y: CASCADE_STEP * step,
        w: DEFAULT_W,
        h: DEFAULT_H,
        z: this.windows.length + 1,
        state: 'normal',
        restore: null,
      };
      this.opened += 1;
      this.windows.push(win);
      return win;
    },
    close(key: string): void {
      const idx = this.windows.findIndex((w) => w.key === key);
      if (idx >= 0) this.windows.splice(idx, 1);
      this.renumber();
    },
    focus(key: string): void {
      const idx = this.windows.findIndex((w) => w.key === key);
      // Already on top — don't dirty the store on every click.
      if (idx < 0 || idx === this.windows.length - 1) return;
      const [win] = this.windows.splice(idx, 1);
      this.windows.push(win);
      this.renumber();
    },
    renumber(): void {
      this.windows.forEach((w, i) => {
        w.z = i + 1;
      });
    },
    move(key: string, x: number, y: number): void {
      const win = this.byKey(key);
      if (!win || win.state === 'maximized') return;
      win.x = x;
      win.y = y;
    },
    resize(key: string, w: number, h: number): void {
      const win = this.byKey(key);
      if (!win || win.state === 'maximized') return;
      win.w = Math.max(MIN_W, w);
      win.h = Math.max(MIN_H, h);
    },
    minimize(key: string): void {
      const win = this.byKey(key);
      if (win) win.state = 'minimized';
    },
    // Toggle: maximized -> normal, anything else -> maximized. Stashes the
    // pre-maximize geometry so restore puts it back where the user left it.
    toggleMaximize(key: string): void {
      const win = this.byKey(key);
      if (!win) return;
      if (win.state === 'maximized') {
        if (win.restore) Object.assign(win, win.restore);
        win.restore = null;
        win.state = 'normal';
      } else {
        if (win.state === 'normal') win.restore = { x: win.x, y: win.y, w: win.w, h: win.h };
        win.state = 'maximized';
      }
      this.focus(key);
    },
    restore(key: string): void {
      const win = this.byKey(key);
      if (!win) return;
      if (win.state === 'maximized' && win.restore) {
        Object.assign(win, win.restore);
        win.restore = null;
      }
      win.state = 'normal';
      this.focus(key);
    },
    // Keep windows reachable when the canvas shrinks: clamp origins so at least
    // a strip of titlebar stays grabbable inside the new bounds. Not a re-tile —
    // a window the user placed deliberately should stay where they put it.
    clampTo(width: number, height: number): void {
      const GRAB = 80;
      for (const win of this.windows) {
        win.x = Math.max(0, Math.min(win.x, Math.max(0, width - GRAB)));
        win.y = Math.max(0, Math.min(win.y, Math.max(0, height - GRAB)));
      }
    },
  },
});

export const WINDOW_MIN_W = MIN_W;
export const WINDOW_MIN_H = MIN_H;
