export function installMockShareWebSocket(): void {
  const NativeWebSocket = window.WebSocket;

  class MockWebSocket extends EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    binaryType = 'blob';
    readyState = MockWebSocket.CONNECTING;
    sent: unknown[] = [];

    constructor(readonly url: string | URL) {
      super();
      if (!String(url).includes('/share')) {
        return new NativeWebSocket(url) as unknown as MockWebSocket;
      }
      window.__rmuxShareSockets = [...(window.__rmuxShareSockets ?? []), this];
      queueMicrotask(() => {
        this.readyState = MockWebSocket.OPEN;
        this.dispatchEvent(new Event('open'));
      });
    }

    send(data: unknown): void {
      this.sent.push(serializeFrame(data));
      if (typeof data === 'string' && data.includes('"type":"auth"')) {
        const auth = JSON.parse(data);
        const role = window.__rmuxShareReadyRole
          ?? (String(auth.token).includes('operator') ? 'operator' : 'read');
        const ready = {
          type: 'ready',
          protocol_version: 2,
          capabilities: ['token-auth', 'terminal-palette-v1'],
          pane_size: { cols: 24, rows: 6 },
          scope: window.__rmuxShareReadyScope ?? 'pane',
          share_id: 'abcdefgh',
          session_name: 'ci',
          pane_label: '%1',
          role,
          writable: true,
          controls: Boolean(window.__rmuxShareReadyControls),
          operator_connected: false,
          ttl_remaining_seconds: 60,
          readers_active: 1,
          readers_max: 5,
          terminal_palette: window.__rmuxShareTerminalPalette,
        };
        this.dispatchMessage(JSON.stringify(ready));
        this.dispatchMessage(new Uint8Array([0x10, ...new TextEncoder().encode('hello from rmux')]).buffer);
      }
      if (typeof data === 'string' && data.includes('"logout"')) {
        this.close();
      }
    }

    close(): void {
      this.readyState = MockWebSocket.CLOSED;
      this.dispatchEvent(new CloseEvent('close', { code: 1000 }));
    }

    private dispatchMessage(data: string | ArrayBuffer): void {
      this.dispatchEvent(new MessageEvent('message', { data }));
    }
  }

  function serializeFrame(data: unknown): unknown {
    if (data instanceof Uint8Array) {
      return Array.from(data);
    }
    return data;
  }

  Object.defineProperty(window, 'WebSocket', {
    configurable: true,
    value: MockWebSocket,
  });
}

declare global {
  interface Window {
    __rmuxShareReadyControls?: boolean;
    __rmuxShareReadyRole?: 'read' | 'operator';
    __rmuxShareReadyScope?: 'pane' | 'session';
    __rmuxShareSockets?: Array<{ sent: unknown[] }>;
    __rmuxShareTerminalPalette?: {
      foreground: string;
      background: string;
      cursor: string;
      ansi: string[];
    };
  }
}
