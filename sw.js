self.addEventListener('fetch', e => {
  if(e.request.url.includes('supabase.co')) return;
  e.respondWith(fetch(e.request));
});
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k)))));
  self.clients.claim();
});
