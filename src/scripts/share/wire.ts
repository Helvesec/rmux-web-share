import type { PaneResizeDirection, SessionSplitDirection } from './types';

export const WEB_SHARE_PROTOCOL_VERSION = 4;
export const WEB_SHARE_CLIENT_CAPABILITIES = [
  'e2ee-token-auth',
  'terminal-palette-v1',
] as const;

const INPUT_TEXT = 0x80;
const RESIZE_REQUEST = 0x82;
const ATTACH_INPUT = 0x83;
const SESSION_RESIZE_PANE = 0x84;
const MAX_INPUT_BYTES = 4096;
const MAX_PANE_RESIZE_CELLS = 10_000;
const MAX_WINDOW_NAME_BYTES = 128;
const PANE_RESIZE_DIRECTION_CODES: Record<PaneResizeDirection, number> = {
  down: 3,
  left: 0,
  right: 1,
  up: 2,
};

const encoder = new TextEncoder();

export interface ShareTransport {
  readonly readyState: number;
  sendText(text: string): void;
  sendBinary(bytes: Uint8Array): void;
}

export function authPayload(pin?: string): string {
  const payload: {
    type: 'auth';
    protocol_version: number;
    capabilities: readonly string[];
    pin?: string;
  } = {
    type: 'auth',
    protocol_version: WEB_SHARE_PROTOCOL_VERSION,
    capabilities: WEB_SHARE_CLIENT_CAPABILITIES,
  };
  if (pin) {
    payload.pin = pin;
  }
  return JSON.stringify(payload);
}

export function sendInputText(ws: ShareTransport, text: string): boolean {
  return sendTextFrame(ws, INPUT_TEXT, text);
}

export function sendAttachInputText(ws: ShareTransport, text: string): boolean {
  return sendTextFrame(ws, ATTACH_INPUT, text);
}

export function sendResizeRequest(ws: ShareTransport, cols: number, rows: number): void {
  const frame = new Uint8Array(5);
  frame[0] = RESIZE_REQUEST;
  frame[1] = (cols >> 8) & 0xff;
  frame[2] = cols & 0xff;
  frame[3] = (rows >> 8) & 0xff;
  frame[4] = rows & 0xff;
  ws.sendBinary(frame);
}

export function resizeSessionPane(
  ws: ShareTransport,
  paneId: number,
  direction: PaneResizeDirection,
  cells: number,
): void {
  if (!Number.isInteger(paneId) || paneId < 0 || paneId > 0xffff_ffff) {
    return;
  }
  if (!Number.isFinite(cells) || cells < 1) {
    return;
  }
  const amount = Math.min(MAX_PANE_RESIZE_CELLS, Math.floor(cells));
  const frame = new Uint8Array(8);
  frame[0] = SESSION_RESIZE_PANE;
  frame[1] = (paneId >>> 24) & 0xff;
  frame[2] = (paneId >>> 16) & 0xff;
  frame[3] = (paneId >>> 8) & 0xff;
  frame[4] = paneId & 0xff;
  frame[5] = PANE_RESIZE_DIRECTION_CODES[direction];
  frame[6] = (amount >> 8) & 0xff;
  frame[7] = amount & 0xff;
  ws.sendBinary(frame);
}

function sendTextFrame(ws: ShareTransport, opcode: number, text: string): boolean {
  const utf8 = encoder.encode(text);
  if (utf8.length > MAX_INPUT_BYTES) {
    return false;
  }
  const frame = new Uint8Array(1 + utf8.length);
  frame[0] = opcode;
  frame.set(utf8, 1);
  ws.sendBinary(frame);
  return true;
}

export function logoutSession(ws: ShareTransport): void {
  ws.sendText(JSON.stringify({ type: 'logout' }));
}

export function scrollSessionPane(ws: ShareTransport, paneId: number, delta: number): void {
  ws.sendText(JSON.stringify({ type: 'pane_scroll', pane_id: paneId, delta }));
}

export function selectSessionPane(ws: ShareTransport, paneId: number): void {
  ws.sendText(JSON.stringify({ type: 'select_pane', pane_id: paneId }));
}

export function splitSessionPane(ws: ShareTransport, direction: SessionSplitDirection): void {
  ws.sendText(JSON.stringify({ type: 'split_pane', direction }));
}

export function newSessionWindow(ws: ShareTransport): void {
  ws.sendText(JSON.stringify({ type: 'new_window' }));
}

export function killSessionPane(ws: ShareTransport): void {
  ws.sendText(JSON.stringify({ type: 'kill_pane' }));
}

export function selectSessionWindow(ws: ShareTransport, windowIndex: number): void {
  const index = normalizedWindowIndex(windowIndex);
  if (index === undefined) {
    return;
  }
  ws.sendText(JSON.stringify({ type: 'select_window', window_index: index }));
}

export function renameSessionWindow(ws: ShareTransport, windowIndex: number, name: string): boolean {
  const index = normalizedWindowIndex(windowIndex);
  const trimmed = name.trim();
  if (index === undefined || !validWindowName(trimmed)) {
    return false;
  }
  ws.sendText(JSON.stringify({ type: 'rename_window', window_index: index, name: trimmed }));
  return true;
}

export function killSessionWindow(ws: ShareTransport, windowIndex: number): void {
  const index = normalizedWindowIndex(windowIndex);
  if (index === undefined) {
    return;
  }
  ws.sendText(JSON.stringify({ type: 'kill_window', window_index: index }));
}

export function closeMessage(code: number): string {
  switch (code) {
    case 1000:
      return 'connection closed';
    case 1011:
      return 'server error; reconnect when the share is still active';
    case 4000:
      // v4 collapses every pre-ready rejection (bad link, wrong pairing code,
      // capacity, or origin) to this single code; the server never discloses
      // which, to avoid an identity/PIN oracle.
      return 'connection refused — check the share link and pairing code';
    case 4001:
      return 'evicted due to backpressure';
    case 4002:
      return 'frame too large';
    case 4006:
      return 'protocol violation';
    default:
      return code ? `connection closed (${code})` : 'connection closed';
  }
}

function normalizedWindowIndex(value: number): number | undefined {
  return Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff ? value : undefined;
}

function validWindowName(value: string): boolean {
  return value.length > 0
    && encoder.encode(value).length <= MAX_WINDOW_NAME_BYTES
    && !/[\u0000-\u001f\u007f]/u.test(value);
}
