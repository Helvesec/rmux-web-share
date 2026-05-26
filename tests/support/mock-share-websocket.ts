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
        if (window.__rmuxShareRequirePin && !auth.pin) {
          this.readyState = MockWebSocket.CLOSED;
          this.dispatchEvent(new CloseEvent('close', { code: 4008, reason: 'pin_required' }));
          return;
        }
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
          show_viewers: Boolean(window.__rmuxShareShowViewers),
          operator_connected: false,
          ttl_remaining_seconds: 60,
          readers_active: 1,
          readers_max: 5,
          viewers_connected: 1,
          terminal_palette: window.__rmuxShareTerminalPalette,
        };
        this.dispatchMessage(JSON.stringify(ready));
        this.dispatchMessage(JSON.stringify(window.__rmuxShareViewerCount ?? {
          type: 'viewer_count',
          readers_active: 2,
          readers_max: 5,
          operator_connected: true,
          viewers_connected: 3,
        }));
        this.dispatchMessage(new Uint8Array([0x10, ...new TextEncoder().encode('hello from rmux')]).buffer);
        for (const frame of window.__rmuxSharePostSnapshotFrames ?? []) {
          this.dispatchMessage(frame);
        }
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
    __rmuxShareRequirePin?: boolean;
    __rmuxShareShowViewers?: boolean;
    __rmuxShareSockets?: Array<{ sent: unknown[] }>;
    __rmuxSharePostSnapshotFrames?: ArrayBuffer[];
    __rmuxShareTerminalPalette?: {
      foreground: string;
      background: string;
      cursor: string;
      ansi: string[];
    };
    __rmuxShareViewerCount?: {
      type: 'viewer_count';
      readers_active: number;
      readers_max: number;
      operator_connected: boolean;
      viewers_connected: number;
    };
  }
}
