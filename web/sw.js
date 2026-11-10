// Service worker: shows push alerts. No offline caching (the dashboard is live data).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let d = { title: 'Van Heater', body: '', kind: 'alarm' };
  try { d = { ...d, ...event.data.json() }; } catch {}
  const alarm = d.kind === 'alarm';
  event.waitUntil(self.registration.showNotification(d.title, {
    body: d.body,
    icon: 'icon-192.png', badge: 'icon-192.png',
    tag: 'dh-' + (d.rule || d.kind),            // same rule replaces its previous notification
    renotify: alarm,
    requireInteraction: alarm,
    vibrate: alarm ? [400, 150, 400, 150, 800] : [100],
    actions: alarm ? [{ action: 'snooze', title: 'Silence repeats 1h' }] : [],
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  if (event.action === 'snooze') {
    event.waitUntil(fetch('/api/alarms/snooze', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ minutes: 60 }),
    }).catch(() => {}));
    return;
  }
  event.waitUntil(self.clients.matchAll({ type: 'window' }).then((list) =>
    list.length ? list[0].focus() : self.clients.openWindow('/')));
});
