// Service worker: network-first for the app shell (always fresh when online, works offline),
// cache-first for logos and icons (they never change between releases).
// Requests to Google (the Apps Script API) are cross-origin and never touched here.
const VERSION = 'h2h-v20';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'favicon.ico',
  'config.js', 'css/tokens.css', 'css/app.css',
  'js/app.js', 'js/ui.js', 'js/api.js', 'js/demo.js', 'js/store.js', 'js/lock.js', 'js/stats.js', 'js/teams.js', 'js/sample.js', 'js/crypto.js', 'js/chart.js', 'js/clubs.js',
  'assets/icons/icon-192.png', 'assets/icons/apple-touch-icon.png',
];
const TEAMS = ['atl','bos','bkn','cha','chi','cle','dal','den','det','gsw','hou','ind','lac','lal','mem',
  'mia','mil','min','nop','nyk','okc','orl','phi','phx','por','sac','sas','tor','uta','was'];
const LOGOS = TEAMS.map((t) => `assets/logos/${t}.webp`);
const AVATARS = Array.from({ length: 20 }, (_, i) => `assets/avatars/a${String(i + 1).padStart(2, '0')}.webp`);

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll([...SHELL, ...LOGOS, ...AVATARS])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== location.origin) return;

  if (url.pathname.includes('/assets/')) {
    event.respondWith(
      caches.match(request).then((hit) => hit || fetch(request).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(request, copy)); }
        return res;
      })),
    );
    return;
  }

  // Revalidate with the server so a fresh deploy is never masked by the browser's HTTP cache
  const fresh = request.mode === 'navigate' ? new Request(request.url, { cache: 'no-cache' }) : new Request(request, { cache: 'no-cache' });
  event.respondWith(
    fetch(fresh)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(request, copy)); }
        return res;
      })
      .catch(() => caches.match(request).then((hit) => hit || (request.mode === 'navigate' ? caches.match('index.html') : undefined))),
  );
});
