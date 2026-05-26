import type { ShareParams } from './types';

export const WEB_SHARE_PROTOCOL_VERSION = 2;
export const WEB_SHARE_CLIENT_CAPABILITIES = [
  'token-auth',
  'terminal-palette-v1',
] as const;

const INPUT_TEXT = 0x80;
const RESIZE_REQUEST = 0x82;
const ATTACH_INPUT = 0x83;
const MAX_INPUT_BYTES = 4096;

const encoder = new TextEncoder();

export function authPayload(params: ShareParams, pin?: string): string {
  const payload: {
    type: 'auth';
    protocol_version: number;
    capabilities: readonly string[];
    token: string;
    pin?: string;
  } = {
    type: 'auth',
    protocol_version: WEB_SHARE_PROTOCOL_VERSION,
    capabilities: WEB_SHARE_CLIENT_CAPABILITIES,
    token: params.token,
  };
  if (pin) {
    payload.pin = pin;
  }
  return JSON.stringify(payload);
}

export function sendInputText(ws: WebSocket, text: string): boolean {
  return sendTextFrame(ws, INPUT_TEXT, text);
}

export function sendAttachInputText(ws: WebSocket, text: string): boolean {
  return sendTextFrame(ws, ATTACH_INPUT, text);
}

function sendTextFrame(ws: WebSocket, opcode: number, text: string): boolean {
  const utf8 = encoder.encode(text);
  if (utf8.length > MAX_INPUT_BYTES) {
    return false;
  }
  const frame = new Uint8Array(1 + utf8.length);
  frame[0] = opcode;
  frame.set(utf8, 1);
  ws.send(frame);
  return true;
}

export function sendResizeRequest(ws: WebSocket, cols: number, rows: number): void {
  const frame = new Uint8Array(5);
  const safeCols = clampSize(cols);
  const safeRows = clampSize(rows);
  frame[0] = RESIZE_REQUEST;
  frame[1] = (safeCols >> 8) & 0xff;
  frame[2] = safeCols & 0xff;
  frame[3] = (safeRows >> 8) & 0xff;
  frame[4] = safeRows & 0xff;
  ws.send(frame);
}

export function logoutSession(ws: WebSocket): void {
  ws.send(JSON.stringify({ type: 'logout' }));
}

export function closeMessage(code: number): string {
  switch (code) {
    case 1000:
      return 'connection closed';
    case 1011:
      return 'server error; reconnect when the share is still active';
    case 4000:
      return 'auth refused';
    case 4001:
      return 'evicted due to backpressure';
    case 4002:
      return 'frame too large';
    case 4003:
      return 'read-only quota reached';
    case 4004:
      return 'origin not whitelisted; check --frontend-url';
    case 4006:
      return 'protocol violation';
    case 4007:
      return 'operator slot already taken';
    case 4008:
      return 'pairing code required';
    default:
      return code ? `connection closed (${code})` : 'connection closed';
  }
}

function clampSize(value: number): number {
  return Math.max(1, Math.min(9999, Math.floor(value)));
}
