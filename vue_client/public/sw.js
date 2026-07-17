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
  // setAppBadge and clearAppBadge ship together (one NavigatorBadge mixin), so
  // the single feature-detect above covers both. >0 sets the count, 0 clears.
  // Mirrors useAppBadge.applyBadge on the page side — keep the two in lockstep.
  const op =
    data.badge > 0 ? self.navigator.setAppBadge(data.badge) : self.navigator.clearAppBadge();
  return op.catch(() => {});
}

// LEGACY composition, kept only as a fallback (#490 phase 2).
//
// The server composes title/body/tag itself now — it has to, because APNs and FCM
// have no service worker to do it for them — and sends them on the payload. This
// worker prefers those. But a worker cached before that change is still out there
// receiving pushes from a server that already composes, and a server mid-rollback
// may still send a payload without them, so both directions have to keep working.
//
// These functions are a byte-for-byte twin of server/services/notificationContent.ts.
// They become dead code once every client has cycled onto a worker that reads the
// server's fields, at which point both these and the semantic fields on the wire
// can go. Until then: change one, change the other.
function friendOnlineTitle(data) {
  const name = data.displayName || 'A friend';
  const parts = [];
  if (data.target && String(data.target).toLowerCase() !== name.toLowerCase()) {
    parts.push(`as ${data.target}`);
  }
  if (data.networkName) parts.push(data.networkName);
  return `${name} came online${parts.length ? ` (${parts.join(' · ')})` : ''}`;
}

function legacyTitle(data) {
  return data.kind === 'dm'
    ? `${data.nick || 'someone'}${data.networkName ? ' (' + data.networkName + ')' : ''}`
    : data.kind === 'friend_online'
      ? friendOnlineTitle(data)
      : `${data.nick || 'someone'} in ${data.target || ''}`;
}

self.addEventListener('push', (event) => {
  if (!event.data) return;
  let data;
  try {
    data = event.data.json();
  } catch {
    data = { kind: 'unknown', text: event.data.text() };
  }
  // `||` not `??`: an empty title from the server is as useless as a missing one,
  // so fall back on both. Body genuinely may be '' (friend_online has no text),
  // but the legacy expression yields '' there too, so the two agree either way.
  const title = data.title || legacyTitle(data);
  const body = data.body || data.text || '';
  const tag = data.tag || `${data.networkId || 0}::${data.target || ''}`;
  event.waitUntil(
    Promise.all([
      self.registration.showNotification(title, {
        body,
        tag,
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
