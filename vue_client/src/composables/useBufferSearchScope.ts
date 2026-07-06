// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { computed, ref } from 'vue';
import { useActiveBuffer } from './useActiveBuffer.js';
import { useSearchStore } from '../stores/search.js';

// Shared open-state and per-buffer scoping for the Search & Highlights modals,
// used by both the desktop and mobile chat shells (#496). Each shell owns one
// instance (the refs are per-call, not module-level) so the two layouts don't
// share modal visibility. The filter grammar (`in:<target> on:<network>`) lives
// here so it can't drift between the shells.
export function useBufferSearchScope() {
  const { active, isServerBuffer, isSystemBuffer } = useActiveBuffer();

  const showSearch = ref(false);
  const showHighlights = ref(false);
  const searchScope = ref<string | null>(null);
  const highlightScope = ref<string | null>(null);

  // Per-buffer scope for search & highlights: `in:<target> on:<network>`,
  // mirroring the topic bar's scoped buttons. The `on:` token is dropped when
  // the network name has whitespace (the filter parser splits tokens on spaces,
  // so it couldn't round-trip); `in:<target>` alone still scopes by
  // channel/nick. Null for server/system buffers, which have no per-buffer
  // scope.
  const bufferScope = computed<string | null>(() => {
    const a = active.value;
    if (!a || isServerBuffer.value || isSystemBuffer.value || !a.target) return null;
    const netName = (a.network as { name?: string } | null)?.name;
    const onTok = netName && !/\s/.test(netName) ? ` on:${netName}` : '';
    return `in:${a.target}${onTok}`;
  });

  // Topic-bar buttons pass scoped=true so the modal opens pre-filtered to this
  // buffer; the global entry points (sidebar foot / buffer-list top bar /
  // keyboard shortcut) pass false. Both share one modal instance — the scope
  // ref is what differentiates the two entries.
  function openSearch(scoped: boolean): void {
    searchScope.value = scoped ? bufferScope.value : null;
    showSearch.value = true;
  }
  function openHighlights(scoped: boolean): void {
    highlightScope.value = scoped ? bufferScope.value : null;
    showHighlights.value = true;
  }

  // "View activity" from the Friends overview: open Search with the scoped query
  // (from:<nick> on:<network>) and run it immediately.
  function onViewActivity(query: string): void {
    useSearchStore().runQuery(query);
    searchScope.value = null;
    showSearch.value = true;
  }

  return {
    showSearch,
    showHighlights,
    searchScope,
    highlightScope,
    openSearch,
    openHighlights,
    onViewActivity,
  };
}
