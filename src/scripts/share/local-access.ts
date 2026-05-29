export interface ConfirmationCopy {
  button: string;
  detail: string;
  title: string;
  local: boolean;
}

const LOCAL_ACCESS_CONFIRMED_KEY = 'rmux.share.localAccessConfirmed';

export function chromeLocalAccessCopy(endpoint: string): ConfirmationCopy {
  return {
    button: 'Retry connection',
    detail: `Chrome blocked access to ${new URL(endpoint).host}. Click Allow in the browser prompt, then retry.`,
    title: 'Allow local access in Chrome',
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
  if (shouldShowChromeLocalAccessHelp(endpoint)) {
    return [
      'Chrome blocked Local Network Access to your rmux daemon.',
      'Click Allow in the browser prompt, then retry.',
    ].join(' ');
  }
  return 'connection error. Lost connection? Try refreshing.';
}

export function pinPromptCopy(): ConfirmationCopy {
  return {
    button: 'Connect',
    detail: 'Enter the 6-digit pairing code shown by rmux.',
    title: 'Pairing code required',
    local: false,
  };
}

export function shouldShowChromeLocalAccessHelp(endpoint: string): boolean {
  return looksLikeBlockedLoopback(endpoint)
    && isChromiumBrowser()
    && !localAccessWasConfirmed();
}

export function rememberLocalAccess(endpoint: string): void {
  if (!isLoopbackEndpoint(endpoint)) {
    return;
  }
  try {
    window.sessionStorage.setItem(LOCAL_ACCESS_CONFIRMED_KEY, '1');
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

function localAccessWasConfirmed(): boolean {
  try {
    return window.sessionStorage.getItem(LOCAL_ACCESS_CONFIRMED_KEY) === '1';
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
