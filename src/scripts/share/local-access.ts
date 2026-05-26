export interface ConfirmationCopy {
  button: string;
  detail: string;
  local: boolean;
}

const LOCAL_ACCESS_CONFIRMED_KEY = 'rmux.share.localAccessConfirmed';

export function confirmationCopy(endpoint: string): ConfirmationCopy {
  if (!isLoopbackEndpoint(endpoint)) {
    return {
      button: 'Connect',
      detail: 'Only connect to endpoints you trust.',
      local: false,
    };
  }

  return {
    button: 'Connect to local daemon',
    detail: localAccessHint(),
    local: true,
  };
}

export function connectionErrorMessage(endpoint: string): string {
  if (looksLikeBlockedLoopback(endpoint) && isLikelyMobileBrowser()) {
    return [
      'This local rmux link only works on the computer running rmux.',
      'Phones cannot reach ws://127.0.0.1 on your desktop. Use --tunnel-url for phone or internet sharing.',
    ].join(' ');
  }
  if (looksLikeBlockedLoopback(endpoint)) {
    return [
      'Chrome may need Local Network Access before it can reach your local rmux daemon.',
      'Click Allow when prompted, then retry. If this browser blocks local access, refresh or use --frontend-url with a localhost-hosted frontend.',
    ].join(' ');
  }
  return 'connection error. Lost connection? Try refreshing.';
}

export function rememberLocalAccess(endpoint: string): void {
  if (!isLoopbackEndpoint(endpoint)) {
    return;
  }
  try {
    window.localStorage.setItem(LOCAL_ACCESS_CONFIRMED_KEY, '1');
  } catch {
    // Storage can be disabled; this hint is only an ergonomic optimization.
  }
}

export function isLoopbackEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return url.protocol === 'ws:' && isLoopbackHost(url.hostname);
  } catch {
    return false;
  }
}

function looksLikeBlockedLoopback(endpoint: string): boolean {
  return window.location.protocol === 'https:'
    && !isLoopbackHost(window.location.hostname)
    && isLoopbackEndpoint(endpoint);
}

function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

function localAccessHint(): string {
  if (isChromiumBrowser() && !localAccessWasConfirmed()) {
    return 'If Chrome asks for Local Network Access, click Allow.';
  }
  return 'Connects to the rmux daemon running on this computer.';
}

function localAccessWasConfirmed(): boolean {
  try {
    return window.localStorage.getItem(LOCAL_ACCESS_CONFIRMED_KEY) === '1';
  } catch {
    return false;
  }
}

function isChromiumBrowser(): boolean {
  const userAgentData = (navigator as Navigator & {
    userAgentData?: { brands?: Array<{ brand: string }> };
  }).userAgentData;
  const brands = userAgentData?.brands ?? [];
  if (brands.some((brand) => /Chromium|Google Chrome|Microsoft Edge/i.test(brand.brand))) {
    return true;
  }
  return /\b(?:Chrome|Chromium|Edg|OPR)\//.test(navigator.userAgent)
    && !/\bFirefox\//.test(navigator.userAgent);
}

function isLikelyMobileBrowser(): boolean {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
    || (navigator.maxTouchPoints > 1 && /Macintosh/i.test(navigator.userAgent));
}
