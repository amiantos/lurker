// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Tab registry for the dedicated admin panel (Milestone 4). This is the single
// source of truth for what the admin sidebar shows and, by id, which pane
// component renders — mirroring shared/settingsRegistry's CATEGORIES, but kept
// local to the client since admin tabs are all bespoke panes (no registry-driven
// settings rows) and instance-scoped rather than per-user.
//
// The panel ships with Users and Invites — the instance management that lives in
// Settings today, relocated here. The commented entries below are the known
// incoming domains; each becomes a live tab by adding its ADMIN_TABS row and a
// pane in views/Admin.vue's component map, no other wiring:
//   - capabilities      — per-user feature grants the admin toggles (e.g. DCC)
//   - moderation        — upload takedowns / abuse review
//
// `uploaders` is the tab #299 penciled in as "instance defaults": the instance's
// configured uploaders, which one new accounts inherit, and whether users may
// define their own (#514).

export interface AdminTab {
  /** URL slug (/admin/:id) and the key into the pane component map. */
  id: string;
  /** Sidebar label. */
  label: string;
}

export const ADMIN_TABS: readonly AdminTab[] = Object.freeze([
  { id: 'users', label: 'Users' },
  { id: 'invites', label: 'Invites' },
  { id: 'uploaders', label: 'Uploaders' },
  { id: 'networks', label: 'Networks' },
  // { id: 'capabilities', label: 'Capabilities' },
  // { id: 'moderation', label: 'Moderation' },
]);

/** The first (default) tab id — where bare /admin lands. */
export const DEFAULT_ADMIN_TAB = ADMIN_TABS[0].id;

/** Whether `id` names a real admin tab. */
export function isAdminTab(id: string | undefined): boolean {
  return !!id && ADMIN_TABS.some((t) => t.id === id);
}
