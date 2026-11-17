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
//   - moderation        — upload takedowns / abuse review
//
// Per-user grants live with the feature they grant: DCC's are on the DCC tab,
// beside the instance's DCC settings. A generic grants tab waits for a second
// feature that needs one.
//
// `uploaders` is the tab #299 penciled in as "instance defaults": the instance's
// configured uploaders, which one new accounts inherit, and whether users may
// define their own (#514).

export interface AdminTab {
  /** URL slug (/admin/:id) and the key into the pane component map. */
  id: string;
  /** Sidebar label. */
  label: string;
  /** Hidden in the hosted (node) edition, where the feature doesn't exist. */
  selfHostedOnly?: boolean;
}

export const ADMIN_TABS: readonly AdminTab[] = Object.freeze([
  { id: 'users', label: 'Users' },
  { id: 'invites', label: 'Invites' },
  { id: 'uploaders', label: 'Uploaders' },
  { id: 'networks', label: 'Networks' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'storage', label: 'Storage' },
  { id: 'lockouts', label: 'Lockouts' },
  // Instance-wide settings with no pane of their own (#527).
  { id: 'general', label: 'General' },
  // Who gets DCC chat and receiving, and the instance's DCC settings (#1080).
  { id: 'dcc', label: 'DCC', selfHostedOnly: true },
  // { id: 'moderation', label: 'Moderation' },
]);

/** The tabs this edition shows. */
export function visibleAdminTabs(isNode: boolean): readonly AdminTab[] {
  return ADMIN_TABS.filter((t) => !(isNode && t.selfHostedOnly));
}

/** The first (default) tab id — where bare /admin lands. */
export const DEFAULT_ADMIN_TAB = ADMIN_TABS[0].id;

/** Whether `id` names an admin tab this edition shows. */
export function isAdminTab(id: string | undefined, isNode = false): boolean {
  return !!id && visibleAdminTabs(isNode).some((t) => t.id === id);
}
