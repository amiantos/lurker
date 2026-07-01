// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { defineStore } from 'pinia';
import { socketSend } from '../composables/useSocket.js';

// Per-channel override. One flag is tracked here:
//   notifyAlways — every message in the channel is a notification trigger for
//                  push/toast (without lighting the channel up as a highlight).
// The old display-only `muted` flag was folded into the ignore engine as a
// NOUNREAD/NONOTIFY rule (issue #359) — see the ignores store's bufferMuteRule/
// networkMuteRule and the notification-menu ladders. The server is the source of
// truth: toggles send a WS message and the `channel-notify-changed` echo updates
// state on all the user's tabs.

export interface ChannelNotifyFlags {
  notifyAlways: boolean;
}

export interface ChannelNotifyEntry {
  networkId: number;
  target: string;
}

export const useChannelNotifyStore = defineStore('channelNotify', {
  state: () => ({
    // { [networkId]: { [target]: { notifyAlways } } } — only channels with the
    // flag set live here; absent entries default to off.
    byNetwork: {} as Record<number | string, Record<string, ChannelNotifyFlags>>,
  }),
  getters: {
    notifyAlways: (state) => (networkId: number | string, target: string) =>
      !!state.byNetwork[networkId]?.[target]?.notifyAlways,
    // List of { networkId, target } for all channels that currently have
    // always-notify enabled — used by the Settings panel's "always-notify
    // channels" audit list.
    alwaysNotifyChannels: (state): ChannelNotifyEntry[] => {
      const out: ChannelNotifyEntry[] = [];
      for (const [networkId, byTarget] of Object.entries(state.byNetwork)) {
        for (const [target, flags] of Object.entries(byTarget || {})) {
          if (flags?.notifyAlways) out.push({ networkId: Number(networkId), target });
        }
      }
      return out;
    },
  },
  actions: {
    applySnapshot(networks: any[]) {
      const next: Record<number | string, Record<string, ChannelNotifyFlags>> = {};
      for (const n of networks || []) {
        if (n?.networkId != null) next[n.networkId] = { ...n.channelNotify };
      }
      this.byNetwork = next;
    },
    applyChange(networkId: number | string, target: string, flags: ChannelNotifyFlags) {
      if (!this.byNetwork[networkId]) this.byNetwork[networkId] = {};
      if (flags.notifyAlways) {
        this.byNetwork[networkId][target] = { notifyAlways: true };
      } else {
        // Flag off — drop the entry so it mirrors the server's row delete.
        delete this.byNetwork[networkId][target];
      }
    },
    setNotifyAlways(networkId: number | string, target: string, notifyAlways: boolean) {
      socketSend({ type: 'set-channel-notify-always', networkId, target, notifyAlways });
    },
  },
});
