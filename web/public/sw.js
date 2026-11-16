// Service worker: guarda a casca do app para abrir rápido e mostra notificações push.
const CACHE = 'jbk-v2-' + new URL(self.registration.scope).pathname;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/socket.io')) return;
  // Navegação: rede primeiro, casca em cache se estiver sem sinal.
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).then((r) => { caches.open(CACHE).then((c) => c.put(new URL('./', self.registration.scope).pathname, r.clone())); return r; }).catch(() => caches.match(new URL('./', self.registration.scope).pathname)));
    return;
  }
  if (url.pathname.startsWith(new URL('./assets/', self.registration.scope).pathname)) {
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((r) => {
      const copy = r.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return r;
    })));
  }
});

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data.json(); } catch {}
  e.waitUntil(self.registration.showNotification(d.title || 'JBK', {
    body: d.body || '', tag: d.tag, icon: new URL('./icon-192.png', self.registration.scope).href, badge: new URL('./icon-192.png', self.registration.scope).href,
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then((list) => (list[0] ? list[0].focus() : self.clients.openWindow(self.registration.scope))));
});
