// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { watchEffect } from 'vue';
import { useRoute } from 'vue-router';
import { useBuffersStore } from '../stores/buffers.js';
import { useNetworksStore } from '../stores/networks.js';
import { useSettingsStore } from '../stores/settings.js';
import { useViewport } from './useViewport.js';
import { pageTitle } from '../lib/pageTitle.js';

// Keep document.title naming the location (#1462). Called once from App.vue,
// which lives as long as the document, so the effect needs no teardown.
//
// The title names the buffer ON SCREEN, which is the route's buffer with two
// exceptions, both places the shells show networks.activeKey instead:
//
//  - A DM opened optimistically has no server id, so no URL: useBufferRoute
//    holds the route on the previous buffer until the id lands, while both
//    shells show the DM (MobileChat's activeLacksId).
//  - The desktop shell shows the active buffer at `/` too. It gets there by
//    Admin's "← back", or by widening a window that sat on the mobile list.
//
// Otherwise NOT activeKey: it lingers on the last-opened buffer while the user
// sits on the mobile buffer list (see useViewedBuffer), and a title naming a
// buffer that isn't on screen would be wrong. The members and thread routes
// carry the same `:id` and so keep their buffer's title.
//
// Reactive on the stores as well as the route, so a cold-start deep link picks
// its title up when the snapshot lands, and a renamed network or a DM whose
// peer changed nick retitles in place.
//
// look.title.buffer_names off keeps every chat page plain "Lurker", for anyone
// who wants channel, DM and network names out of the tab strip and the
// browser's history. Names also wait for the settings to LOAD: until then
// effective() answers the default (on), and a deep link that resolved first
// would flash the name the user turned off. That fails closed: if the settings
// never load, titles stay "Lurker".
export function usePageTitle(): void {
  const route = useRoute();
  const buffers = useBuffersStore();
  const networks = useNetworksStore();
  const settings = useSettingsStore();
  const { isMobile } = useViewport();

  watchEffect(() => {
    const named = settings.loaded && settings.effective('look.title.buffer_names') !== false;
    const raw = route.params.id;
    const id = typeof raw === 'string' && raw !== '' ? Number(raw) : NaN;
    const active = networks.activeKey ? buffers.byKey(networks.activeKey) : null;
    const idless = !!active && active.networkId != null && active.id == null;
    const shown =
      idless || (route.name === 'chat' && !isMobile.value)
        ? active
        : Number.isInteger(id)
          ? buffers.byId(id)
          : null;
    const buffer = named ? shown : null;
    const network = buffer?.networkId != null ? networks.networkById(buffer.networkId) : null;
    document.title = pageTitle(route.name, buffer, network?.name ?? null);
  });
}
