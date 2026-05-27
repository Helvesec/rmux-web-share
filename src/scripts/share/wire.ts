export const WEB_SHARE_PROTOCOL_VERSION = 3;
export const WEB_SHARE_CLIENT_CAPABILITIES = [
  'e2ee-token-auth',
  'terminal-palette-v1',
] as const;

const INPUT_TEXT = 0x80;
const RESIZE_REQUEST = 0x82;
const ATTACH_INPUT = 0x83;
const MAX_INPUT_BYTES = 4096;

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
      return 'spectator limit reached';
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
