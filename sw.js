// Offline cache for the app shell. Bump VERSION when files change.
const VERSION = 'mininote-v0.3.1';
const FILES = [
  './', 'index.html', 'css/app.css', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png',
  'js/util.js', 'js/storage.js', 'js/editor/doc.js', 'js/editor/brush.js', 'js/editor/tools.js',
  'js/editor/panels.js', 'js/editor/editor.js', 'js/project.js', 'js/gallery.js', 'js/app.js',
];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// network first (so updates arrive immediately), cache as offline fallback
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request).then(r => {
      if (r.ok) { const copy = r.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); }
      return r;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
