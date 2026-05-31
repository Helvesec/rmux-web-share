// Tombstone service worker.
//
// The share frontend no longer uses a service worker. A persistent worker on the
// JS-serving origin is a code-retention/persistence surface: it can keep serving
// cached or stale code after the origin is restored, which works against the
// integrity goals. This worker does nothing but self-destruct.
//
// It is kept deployed for at least one release so clients still controlled by the
// previous caching worker fetch it on their next update check and purge themselves.
// /sw.js is served with `Cache-Control: no-cache` so that update is picked up
// promptly. Delete this file (and its _headers entry) after the soak window.
const CACHE_PREFIX = 'rmux-share-';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(selfDestruct());
});

// No `fetch` handler: this worker never serves or caches any response.

async function selfDestruct() {
  const names = await caches.keys();
  await Promise.all(
    names.filter((name) => name.startsWith(CACHE_PREFIX)).map((name) => caches.delete(name)),
  );
  await self.registration.unregister();
  await self.clients.claim();
}
