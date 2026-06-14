const CACHE = 'tackpath-driver-v1';
const ASSETS = [
  '/tackpath-app/driver.html',
  '/tackpath-app/manifest.json'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // Network first for API calls
  if(e.request.url.includes('supabase.co')){
    return;
  }
  e.respondWith(
    fetch(e.request)
      .then(r => {
        const clone = r.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return r;
      })
      .catch(() => caches.match(e.request))
  );
});

// Push notification support
self.addEventListener('push', e => {
  const data = e.data ? e.data.json() : {};
  e.waitUntil(
    self.registration.showNotification(data.title || 'TackPath', {
      body: data.body || 'New job available',
      icon: '/tackpath-app/icon-192.png',
      badge: '/tackpath-app/icon-192.png',
      vibrate: [200, 100, 200],
      data: { url: '/tackpath-app/driver.html' }
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.openWindow('/tackpath-app/driver.html')
  );
});
