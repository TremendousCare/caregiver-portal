// ─── Caregiver push handlers ───
// Imported into the Workbox-generated service worker (see vite.config.js
// workbox.importScripts). Handles incoming Web Push messages and clicks.
// Kept as a plain script (not a module) because importScripts runs in the
// service worker's classic scope.

/* eslint-disable no-undef */

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (_) {
    payload = { body: event.data ? event.data.text() : '' };
  }

  const title = payload.title || 'Tremendous Care';
  const options = {
    body: payload.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: payload.tag || undefined,
    renotify: Boolean(payload.tag),
    data: { url: payload.url || '/care' },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/care';

  event.waitUntil((async () => {
    const clientList = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true,
    });
    // Focus an already-open caregiver tab if there is one.
    for (const client of clientList) {
      if (client.url.includes('/care') && 'focus' in client) {
        if ('navigate' in client) {
          try { await client.navigate(url); } catch (_) { /* ignore */ }
        }
        return client.focus();
      }
    }
    if (self.clients.openWindow) return self.clients.openWindow(url);
    return undefined;
  })());
});
