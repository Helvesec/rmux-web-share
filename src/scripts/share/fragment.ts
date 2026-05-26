import type { ShareParams, TerminalThemeName } from './types';

const TOKEN_RE = /^[A-Za-z0-9._~-]{24,512}$/;
const DEFAULT_SHARE_ENDPOINT = 'ws://127.0.0.1:9777/share';

export function parseShareFragment(hash: string): ShareParams {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const endpoint = parseEndpoint(params.get('e'));
  const token = parseToken(params.get('t'));
  const theme = parseTheme(params.get('theme'));
  const navbar = parseNavbar(params.get('navbar'));
  const disclaimer = parseDisclaimer(params.get('disclaimer'));
  const viewers = parseViewers(params.get('viewers'));
  const requiresPin = parsePinRequirement(params.get('pin'));

  return { endpoint, token, theme, navbar, disclaimer, viewers, requiresPin };
}

export function shareUrl(params: ShareParams, origin = window.location.origin): string {
  const fragment = [];
  if (params.endpoint !== DEFAULT_SHARE_ENDPOINT) {
    fragment.push(`e=${params.endpoint}`);
  }
  fragment.push(`t=${params.token}`);
  if (params.theme) {
    fragment.push(`theme=${params.theme}`);
  }
  if (params.navbar === 'off') {
    fragment.push('navbar=off');
  }
  if (params.disclaimer === 'off') {
    fragment.push('disclaimer=off');
  }
  if (params.viewers === 'visible') {
    fragment.push('viewers=on');
  }
  if (params.requiresPin) {
    fragment.push('pin=required');
  }
  return `${origin}/#${fragment.join('&')}`;
}

export function endpointHost(endpoint: string): string {
  return new URL(endpoint).host;
}

function parseEndpoint(value: string | null): string {
  if (!value) {
    return DEFAULT_SHARE_ENDPOINT;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('invalid endpoint');
  }

  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error('endpoint must use ws:// or wss://');
  }
  if (!url.hostname || url.username || url.password || url.hash || url.search) {
    throw new Error('endpoint must be a plain websocket URL');
  }
  return url.toString();
}

function parseToken(value: string | null): string {
  if (!value) {
    throw new Error('missing share token');
  }
  if (!TOKEN_RE.test(value)) {
    throw new Error('invalid share token');
  }
  return value;
}

function parseTheme(value: string | null): TerminalThemeName | undefined {
  if (!value) {
    return undefined;
  }
  if (value === 'user' || value === 'light' || value === 'dark') {
    return value;
  }
  throw new Error('invalid terminal theme');
}

function parseNavbar(value: string | null): ShareParams['navbar'] {
  if (!value || value === 'visible') {
    return 'visible';
  }
  if (value === 'off') {
    return 'off';
  }
  throw new Error('invalid navbar option');
}

function parseDisclaimer(value: string | null): ShareParams['disclaimer'] {
  if (!value || value === 'on') {
    return 'on';
  }
  if (value === 'off') {
    return 'off';
  }
  throw new Error('invalid disclaimer option');
}

function parseViewers(value: string | null): ShareParams['viewers'] {
  if (!value || value === 'off') {
    return 'hidden';
  }
  if (value === 'on') {
    return 'visible';
  }
  throw new Error('invalid viewers option');
}

function parsePinRequirement(value: string | null): boolean {
  if (!value) {
    return false;
  }
  if (value === 'required') {
    return true;
  }
  throw new Error('invalid pin option');
}
