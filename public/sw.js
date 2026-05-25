const CACHE_NAME = 'rmux-share-v2';
const MANIFEST_URL = '/offline-manifest.json';
const CORE_ASSETS = [
  '/',
  '/share.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(cleanupCaches().then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) {
    return;
  }

  if (isShareAsset(url.pathname) || event.request.mode === 'navigate') {
    event.respondWith(cacheFirst(event.request));
  }
});

async function precache() {
  const cache = await caches.open(CACHE_NAME);
  const assets = await offlineAssets();
  await cache.addAll([...new Set([...CORE_ASSETS, ...assets])]);
}

async function offlineAssets() {
  try {
    const response = await fetch(MANIFEST_URL, { cache: 'no-store' });
    if (!response.ok) {
      return [];
    }
    const manifest = await response.json();
    return Array.isArray(manifest.assets) ? manifest.assets : [];
  } catch {
    return [];
  }
}

async function cleanupCaches() {
  const names = await caches.keys();
  await Promise.all(names.filter((name) => name.startsWith('rmux-share-') && name !== CACHE_NAME).map((name) => caches.delete(name)));
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) {
    return cached;
  }

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    if (request.mode === 'navigate') {
      const fallback = await caches.match('/');
      if (fallback) {
        return fallback;
      }
    }
    throw error;
  }
}

function isShareAsset(pathname) {
  return pathname === '/'
    || pathname === '/offline-manifest.json'
    || pathname === '/share.webmanifest'
    || pathname.startsWith('/_astro/');
}
