// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Lurker service worker — handles Web Push delivery and notification clicks.
// The server has already gated by presence (no push fires when any of the
// user's clients are visible), so this worker just renders whatever arrives.

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Reflect the user's unread-highlight total on the PWA app icon (#451). The
// server stamps `data.badge` on every push, so the badge stays current even
// while the app is fully closed — the case the in-page watcher can't reach.
// Feature-detected (Badging API is absent on many browsers) and best-effort:
// returns a promise so the caller can fold it into the push event's waitUntil.
function syncAppBadge(data) {
  if (typeof data?.badge !== 'number' || !('setAppBadge' in self.navigator)) {
    return Promise.resolve();
  }
  const p =
    data.badge > 0
      ? self.navigator.setAppBadge(data.badge)
      : 'clearAppBadge' in self.navigator
        ? self.navigator.clearAppBadge()
        : Promise.resolve();
  return Promise.resolve(p).catch(() => {});
}

// "Amiantos came online (as nostimo · Libera)". The nick (data.target) is
// shown only when it differs from the display name — for a friend watched under
// several nicks it says which identity signed on; the network disambiguates a
// friend watched across networks.
function friendOnlineTitle(data) {
  const name = data.displayName || 'A friend';
  const parts = [];
  if (data.target && String(data.target).toLowerCase() !== name.toLowerCase()) {
    parts.push(`as ${data.target}`);
  }
  if (data.networkName) parts.push(data.networkName);
  return `${name} came online${parts.length ? ` (${parts.join(' · ')})` : ''}`;
}

self.addEventListener('push', (event) => {
  if (!event.data) return;
  let data;
  try {
    data = event.data.json();
  } catch {
    data = { kind: 'unknown', text: event.data.text() };
  }
  const title =
    data.kind === 'dm'
      ? `${data.nick || 'someone'}${data.networkName ? ' (' + data.networkName + ')' : ''}`
      : data.kind === 'friend_online'
        ? friendOnlineTitle(data)
        : `${data.nick || 'someone'} in ${data.target || ''}`;
  event.waitUntil(
    Promise.all([
      self.registration.showNotification(title, {
        body: data.text || '',
        tag: `${data.networkId || 0}::${data.target || ''}`,
        data,
        icon: '/lurker-icon-192.png',
        badge: '/lurker-icon-192.png',
      }),
      syncAppBadge(data),
    ]),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const { networkId, target, messageId } = data;
  event.waitUntil(
    (async () => {
      const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of list) {
        if (client.url.includes(self.registration.scope.replace(/\/$/, ''))) {
          client.focus();
          client.postMessage({ kind: 'jump', networkId, target, messageId });
          return;
        }
      }
      if (self.clients.openWindow) {
        const params = new URLSearchParams();
        if (networkId != null) params.set('net', String(networkId));
        if (target != null) params.set('buf', String(target));
        if (messageId != null) params.set('msg', String(messageId));
        const url = `/?${params.toString()}`;
        await self.clients.openWindow(url);
      }
    })(),
  );
});
