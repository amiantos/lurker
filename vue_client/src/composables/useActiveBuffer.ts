// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import type { ComputedRef, Ref } from 'vue';
import { computed } from 'vue';
import { storeToRefs } from 'pinia';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { SYSTEM_KEY, virtualConfig } from '../lib/virtualBuffers.js';
import { isChannelTarget } from '../../../shared/channels.js';

export interface ActiveBufferState {
  activeKey: Ref<string | null>;
  active: ComputedRef<{ networkId: number; target: string; network: unknown } | null>;
  activeBuf: ComputedRef<unknown>;
  topic: ComputedRef<string | undefined>;
  isServerBuffer: ComputedRef<boolean>;
  isChannel: ComputedRef<boolean>;
  bufferLabel: ComputedRef<string>;
  isSystemBuffer: ComputedRef<boolean>;
  isVirtual: ComputedRef<boolean>;
  // Registry-driven capabilities so views dispatch off the virtual-buffer
  // config instead of hard-coding per-key checks. For a real IRC buffer these
  // default to a normal message buffer with input + nicklist.
  hasInput: ComputedRef<boolean>;
  hasNicklist: ComputedRef<boolean>;
}

export function useActiveBuffer(): ActiveBufferState {
  const networks = useNetworksStore();
  const buffers = useBuffersStore();
  const { activeKey } = storeToRefs(networks);

  const active = computed(() => networks.activeBuffer);
  const virtualCfg = computed(() => virtualConfig(activeKey.value));
  const isVirtual = computed(() => virtualCfg.value != null);
  const isSystemBuffer = computed(() => activeKey.value === SYSTEM_KEY);
  // A real IRC buffer renders the message list with input + (for channels) a
  // nicklist; virtual buffers declare their own capabilities in the registry.
  const hasInput = computed(() => virtualCfg.value?.hasInput ?? true);
  const hasNicklist = computed(() => virtualCfg.value?.hasNicklist ?? true);
  const activeBuf = computed(() => {
    if (!activeKey.value) return null;
    return buffers.byKey(activeKey.value);
  });
  // Channels show their topic; a DM shows the peer's ident@hostname in the
  // same slot (irssi-style — it's the identity that survives nick changes,
  // and the natural companion to DM renames, #695).
  const topic = computed(() => {
    const buf = activeBuf.value as {
      topic?: string | null;
      kind?: string;
      networkId?: number | null;
      target?: string;
    } | null;
    if (!buf) return undefined;
    if (buf.topic) return buf.topic;
    if (buf.kind === 'dm' && buf.networkId != null && buf.target) {
      return buffers.userhostFor(buf.networkId, buf.target) ?? undefined;
    }
    return buf.topic ?? undefined;
  });
  const isServerBuffer = computed(() => !!active.value?.target?.startsWith(':server:'));
  const isChannel = computed(() => isChannelTarget(active.value?.target));
  const bufferLabel = computed(() => {
    if (virtualCfg.value) return virtualCfg.value.label;
    const t = active.value?.target;
    if (!t) return '';
    if (isServerBuffer.value) return (active.value?.network as any)?.name || 'server';
    return t;
  });

  return {
    activeKey,
    active,
    activeBuf,
    topic,
    isServerBuffer,
    isChannel,
    bufferLabel,
    isSystemBuffer,
    isVirtual,
    hasInput,
    hasNicklist,
  };
}
