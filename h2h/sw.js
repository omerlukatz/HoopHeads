// Service worker: the app shell opens from the cache instantly and refreshes in the background;
// logos, crests, avatars and icons are cache-first (they never change between releases).
// Requests to Google (Firebase, and the Apps Script API) are cross-origin and never touched here.
const VERSION = 'h2h-v29';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'favicon.ico',
  'config.js', 'firebase-config.js', 'css/tokens.css', 'css/app.css',
  'js/app.js', 'js/ui.js', 'js/api.js', 'js/demo.js', 'js/store.js', 'js/lock.js', 'js/stats.js', 'js/teams.js', 'js/sample.js', 'js/crypto.js', 'js/chart.js', 'js/clubs.js', 'js/firebase-backend.js',
  'assets/icons/icon-192.png', 'assets/icons/apple-touch-icon.png',
];
const TEAMS = ['atl','bos','bkn','cha','chi','cle','dal','den','det','gsw','hou','ind','lac','lal','mem',
  'mia','mil','min','nop','nyk','okc','orl','phi','phx','por','sac','sas','tor','uta','was'];
const LOGOS = TEAMS.map((t) => `assets/logos/${t}.webp`);
const AVATARS = Array.from({ length: 20 }, (_, i) => `assets/avatars/a${String(i + 1).padStart(2, '0')}.webp`);

self.addEventListener('install', (event) => {
  // `reload` skips the browser's HTTP cache so a new release never installs yesterday's files
  const fresh = (url) => new Request(url, { cache: 'reload' });
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll([...SHELL.map(fresh), ...LOGOS, ...AVATARS])).then(() => self.skipWaiting()));
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

  // App shell: answer from the cache at once (fast opens, works offline) and refresh the cached copy
  // in the background. `no-cache` revalidates with the server so a new release is picked up; a
  // release also bumps VERSION, which installs a fresh cache. Uncached files go to the network.
  const fresh = request.mode === 'navigate' ? new Request(request.url, { cache: 'no-cache' }) : new Request(request, { cache: 'no-cache' });
  const update = fetch(fresh).then(async (res) => {
    if (res.ok) await (await caches.open(VERSION)).put(request, res.clone());
    return res;
  });
  event.waitUntil(update.catch(() => {})); // keep the worker alive until the cache is refreshed
  event.respondWith(
    caches.match(request).then((hit) => hit || update.catch(() => (request.mode === 'navigate' ? caches.match('index.html') : undefined))),
  );
});
