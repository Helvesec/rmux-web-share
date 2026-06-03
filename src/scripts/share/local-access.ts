export interface ConfirmationCopy {
  button: string;
  detail: string;
  title: string;
  local: boolean;
}

export interface LocalAccessEnvironment {
  brands: Array<{ brand: string }>;
  confirmed: boolean;
  hostname: string;
  maxTouchPoints: number;
  protocol: string;
  userAgent: string;
}

const LOCAL_ACCESS_CONFIRMED_KEY = 'rmux.share.localAccessConfirmed';

export function localAccessPromptCopy(endpoint: string): ConfirmationCopy {
  return {
    button: 'Continue',
    detail: [
      `Chrome may ask for Local Network Access before it can reach ${new URL(endpoint).host}.`,
      'Click Allow if the browser prompts you.',
    ].join(' '),
    title: 'Allow local access',
    local: true,
  };
}

export function chromeLocalAccessCopy(endpoint: string): ConfirmationCopy {
  return {
    button: 'Retry connection',
    detail: `Chrome blocked access to ${new URL(endpoint).host}. Click Allow in the browser prompt, then retry.`,
    title: 'Allow local access in Chrome',
    local: true,
  };
}

export function connectionErrorMessage(endpoint: string): string {
  const environment = currentLocalAccessEnvironment();
  if (looksLikeBlockedLoopback(endpoint, environment) && isLikelyMobileBrowser(environment)) {
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
  return shouldShowLocalAccessPrompt(endpoint);
}

export function shouldShowLocalAccessPrompt(endpoint: string): boolean {
  return shouldShowLocalAccessPromptIn(endpoint, currentLocalAccessEnvironment());
}

export function shouldShowLocalAccessPromptIn(endpoint: string, environment: LocalAccessEnvironment): boolean {
  return looksLikeBlockedLoopback(endpoint, environment)
    && isChromiumBrowser(environment)
    && !isLikelyMobileBrowser(environment)
    && !environment.confirmed;
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

function currentLocalAccessEnvironment(): LocalAccessEnvironment {
  const userAgentData = (navigator as Navigator & {
    userAgentData?: { brands?: Array<{ brand: string }> };
  }).userAgentData;
  return {
    brands: userAgentData?.brands ?? [],
    confirmed: localAccessWasConfirmed(),
    hostname: window.location.hostname,
    maxTouchPoints: navigator.maxTouchPoints,
    protocol: window.location.protocol,
    userAgent: navigator.userAgent,
  };
}

function looksLikeBlockedLoopback(endpoint: string, environment: LocalAccessEnvironment): boolean {
  return environment.protocol === 'https:'
    && !isLoopbackHost(environment.hostname)
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

function isChromiumBrowser(environment: LocalAccessEnvironment): boolean {
  if (environment.brands.some((brand) => /Chromium|Google Chrome|Microsoft Edge/i.test(brand.brand))) {
    return true;
  }
  return /\b(?:Chrome|Chromium|Edg|OPR)\//.test(environment.userAgent)
    && !/\bFirefox\//.test(environment.userAgent);
}

function isLikelyMobileBrowser(environment: LocalAccessEnvironment): boolean {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(environment.userAgent)
    || (environment.maxTouchPoints > 1 && /Macintosh/i.test(environment.userAgent));
}
