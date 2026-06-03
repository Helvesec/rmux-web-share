import type { ShareParams, TerminalThemeName } from './types';

const TOKEN_RE = /^[A-Za-z0-9._~-]{24,512}$/;
const ACTIVE_SHARE_STORAGE_KEY = 'rmux.share.activeParams.v1';
export const DEFAULT_SHARE_ENDPOINT = 'ws://127.0.0.1:9777/share';

export function hasShareFragment(hash: string): boolean {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  return Boolean(params.get('t'));
}

export function hasActiveShareParams(): boolean {
  return readActiveShareParams() !== undefined;
}

export function readActiveShareParams(): ShareParams | undefined {
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(ACTIVE_SHARE_STORAGE_KEY) ?? 'null') as unknown;
    return isShareParams(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function rememberActiveShareParams(params: ShareParams): void {
  try {
    window.sessionStorage.setItem(ACTIVE_SHARE_STORAGE_KEY, JSON.stringify(params));
  } catch {
    // Refresh resilience is best effort; the share link itself remains the source of truth.
  }
}

export function clearActiveShareParams(): void {
  try {
    window.sessionStorage.removeItem(ACTIVE_SHARE_STORAGE_KEY);
  } catch {
    // Clearing tab-local state is best effort.
  }
}

export function parseShareFragment(hash: string): ShareParams {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const endpoint = parseEndpoint(params.get('e'));
  const token = parseToken(params.get('t'));
  const theme = parseTheme(params.get('theme'));
  const navbar = parseNavbar(params.get('navbar'));
  const disclaimer = parseDisclaimer(params.get('disclaimer'));

  return { endpoint, token, theme, navbar, disclaimer };
}

export function parseShareInput(input: string): ShareParams {
  const value = input.trim();
  if (!value) {
    throw new Error('Enter a share link or token.');
  }

  if (value.startsWith('#')) {
    return parseShareFragment(value);
  }
  if (TOKEN_RE.test(value)) {
    return defaultShareParams(value);
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Enter a valid share link or token.');
  }
  if (!url.hash) {
    throw new Error('Share links must include a token fragment.');
  }
  return parseShareFragment(url.hash);
}

export function defaultShareParams(token: string): ShareParams {
  return {
    endpoint: DEFAULT_SHARE_ENDPOINT,
    token: parseToken(token),
    navbar: 'visible',
    disclaimer: 'on',
  };
}

export function shareBasePath(location: Location = window.location): string {
  const { pathname } = location;
  if (!pathname || pathname === '/') {
    return '/';
  }
  if (pathname.endsWith('/')) {
    return pathname;
  }
  const leaf = pathname.slice(pathname.lastIndexOf('/') + 1);
  if (!leaf.includes('.')) {
    return `${pathname}/`;
  }
  return pathname.slice(0, pathname.lastIndexOf('/') + 1) || '/';
}

export function shareBaseUrl(location: Location = window.location): string {
  return `${location.origin}${shareBasePath(location)}`;
}

export function shareAssetUrl(path: string, location: Location = window.location): string {
  return new URL(path, shareBaseUrl(location)).toString();
}

export function shareUrl(params: ShareParams, baseUrl = shareBaseUrl()): string {
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
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return `${base}#${fragment.join('&')}`;
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

function isShareParams(value: unknown): value is ShareParams {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const params = value as Partial<ShareParams>;
  return typeof params.endpoint === 'string'
    && typeof params.token === 'string'
    && (params.theme === undefined || params.theme === 'user' || params.theme === 'dark' || params.theme === 'light')
    && (params.navbar === 'visible' || params.navbar === 'off')
    && (params.disclaimer === 'on' || params.disclaimer === 'off');
}
