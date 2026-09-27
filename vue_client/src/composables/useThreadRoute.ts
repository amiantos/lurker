// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { computed, type ComputedRef } from 'vue';
import { useRoute, type Router } from 'vue-router';

// The reply thread the URL names (`/buffer/:id/thread/:root`), for the shells
// that swap their message list for the thread view. The buffer itself is
// activated by useBufferRoute exactly as for `/buffer/:id` — its routeId()
// reads the same `:id` — so this only says which thread, and which reply to
// bring into view (`?focus=<message id>`, set when a reply's quote was clicked).

export interface ThreadRoute {
  bufferId: number;
  rootMsgid: string;
  focusId: number | null;
}

export function useThreadRoute(): ComputedRef<ThreadRoute | null> {
  const route = useRoute();
  return computed(() => {
    if (route.name !== 'buffer-thread') return null;
    const id = Number(route.params.id);
    const root = route.params.root;
    if (!Number.isInteger(id) || typeof root !== 'string' || !root) return null;
    const focus = Number(route.query.focus);
    return {
      bufferId: id,
      rootMsgid: root,
      focusId: Number.isInteger(focus) && focus > 0 ? focus : null,
    };
  });
}

/** Open a thread's view — a navigation of its own, so Back returns to where
 *  the user was. `focusId` is the reply to bring into view. */
export function pushThread(
  router: Router,
  bufferId: number,
  rootMsgid: string,
  focusId?: number | null,
): void {
  void router.push({
    name: 'buffer-thread',
    params: { id: String(bufferId), root: rootMsgid },
    query: focusId ? { focus: String(focusId) } : {},
  });
}
