/**
 * Offline shell.
 *
 * App files are served stale-while-revalidate so a deploy lands on the next
 * visit without ever leaving the user with a blank page. CDN modules are
 * cache-first and immutable — their URLs contain the version, so a bump in
 * src/deps.js fetches a new entry rather than invalidating an old one.
 *
 * Bump CACHE to drop the previous generation.
 */

const CACHE = 'vault-v3';

const APP_SHELL = [
  './',
  './index.html',
  './icon.svg',
  './manifest.webmanifest',
  './src/styles.css',
  './src/app.js',
  './src/crypto.js',
  './src/vault.js',
  './src/preview.js',
  './src/password.js',
  './src/ui.js',
  './src/deps.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // Individually, so one 404 can't fail the whole install.
      .then((cache) => Promise.all(APP_SHELL.map((url) => cache.add(url).catch(() => {}))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  const sameOrigin = url.origin === location.origin;

  event.respondWith(
    sameOrigin ? staleWhileRevalidate(request) : cacheFirst(request),
  );
});

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request, { ignoreSearch: true });
  const fresh = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);
  return cached ?? (await fresh) ?? new Response('Offline', { status: 503 });
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request).catch(() => null);
  if (response?.ok) cache.put(request, response.clone());
  return response ?? new Response('Offline', { status: 503 });
}
