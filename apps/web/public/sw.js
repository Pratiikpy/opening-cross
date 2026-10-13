// Opening Bell service worker. It exists for one thing: to show the alerts the server pushes (a cross about to close, an order that
// can be claimed) when no Opening Bell page is open. It caches nothing and intercepts no request.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { body: event.data ? event.data.text() : '' };
  }
  const title = typeof data.title === 'string' && data.title ? data.title : 'Opening Bell';
  const options = {
    body: typeof data.body === 'string' ? data.body : '',
    // One notification per event: a second push for the same event replaces the first instead of stacking.
    tag: typeof data.tag === 'string' ? data.tag : undefined,
    data: { url: typeof data.url === 'string' ? data.url : '/' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  // Only a path on this site is opened, whatever the push carried.
  let target = '/';
  try {
    const u = new URL(event.notification.data && event.notification.data.url ? event.notification.data.url : '/', self.location.origin);
    if (u.origin === self.location.origin) target = u.pathname + u.search + u.hash;
  } catch (e) {
    target = '/';
  }
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const w of windows) {
        if (w.url.startsWith(self.location.origin) && 'focus' in w) {
          if ('navigate' in w) w.navigate(target);
          return w.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
