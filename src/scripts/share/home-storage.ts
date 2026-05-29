import { endpointHost, shareUrl } from './fragment';
import type { ReadyMessage, ShareParams, ShareRole, ShareScope, SessionView } from './types';

const STORAGE_KEY = 'rmux.share.recentLinks.v1';
const BROADCAST_CHANNEL = 'rmux.share.recentLinks.v1';
const MAX_RECENT_LINKS = 12;
const CRAB_COLORS = [
  'blue',
  'green',
  'orange',
  'purple',
  'cyan',
  'rose',
  'amber',
  'teal',
  'indigo',
  'lime',
] as const;

export type RecentStatus = 'active' | 'checking' | 'disconnected' | 'unavailable';

export interface RecentShare {
  id: string;
  params: ShareParams;
  url: string;
  endpoint: string;
  endpointLabel: string;
  name: string;
  role: ShareRole;
  scope: ShareScope;
  operatorAccess: boolean;
  spectatorAccess: boolean;
  pin?: string;
  viewers?: number;
  expiresAt?: number;
  disconnectedAt?: number;
  lastOpenedAt: number;
  crab: string;
}

export function loadRecentShares(): RecentShare[] {
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? '[]') as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(isRecentShare).sort((left, right) => right.lastOpenedAt - left.lastOpenedAt);
  } catch {
    return [];
  }
}

export function subscribeRecentShares(callback: () => void): () => void {
  if (typeof BroadcastChannel === 'undefined') {
    return () => {};
  }
  const channel = new BroadcastChannel(BROADCAST_CHANNEL);
  channel.addEventListener('message', (event: MessageEvent<unknown>) => {
    if (!isRecentShareBroadcast(event.data)) {
      return;
    }
    writeRecentShares(mergeRecentShares(event.data.shares), false);
    callback();
  });
  return () => channel.close();
}

export function forgetRecentShare(id: string): void {
  writeRecentShares(loadRecentShares().filter((share) => share.id !== id));
}

export function rememberRecentShare(
  params: ShareParams,
  ready: ReadyMessage,
  name?: string,
  pin?: string,
): RecentShare {
  const now = Date.now();
  const id = recentShareId(params);
  const previous = loadRecentShares();
  const existingShare = previous.find((share) => share.id === id);
  const existing = previous.filter((share) => share.id !== id);
  const entry: RecentShare = {
    id,
    params,
    url: shareUrl(params),
    endpoint: params.endpoint,
    endpointLabel: endpointHost(params.endpoint),
    name: shareName(ready, name),
    role: ready.role,
    scope: ready.scope,
    operatorAccess: ready.operator_access,
    spectatorAccess: ready.spectator_access,
    pin: pin || existingShare?.pin,
    viewers: connectedViewers(ready),
    expiresAt: ready.ttl_remaining_seconds === undefined
      ? undefined
      : now + ready.ttl_remaining_seconds * 1000,
    lastOpenedAt: now,
    crab: crabFor(id),
  };
  writeRecentShares([entry, ...existing].slice(0, MAX_RECENT_LINKS));
  return entry;
}

export function rememberRecentWindowName(params: ShareParams, view: SessionView): void {
  const active = view.windows?.find((window) => window.active);
  if (!active?.name) {
    return;
  }
  const id = recentShareId(params);
  const shares = loadRecentShares();
  const share = shares.find((candidate) => candidate.id === id);
  if (!share || share.name === active.name) {
    return;
  }
  share.name = active.name;
  writeRecentShares(shares);
}

export function markRecentShareDisconnected(params: ShareParams): void {
  markRecentShare(params, (share, now) => {
    share.disconnectedAt = now;
    share.lastOpenedAt = now;
  });
}

export function markRecentShareUnavailable(params: ShareParams): void {
  markRecentShare(params, (share, now) => {
    share.disconnectedAt = undefined;
    share.expiresAt = now;
    share.lastOpenedAt = now;
  });
}

export function updateRecentShareViewers(params: ShareParams, viewers: number): void {
  markRecentShare(params, (share) => {
    share.viewers = Math.max(0, Math.floor(viewers));
  });
}

function markRecentShare(
  params: ShareParams,
  update: (share: RecentShare, now: number) => void,
): void {
  const id = recentShareId(params);
  const shares = loadRecentShares();
  const share = shares.find((candidate) => candidate.id === id);
  if (!share) {
    return;
  }
  update(share, Date.now());
  writeRecentShares(shares);
}

