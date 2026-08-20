// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import type { ComputedRef, InjectionKey, Ref } from 'vue';
import { computed, inject, provide } from 'vue';
import { storeToRefs } from 'pinia';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { SYSTEM_KEY, virtualConfig } from '../lib/virtualBuffers.js';
import { isChannelTarget } from '../../../shared/channels.js';

// Which buffer the surrounding subtree is rendering.
//
// The app has always had exactly one buffer on screen, so MessageList,
// MemberList, StatusBar and MessageInput each reached up and read
// `networks.activeKey` directly. That coupling is what makes them singletons.
// A BufferPane provides its own key here instead, and those components resolve
// "my buffer" through `useBufferKey()` — which falls back to the global
// activeKey when nothing is provided. So an un-provided subtree behaves exactly
// as it did before, and a split pane renders whatever its pane says.
export const BUFFER_KEY: InjectionKey<Ref<string | null>> = Symbol('lurker:buffer-key');

// Call from a component that owns a buffer's subtree (BufferPane). Pass a ref
// so the pane can repoint at another buffer without remounting the subtree.
export function provideBufferKey(key: Ref<string | null>): void {
  provide(BUFFER_KEY, key);
}

// The buffer key for this subtree: the provided one, or the global active
// buffer when this component isn't inside a pane. Must be called from setup().
export function useBufferKey(): Ref<string | null> {
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
  // Registry-driven capabilities so views dispatch off the virtual-buffer
  // config instead of hard-coding per-key checks. For a real IRC buffer these
  // default to a normal message buffer with input + nicklist.
  hasInput: ComputedRef<boolean>;
  hasNicklist: ComputedRef<boolean>;
}

// `key` names the buffer to describe. A BufferPane MUST pass its own key
// explicitly: inject() resolves against the PARENT's provides, so a pane asking
// for the injected key would get the global activeKey rather than the one it
// just provided to its own subtree. Everything below the pane omits it and gets
// the provided key, and everything outside a pane omits it and gets activeKey.
export function useActiveBuffer(key?: Ref<string | null>): ActiveBufferState {
  const networks = useNetworksStore();
  const buffers = useBuffersStore();
  const activeKey = key ?? useBufferKey();

  const active = computed(() => networks.bufferFor(activeKey.value));
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
