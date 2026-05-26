import { shareBasePath } from './fragment';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function registerShareServiceWorker(): void {
  if (!('serviceWorker' in navigator) || !canRegisterServiceWorker()) {
    return;
  }

  const options = shareServiceWorkerOptions();
  void navigator.serviceWorker.register(options.url, { scope: options.scope })
    .then((registration) => registration.update())
    .catch(() => {
      // Offline caching is a convenience path. Connection flow must not depend on it.
    });
}

function canRegisterServiceWorker(): boolean {
  return window.location.protocol === 'https:' || LOCAL_HOSTS.has(window.location.hostname);
}

function shareServiceWorkerOptions(): { scope: string; url: string } {
  const scope = shareBasePath();
  return { scope, url: `${scope}sw.js` };
}
