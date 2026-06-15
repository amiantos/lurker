// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Virtual buffers are sidebar-selectable "buffers" that aren't tied to an IRC
// network. They use a flat sentinel key (no `::`) so the usual
// `${networkId}::${target}` parsers ignore them. Today there are two:
//
//   :system:  — the per-user server-lifecycle log. renderMode 'console': its
//               own store (systemLog) + the SystemConsole component, no nicklist
//               or input.
//   :friends: — the cross-network Friends buffer. renderMode 'overview': a
//               bespoke FriendsOverview component (a management pane, not a
//               message feed), no nicklist or input.
//
// renderMode/hasInput/hasNicklist are load-bearing: useActiveBuffer surfaces
// them and the views dispatch the body component + input + member list off
// them, so a future :highlights: buffer is one registry entry plus (if it needs
// a new body) one renderMode branch — not another round of scattered
// `=== ':system:'` checks.

export const SYSTEM_KEY = ':system:';
export const FRIENDS_KEY = ':friends:';

// 'console' — own store + monospace component (system log).
// 'buffer'  — a real Buffer in the buffers store, rendered by MessageList.
// 'overview'— a bespoke component in the message-pane slot (Friends overview).
export type VirtualRenderMode = 'console' | 'buffer' | 'overview';

export interface VirtualBufferConfig {
  key: string;
  label: string;
  renderMode: VirtualRenderMode;
  hasNicklist: boolean;
  hasInput: boolean;
}

export const VIRTUAL_BUFFERS: Readonly<Record<string, VirtualBufferConfig>> = Object.freeze({
  [SYSTEM_KEY]: {
    key: SYSTEM_KEY,
    label: 'System console',
    renderMode: 'console',
    hasNicklist: false,
    hasInput: false,
  },
  [FRIENDS_KEY]: {
    key: FRIENDS_KEY,
    label: 'Friends',
    renderMode: 'overview',
    hasNicklist: false,
    hasInput: false,
  },
});

export function isVirtualKey(key: string | null | undefined): boolean {
  return !!key && Object.prototype.hasOwnProperty.call(VIRTUAL_BUFFERS, key);
}

export function virtualConfig(key: string | null | undefined): VirtualBufferConfig | null {
  return key && isVirtualKey(key) ? VIRTUAL_BUFFERS[key] : null;
}
