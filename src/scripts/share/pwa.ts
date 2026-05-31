// The share frontend no longer registers a service worker (see public/sw.js for
// the rationale). This one-shot purge unregisters any worker a previous release
// installed and deletes its caches, so a returning client stops being controlled
// by old, potentially stale cached code. It is belt-and-suspenders with the
// tombstone sw.js and is best-effort: the connection flow never depended on a
// service worker. Remove this module (and its main.ts call) after the soak window.
export function purgeShareServiceWorker(): void {
  if (!('serviceWorker' in navigator)) {
    return;
  }

  void navigator.serviceWorker.getRegistrations()
    .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
    .catch(() => {
      // Purging legacy workers is best-effort; never block the connection flow.
    });

  if ('caches' in window) {
    void caches.keys()
      .then((names) => Promise.all(
        names.filter((name) => name.startsWith('rmux-share-')).map((name) => caches.delete(name)),
      ))
      .catch(() => {
        // Cache cleanup is best-effort.
      });
  }
}
