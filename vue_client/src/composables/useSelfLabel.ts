// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import type { ComputedRef } from 'vue';
import { computed } from 'vue';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useBufferKey } from './useActiveBuffer.js';
import { prefixOf } from '../utils/memberPrefix.js';
import { isChannelTarget } from '../../../shared/channels.js';

export interface SelfLabelState {
  promptLabelNoModes: ComputedRef<string>;
  promptModes: ComputedRef<string>;
  awayLabel: ComputedRef<string>;
}

// Self-identity label used in the input prompt:
//   [channel-prefix][nick](userModes)   e.g.  @bradleyroot(i)
// The nick part (promptLabelNoModes) and the user-mode parens (promptModes) are
// exposed separately so the prompt can accent-colour the nick while muting the
// modes — mirroring the status bar, which colours the channel name but not its
// mode suffix (issue #415). Plus a separate away label like "(brb)" when /away
// is set.
//
// The channel-prefix is the user's own op/voice marker derived from THIS
// buffer's member list. For DMs / server buffers it's empty.
//
// Resolved through useBufferKey(), not networks.activeKey: the prompt renders
// once per composer, and a composer belongs to a pane. Two panes on different
// networks would otherwise both show the focused pane's nick — and its channel
// op marker, so a DM's prompt could wear an `@` borrowed from another channel.
export function useSelfLabel(): SelfLabelState {
  const networks = useNetworksStore();
  const buffers = useBuffersStore();
  const paneKey = useBufferKey();

  const active = computed(() => networks.bufferFor(paneKey.value));
  const buffer = computed(() => (paneKey.value ? buffers.byKey(paneKey.value) : null));

  const channelPrefix = computed(() => {
    const buf = buffer.value;
    if (!buf || buf.networkId == null || !isChannelTarget(buf.target)) return '';
    const nick = networks.states[buf.networkId]?.nick;
    if (!nick) return '';
    const lc = nick.toLowerCase();
    const me = buf.members.find((m) => m.nick.toLowerCase() === lc);
    return prefixOf(me?.modes ?? []);
  });

  // Identity without the trailing user-mode parens. Feeds the mobile input
  // placeholder, which mirrors the compact status bar's choice to drop modes
  // on narrow screens; the desktop prompt renders this plus promptModes.
  const promptLabelNoModes = computed(() => {
    const a = active.value;
    if (!a) return '—';
    const nick = networks.states[a.networkId]?.nick;
    if (!nick) return '—';
    return `${channelPrefix.value}${nick}`;
  });

  // The trailing user-mode parens, kept apart from the nick so the prompt can
  // render them in a muted colour (issue #415). Empty when no modes are set.
  const promptModes = computed(() => {
    const a = active.value;
    if (!a || promptLabelNoModes.value === '—') return '';
    const modes = networks.states[a.networkId]?.userModes || '';
    return modes ? `(${modes})` : '';
  });

  const awayLabel = computed(() => {
    if (!active.value) return '';
    // The server keeps `message` populated after /back so the buffer dividers
    // can render the completed pair — gate on `active` so the label
    // disappears when the user is no longer away.
    const away = networks.states[active.value.networkId]?.away;
    return away?.active && away.message ? `(${away.message})` : '';
  });

  return { promptLabelNoModes, promptModes, awayLabel };
}
