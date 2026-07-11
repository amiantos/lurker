// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import type { ComputedRef, InjectionKey, Ref } from 'vue';
import { computed, inject, provide } from 'vue';
import { storeToRefs } from 'pinia';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import {
  FRIENDS_KEY,
  SYSTEM_KEY,
  virtualConfig,
  type VirtualRenderMode,
} from '../lib/virtualBuffers.js';

// Which buffer the surrounding subtree is rendering.
//
// The app has always had exactly one buffer on screen, so MessageList,
// MemberList, StatusBar and MessageInput each reached up and read
// `networks.activeKey` directly. That coupling is what makes them singletons.
// A BufferPane provides its own key here instead, and those components resolve
// "my buffer" through `useBufferKey()` — which falls back to the global
// activeKey when nothing is provided. So an un-provided subtree behaves exactly
// as it did before, and a windowed one renders whatever its pane says.
export const BUFFER_KEY: InjectionKey<Ref<string | null>> = Symbol('lurker:buffer-key');

// Call from a component that owns a buffer's subtree (BufferPane). Pass a ref
// so the pane can repoint at another buffer without remounting the subtree.
export function provideBufferKey(key: Ref<string | null>): void {
  provide(BUFFER_KEY, key);
}

// The buffer key for this subtree, in precedence order: an explicitly passed
// key, the injected one, then the global active buffer. Must be called from
// setup().
//
// The explicit form exists for the component that *provides* the key: Vue
// resolves inject() against the parent's provides, so a pane asking for its own
// key would get the global activeKey it just shadowed.
export function useBufferKey(explicit?: Ref<string | null>): Ref<string | null> {
  if (explicit) return explicit;
  const provided = inject(BUFFER_KEY, null);
  if (provided) return provided;
  return storeToRefs(useNetworksStore()).activeKey;
}

export interface ActiveBufferState {
  // Named `activeKey` for historical reasons — inside a BufferPane this is the
  // pane's buffer, which is only *the* active buffer when the pane is focused.
  activeKey: Ref<string | null>;
  active: ComputedRef<{ networkId: number; target: string; network: unknown } | null>;
  activeBuf: ComputedRef<unknown>;
  topic: ComputedRef<string | undefined>;
  isServerBuffer: ComputedRef<boolean>;
  isChannel: ComputedRef<boolean>;
  bufferLabel: ComputedRef<string>;
  isSystemBuffer: ComputedRef<boolean>;
  isVirtual: ComputedRef<boolean>;
  isFriendsBuffer: ComputedRef<boolean>;
  // Registry-driven capabilities so views dispatch off the virtual-buffer
  // config instead of hard-coding per-key checks. For a real IRC buffer these
  // default to a normal message buffer with input + nicklist.
  renderMode: ComputedRef<VirtualRenderMode>;
  hasInput: ComputedRef<boolean>;
  hasNicklist: ComputedRef<boolean>;
}

export function useActiveBuffer(explicitKey?: Ref<string | null>): ActiveBufferState {
  const networks = useNetworksStore();
  const buffers = useBuffersStore();
  const activeKey = useBufferKey(explicitKey);

  const active = computed(() => networks.bufferFor(activeKey.value));
  const virtualCfg = computed(() => virtualConfig(activeKey.value));
  const isVirtual = computed(() => virtualCfg.value != null);
  const isSystemBuffer = computed(() => activeKey.value === SYSTEM_KEY);
  const isFriendsBuffer = computed(() => activeKey.value === FRIENDS_KEY);
  // A real IRC buffer renders the message list with input + (for channels) a
  // nicklist; virtual buffers declare their own capabilities in the registry.
  const renderMode = computed<VirtualRenderMode>(() => virtualCfg.value?.renderMode ?? 'buffer');
  const hasInput = computed(() => virtualCfg.value?.hasInput ?? true);
  const hasNicklist = computed(() => virtualCfg.value?.hasNicklist ?? true);
  const activeBuf = computed(() => {
    if (!activeKey.value) return null;
    // Only 'buffer'-mode virtual buffers have a Buffer object in the store;
    // 'overview' (friends) renders its own body.
    if (virtualCfg.value && virtualCfg.value.renderMode !== 'buffer') return null;
    return buffers.byKey(activeKey.value);
  });
  const topic = computed(() => (activeBuf.value as any)?.topic);
  const isServerBuffer = computed(() => !!active.value?.target?.startsWith(':server:'));
  const isChannel = computed(() => !!active.value?.target?.startsWith('#'));
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
    isFriendsBuffer,
    renderMode,
    hasInput,
    hasNicklist,
  };
}
