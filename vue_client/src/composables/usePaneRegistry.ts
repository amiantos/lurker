// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Imperative handles onto the mounted BufferPanes, keyed by buffer.
//
// The keyboard shortcuts (type-ahead focus, PageUp/PageDown) and the
// click-anywhere-to-focus-the-input behavior have to reach *a* pane's input and
// message list. With one pane that was a template ref in DesktopChat. With
// several, "which pane" is a question with an answer — the focused one — so the
// shell looks the pane up by the active buffer key instead of holding a ref.
//
// A pane registers on mount and unregisters on unmount. Panes showing the same
// buffer would collide; the last mount wins, which is the same buffer's UI
// either way, so nothing observable turns on it.
export interface PaneApi {
  focusInput: () => void;
  scrollByPage: (dir: number) => void;
}

const panes = new Map<string, PaneApi>();

export function registerPane(key: string | null, api: PaneApi): void {
  if (key) panes.set(key, api);
}

export function unregisterPane(key: string | null, api: PaneApi): void {
  // Identity-checked so a remount that registered the new pane before the old
  // one tore down doesn't have its registration deleted by the old unmount.
  if (key && panes.get(key) === api) panes.delete(key);
}

export function paneFor(key: string | null): PaneApi | null {
  return key ? (panes.get(key) ?? null) : null;
}

export function resetPanes(): void {
  panes.clear();
}