export function recentShareStatus(share: RecentShare): RecentStatus {
  if (share.expiresAt !== undefined && share.expiresAt <= Date.now()) {
    return 'unavailable';
  }
  return share.disconnectedAt === undefined ? 'active' : 'disconnected';
}

export function recentShareExpiresLabel(share: RecentShare): string {
  if (share.expiresAt === undefined) {
    return 'Does not expire';
  }
  const remaining = share.expiresAt - Date.now();
  if (remaining <= 0) {
    return 'Expired';
  }
  const minutes = Math.ceil(remaining / 60_000);
  if (minutes < 60) {
    return `Expires in ${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `Expires in ${hours}h ${rest}m` : `Expires in ${hours}h`;
}

export function recentShareProgress(share: RecentShare): number | undefined {
  if (share.expiresAt === undefined) {
    return undefined;
  }
  const remaining = Math.max(0, share.expiresAt - Date.now());
  return Math.min(100, Math.max(3, remaining / 36_000));
}

export function recentShareId(params: ShareParams): string {
  return stableHash(`${params.endpoint}\n${params.token}`);
}

export function recentShareCrab(params: ShareParams): string {
  return crabFor(recentShareId(params));
}

function writeRecentShares(shares: RecentShare[], broadcast = true): void {
  const recent = shares.slice(0, MAX_RECENT_LINKS);
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(recent));
  } catch {
    // Recent-link storage is best effort.
  }
  if (broadcast) {
    broadcastRecentShares(recent);
  }
}

function shareName(ready: ReadyMessage, name?: string): string {
  return name || ready.pane_label || ready.session_name || ready.share_id || 'rmux share';
}

function connectedViewers(ready: ReadyMessage): number {
  if (Number.isFinite(ready.viewers_connected)) {
    return Math.max(0, Math.floor(ready.viewers_connected ?? 0));
  }
  return Math.max(0, Math.floor(ready.spectators_active ?? 0))
    + Math.max(0, Math.floor(ready.operators_active ?? 0));
}

function crabFor(id: string): string {
  return CRAB_COLORS[parseInt(id.slice(0, 8), 16) % CRAB_COLORS.length];
}

function stableHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function broadcastRecentShares(shares: RecentShare[]): void {
  if (typeof BroadcastChannel === 'undefined') {
    return;
  }
  const channel = new BroadcastChannel(BROADCAST_CHANNEL);
  channel.postMessage({ type: 'recent-shares', shares });
  channel.close();
}

function mergeRecentShares(incoming: RecentShare[]): RecentShare[] {
  const byId = new Map<string, RecentShare>();
  for (const share of [...loadRecentShares(), ...incoming]) {
    const current = byId.get(share.id);
    if (!current || share.lastOpenedAt >= current.lastOpenedAt) {
      byId.set(share.id, share);
    }
  }
  return [...byId.values()]
    .sort((left, right) => right.lastOpenedAt - left.lastOpenedAt)
    .slice(0, MAX_RECENT_LINKS);
}

function isRecentShareBroadcast(value: unknown): value is { type: 'recent-shares'; shares: RecentShare[] } {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const message = value as { type?: unknown; shares?: unknown };
  return message.type === 'recent-shares'
    && Array.isArray(message.shares)
    && message.shares.every(isRecentShare);
}

function isRecentShare(value: unknown): value is RecentShare {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const share = value as Partial<RecentShare>;
  return typeof share.id === 'string'
    && typeof share.url === 'string'
    && typeof share.endpoint === 'string'
    && typeof share.endpointLabel === 'string'
    && typeof share.name === 'string'
    && (share.role === 'operator' || share.role === 'spectator')
    && (share.scope === 'pane' || share.scope === 'session')
    && typeof share.operatorAccess === 'boolean'
    && typeof share.spectatorAccess === 'boolean'
    && (share.pin === undefined || typeof share.pin === 'string')
    && typeof share.lastOpenedAt === 'number'
    && (share.disconnectedAt === undefined || typeof share.disconnectedAt === 'number')
    && typeof share.crab === 'string'
    && isShareParams(share.params);
}

function isShareParams(value: unknown): value is ShareParams {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const params = value as Partial<ShareParams>;
  return typeof params.endpoint === 'string'
    && typeof params.token === 'string'
    && (params.navbar === 'visible' || params.navbar === 'off')
    && (params.disclaimer === 'on' || params.disclaimer === 'off');
}
