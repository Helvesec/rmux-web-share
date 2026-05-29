const CACHE_PREFIX = 'rmux-share-';
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
  event.waitUntil(activateServiceWorker());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) {
    return;
  }

  if (event.request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(event.request));
    return;
  }

  if (isShareAsset(url.pathname)) {
    event.respondWith(networkFirstAsset(event.request));
  }
});

async function precache() {
  const manifest = await offlineManifest();
  const cache = await caches.open(cacheName(manifest.version));
  await cache.addAll(manifest.assets);
}

async function offlineManifest() {
  const manifest = await fetchOfflineManifest();
  if (manifest) {
    return manifest;
  }
  return {
    assets: scopedAssets(CORE_ASSETS),
    fallback: true,
    version: 'offline',
  };
}

async function fetchOfflineManifest() {
  try {
    const response = await fetch(scopedUrl('/offline-manifest.json'), { cache: 'no-store' });
    if (!response.ok) {
      return null;
    }
    const manifest = await response.json();
    if (typeof manifest.version !== 'string' || !Array.isArray(manifest.assets)) {
      return null;
    }
    return {
      assets: scopedAssets([...new Set([...CORE_ASSETS, ...manifest.assets])]),
      fallback: false,
      version: manifest.version,
    };
  } catch {
    return null;
  }
}

async function activateServiceWorker() {
  const deletedCaches = await cleanupCaches();
  await self.clients.claim();
  if (deletedCaches > 0) {
    await refreshWindowClients();
  }
}

async function cleanupCaches() {
  const manifest = await fetchOfflineManifest();
  if (!manifest) {
    return 0;
  }
  const current = cacheName(manifest.version);
  const names = await caches.keys();
  const stale = names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== current);
  const results = await Promise.all(stale.map((name) => caches.delete(name)));
  return results.filter(Boolean).length;
}

async function refreshWindowClients() {
  const clients = await self.clients.matchAll({ type: 'window' });
  await Promise.all(clients.map((client) => {
    if (!client.url.startsWith(self.registration.scope) || typeof client.navigate !== 'function') {
      return null;
    }
    return client.navigate(client.url).catch(() => null);
  }));
}

async function networkFirstNavigation(request) {
  const manifest = await offlineManifest();
  const cache = await caches.open(cacheName(manifest.version));
  try {
    const response = await fetch(request);
    if (response.ok) {
      await cache.put(request, response.clone());
      await cache.put(scopedUrl('/'), response.clone());
    }
    return response;
  } catch (error) {
    const cached = await caches.match(request) || await caches.match(scopedUrl('/'));
    if (cached) {
      return cached;
    }
    throw error;
  }
}

async function networkFirstAsset(request) {
  const manifest = await offlineManifest();
  const cache = await caches.open(cacheName(manifest.version));
  try {
    const response = await fetch(request, { cache: 'no-cache' });
    if (response.ok) {
      await cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    const cached = await caches.match(request);
    if (cached) {
      return cached;
    }
    throw error;
  }
}

function cacheName(version) {
  return `${CACHE_PREFIX}${version}`;
}

function scopedAssets(paths) {
  return paths.map(scopedUrl);
}

function scopedUrl(path) {
  if (!path.startsWith('/')) {
    return new URL(path, self.registration.scope).toString();
  }
  const scopePath = new URL(self.registration.scope).pathname.replace(/\/$/, '');
  const scopedPath = `${scopePath}${path}`;
  return new URL(scopedPath || '/', self.location.origin).toString();
}

function isShareAsset(pathname) {
  return pathname === scopedPath('/')
    || pathname === scopedPath('/offline-manifest.json')
    || pathname === scopedPath('/share.webmanifest')
    || pathname.startsWith(scopedPath('/_astro/'));
}

function scopedPath(path) {
  const scopePath = new URL(self.registration.scope).pathname.replace(/\/$/, '');
  return `${scopePath}${path}` || '/';
}
