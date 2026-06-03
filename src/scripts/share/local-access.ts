export interface ConfirmationCopy {
  button: string;
  detail: string;
  title: string;
  local: boolean;
  action: 'connect' | 'copy-link';
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

export function localAccessPromptCopy(
  endpoint: string,
  environment = currentLocalAccessEnvironment(),
): ConfirmationCopy {
  const browserName = localAccessBrowserName(environment);
  return {
    button: 'Continue',
    detail: [
      `${browserName} may ask for Local Network Access before it can reach ${new URL(endpoint).host}.`,
      'Click Allow if the browser prompts you.',
    ].join(' '),
    title: 'Allow local access',
    local: true,
    action: 'connect',
  };
}

export function localAccessBlockedCopy(
  endpoint: string,
  environment = currentLocalAccessEnvironment(),
): ConfirmationCopy {
  const browserName = localAccessBrowserName(environment);
  const site = environment.hostname || 'this site';
  return {
    button: 'Retry connection',
    detail: [
      `${browserName} blocked access to ${new URL(endpoint).host}.`,
      `If no browser prompt appears, reset Local Network Access for ${site} in ${browserName} site settings, then retry.`,
    ].join(' '),
    title: `Allow local access in ${browserName}`,
    local: true,
    action: 'connect',
  };
}

export function safariLocalAccessCopy(endpoint: string): ConfirmationCopy {
  return {
    button: 'Copy link',
    detail: [
      `Safari does not allow this page to connect to RMUX on ${new URL(endpoint).host}.`,
      'Open this link in Chrome, Edge, or Firefox, or start the share with a tunnel provider for Safari.',
    ].join(' '),
    title: 'Safari blocks local web-share',
    local: true,
    action: 'copy-link',
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
  if (shouldShowLocalAccessBlockedHelp(endpoint)) {
    const browserName = localAccessBrowserName(environment);
    return [
      `${browserName} blocked Local Network Access to your rmux daemon.`,
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
    action: 'connect',
  };
}

export function shouldShowLocalAccessBlockedHelp(endpoint: string): boolean {
  return shouldShowLocalAccessPrompt(endpoint);
}

export function shouldShowSafariLocalAccessPrompt(endpoint: string): boolean {
  return shouldShowSafariLocalAccessPromptIn(endpoint, currentLocalAccessEnvironment());
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

export function shouldShowSafariLocalAccessPromptIn(endpoint: string, environment: LocalAccessEnvironment): boolean {
  return looksLikeBlockedLoopback(endpoint, environment)
    && isSafariBrowser(environment)
    && !isLikelyMobileBrowser(environment);
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

function localAccessBrowserName(environment = currentLocalAccessEnvironment()): string {
  if (isEdgeBrowser(environment)) {
    return 'Edge';
  }
  if (isFirefoxBrowser(environment)) {
    return 'Firefox';
  }
  if (isChromeBrowser(environment)) {
    return 'Chrome';
  }
  if (isSafariBrowser(environment)) {
    return 'Safari';
  }
  return 'This browser';
}

function isChromeBrowser(environment: LocalAccessEnvironment): boolean {
  return environment.brands.some((brand) => /Google Chrome/i.test(brand.brand))
    || (/\b(?:Chrome|CriOS)\//.test(environment.userAgent)
      && !/\b(?:Edg|OPR|Firefox)\//.test(environment.userAgent));
}

function isEdgeBrowser(environment: LocalAccessEnvironment): boolean {
  return environment.brands.some((brand) => /Microsoft Edge/i.test(brand.brand))
    || /\bEdg\//.test(environment.userAgent);
}

function isFirefoxBrowser(environment: LocalAccessEnvironment): boolean {
  return /\bFirefox\//.test(environment.userAgent);
}

function isSafariBrowser(environment: LocalAccessEnvironment): boolean {
  return /\bSafari\//.test(environment.userAgent)
    && !/\b(?:Chrome|Chromium|CriOS|FxiOS|Edg|OPR)\//.test(environment.userAgent);
}

function isLikelyMobileBrowser(environment: LocalAccessEnvironment): boolean {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(environment.userAgent)
    || (environment.maxTouchPoints > 1 && /Macintosh/i.test(environment.userAgent));
}
