export interface ConfirmationCopy {
  button: string;
  detail: string;
  local: boolean;
}

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
    detail: 'First time on Chrome? Click Allow if the browser asks for Local Network Access.',
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

function isLikelyMobileBrowser(): boolean {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
    || (navigator.maxTouchPoints > 1 && /Macintosh/i.test(navigator.userAgent));
}
