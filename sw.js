// Offline cache.
//
// Icons are cache-first: they only change when their filename does. Pages, scripts and styles are
// NETWORK-FIRST, so an update reaches the phone on the next launch rather than whenever the browser
// happens to notice a new service worker. An earlier cache-first version could leave a Home Screen
// install a build behind indefinitely, which is exactly what it must not do.
//
// CACHE is stamped at deploy time, so every deploy starts a clean cache and the old one is dropped.
const CACHE = 'rpm-__BUILD__';
const NETWORK_TIMEOUT = 2500;

const ASSETS = [
  './', 'index.html', 'guide.html', 'app.css', 'manifest.webmanifest',
  'js/app.js', 'js/engine.js', 'js/sensors.js', 'js/charts.js', 'js/store.js',
  'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
];

const isStaticAsset = (url) => /\.(png|ico|svg|jpg|woff2?)$/i.test(url.pathname);

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  e.respondWith(isStaticAsset(url)
    ? caches.match(req).then((hit) => hit || fetchAndStore(req))
    : networkFirst(req));
});

function fetchAndStore(req) {
  return fetch(req).then((res) => {
    if (res && res.ok && res.type === 'basic') {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
    }
    return res;
  });
}

// Whichever answers first: the network, or the cache once the network has had its moment.
function networkFirst(req) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (res) => { if (!settled && res) { settled = true; resolve(res); } };

    const fromCache = async () => {
      const hit = (await caches.match(req)) || (await caches.match('index.html'));
      if (hit) finish(hit);
      else if (!settled) { settled = true; resolve(new Response('Offline', { status: 503 })); }
    };

    const timer = setTimeout(fromCache, NETWORK_TIMEOUT);
    fetchAndStore(req)
      .then((res) => { clearTimeout(timer); finish(res); })
      .catch(() => { clearTimeout(timer); fromCache(); });
  });
}
