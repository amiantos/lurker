// Caint service worker — handles Web Push delivery and notification clicks.
// The server has already gated by presence (no push fires when any of the
// user's clients are visible), so this worker just renders whatever arrives.

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  if (!event.data) return;
  let data;
  try {
    data = event.data.json();
  } catch {
    data = { kind: 'unknown', text: event.data.text() };
  }
  const title = data.kind === 'dm'
    ? `${data.nick || 'someone'}${data.networkName ? ' (' + data.networkName + ')' : ''}`
    : `${data.nick || 'someone'} in ${data.target || ''}`;
  event.waitUntil(self.registration.showNotification(title, {
    body: data.text || '',
    tag: `${data.networkId || 0}::${data.target || ''}`,
    data,
    icon: '/caint-icon.svg',
    badge: '/caint-icon.svg',
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const { networkId, target, messageId } = data;
  event.waitUntil((async () => {
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
  })());
});
