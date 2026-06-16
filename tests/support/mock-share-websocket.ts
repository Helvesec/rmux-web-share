// A browser-side mock of the rmux web-share daemon speaking the real v1
// protocol: ephemeral X25519 (WebCrypto) + ChaCha20-Poly1305 via the same
// `rmux-web-crypto` WASM test build (the `ServerSession` binding). Because it
// is injected with `page.addInitScript` (a serialized function with no module
// scope), it loads the test-only WASM at runtime from Vite's `/src/...` dev path.
// The production bundle only includes the client binding.
export function installMockShareWebSocket(): void {
  const NativeWebSocket = window.WebSocket;
  const nativeReplaceState = window.history.replaceState;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const serverNonce = 'EDEODQwLCgkIBwYFBAMCAQ';
  const PROTOCOL_VERSION = 1;
  const CAPABILITIES = ['e2ee-token-auth', 'terminal-palette-v1', 'pane-frame-v1'];

  // Loose typing for the dynamically imported WASM module.
  type WasmModule = {
    default: (input?: unknown) => Promise<unknown>;
    ServerSession: {
      new (
        psk: Uint8Array,
        dh: Uint8Array,
        mlKemSecret: Uint8Array,
        clientHello: Uint8Array,
        serverChallenge: Uint8Array,
      ): {
        sealText(text: string): Uint8Array;
        sealBinary(body: Uint8Array): Uint8Array;
        open(frame: Uint8Array): { isText: boolean; text?: string; binary?: Uint8Array };
      };
      /** Returns `ciphertext (1088) || shared_secret (32)`. */
      mlKemEncapsulate(encapsulationKey: Uint8Array, randomness: Uint8Array): Uint8Array;
    };
  };
  let wasmPromise: Promise<WasmModule> | undefined;
  function serverCrypto(): Promise<WasmModule> {
    if (!wasmPromise) {
      const wasmUrl = new URL('/src/scripts/share/wasm-test/rmux_web_crypto_wasm.js', window.location.href).href;
      wasmPromise = import(/* @vite-ignore */ wasmUrl).then(
        async (module) => {
          const wasm = module as unknown as WasmModule;
          await wasm.default();
          return wasm;
        },
      );
    }
    return wasmPromise;
  }

  window.history.replaceState = function replaceState(...args) {
    window.__rmuxShareMockToken ??= tokenFromLocation();
    return nativeReplaceState.apply(this, args);
  };

  type Session = InstanceType<WasmModule['ServerSession']>;

  class MockWebSocket extends EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    binaryType = 'blob';
    readyState = MockWebSocket.CONNECTING;
    sent: unknown[] = [];
    private session?: Session;
    private token = '';
    private readonly sessionReady: Promise<void>;
    private markSessionReady!: () => void;

    constructor(readonly url: string | URL) {
      super();
      this.sessionReady = new Promise((resolve) => {
        this.markSessionReady = resolve;
      });
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
      void this.handleSend(data);
    }

    close(): void {
      this.readyState = MockWebSocket.CLOSED;
      this.dispatchEvent(new CloseEvent('close', { code: 1000 }));
    }

    async serverText(message: unknown): Promise<void> {
      await this.dispatchEncryptedText(typeof message === 'string' ? message : JSON.stringify(message));
    }

    async serverBinary(bytes: Uint8Array | number[]): Promise<void> {
      await this.dispatchEncryptedBinary(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    }

    closeWith(code: number, reason: string): void {
      this.readyState = MockWebSocket.CLOSED;
      this.dispatchEvent(new CloseEvent('close', { code, reason }));
    }

    private async handleSend(data: unknown): Promise<void> {
      try {
        if (typeof data === 'string') {
          await this.handleHello(data);
          return;
        }
        const frame = data instanceof Uint8Array
          ? data
          : data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : undefined;
        if (!frame || !this.session) {
          this.closeWith(4000, 'handshake_rejected');
          return;
        }
        const message = this.session.open(frame);
        if (message.isText) {
          const text = message.text ?? '';
          this.sent.push(text);
          const parsed = JSON.parse(text);
          if (parsed.type === 'auth') {
            await this.handleAuth(parsed);
          } else if (parsed.type === 'logout') {
            window.setTimeout(() => this.closeWith(1000, 'session_closed'), 25);
          }
          return;
        }
        this.sent.push(Array.from(message.binary ?? new Uint8Array()));
      } catch {
        this.closeWith(4000, 'handshake_rejected');
      }
    }

    private async handleHello(data: string): Promise<void> {
      const hello = JSON.parse(data);
      if (hello.type !== 'hello') {
        this.closeWith(4000, 'handshake_rejected');
        return;
      }
      this.token = tokenFromLocation();
      const secretHash = await sha256(encoder.encode(this.token));
      const expectedTokenId = await tokenIdFromSecretHash(secretHash);
      if (hello.token_id !== expectedTokenId) {
        this.closeWith(4000, 'handshake_rejected');
        return;
      }
      this.sent.push({ type: 'hello', token_id: hello.token_id });

      // Server ephemeral X25519 + DH with the client's public key.
      const serverKeyPair = (await crypto.subtle.generateKey({ name: 'X25519' }, false, [
        'deriveBits',
      ])) as CryptoKeyPair;
      const serverPublic = new Uint8Array(await crypto.subtle.exportKey('raw', serverKeyPair.publicKey));
      const clientKey = await crypto.subtle.importKey(
        'raw',
        base64UrlDecode(hello.client_public),
        { name: 'X25519' },
        false,
        [],
      );
      const dh = new Uint8Array(
        await crypto.subtle.deriveBits({ name: 'X25519', public: clientKey }, serverKeyPair.privateKey, 256),
      );
      const psk = new Uint8Array(secretHash);
      const wasm = await serverCrypto();

      // Post-quantum hybrid: encapsulate to the client's ML-KEM key from the
      // hello. mlKemEncapsulate returns ciphertext(1088) || shared_secret(32).
      const encapsulated = wasm.ServerSession.mlKemEncapsulate(
        base64UrlDecode(hello.client_ml_kem_ek),
        crypto.getRandomValues(new Uint8Array(32)),
      );
      const mlKemCt = encapsulated.subarray(0, 1088);
      const mlKemSecret = encapsulated.subarray(1088);

      // The challenge text is bound (as bytes) into the transcript AND sent.
      const challengeText = JSON.stringify({
        type: 'challenge',
        protocol_version: PROTOCOL_VERSION,
        capabilities: CAPABILITIES,
        server_nonce: serverNonce,
        server_public: base64Url(serverPublic),
        server_ml_kem_ct: base64Url(mlKemCt),
      });

      this.session = new wasm.ServerSession(
        psk,
        dh,
        mlKemSecret,
        encoder.encode(data),
        encoder.encode(challengeText),
      );
      this.markSessionReady();
      this.dispatchMessage(challengeText);
    }

    private async handleAuth(auth: { pin?: string }): Promise<void> {
      if (window.__rmuxShareRequirePin && !auth.pin) {
        this.closeWith(4008, 'pin_required');
        return;
      }
      const role = window.__rmuxShareReadyRole
        ?? (this.token.includes('operator') ? 'operator' : 'spectator');
      const ready = {
        type: 'ready',
        protocol_version: PROTOCOL_VERSION,
        capabilities: CAPABILITIES,
        pane_size: window.__rmuxShareReadySize ?? { cols: 24, rows: 6 },
        scope: window.__rmuxShareReadyScope ?? 'pane',
        share_id: 'abcdefgh',
        session_name: 'ci',
        pane_label: '%1',
        role,
        operator: role === 'operator',
        operator_access: role === 'operator',
        spectator_access: window.__rmuxShareSpectatorAccess ?? true,
        controls: window.__rmuxShareReadyControls
          ?? (role === 'operator' && window.__rmuxShareReadyScope === 'session'),
        show_viewers: window.__rmuxShareShowViewers ?? true,
        operators_active: window.__rmuxShareReadyOperatorsActive ?? 0,
        operators_max: window.__rmuxShareReadyOperatorsMax ?? 1,
        spectator_pairing_code: role === 'operator'
          ? window.__rmuxShareSpectatorPairingCode
          : undefined,
        ttl_remaining_seconds: 60,
        spectators_active: window.__rmuxShareReadySpectatorsActive ?? 1,
        spectators_max: window.__rmuxShareReadySpectatorsMax ?? 5,
        viewers_connected: 1,
        terminal_palette: window.__rmuxShareTerminalPalette,
      };
      await this.dispatchEncryptedText(JSON.stringify(ready));
      await this.dispatchEncryptedText(JSON.stringify(window.__rmuxShareViewerCount ?? {
        type: 'viewer_count',
        spectators_active: 2,
        spectators_max: 5,
        operators_active: 1,
        viewers_connected: 3,
      }));
      await this.dispatchEncryptedBinary(
        new Uint8Array([0x10, ...encoder.encode(window.__rmuxShareInitialSnapshot ?? 'hello from rmux')]),
      );
      if (window.__rmuxShareSessionView) {
        await this.dispatchEncryptedBinary(
          new Uint8Array([0x11, ...encoder.encode(JSON.stringify(window.__rmuxShareSessionView))]),
        );
      }
      for (const frame of window.__rmuxSharePostSnapshotFrames ?? []) {
        await this.dispatchEncryptedBinary(new Uint8Array(frame));
      }
    }

    private async dispatchEncryptedText(text: string): Promise<void> {
      await this.sessionReady;
      if (!this.session) {
        return;
      }
      this.dispatchMessage(this.session.sealText(text).buffer);
    }

    private async dispatchEncryptedBinary(bytes: Uint8Array): Promise<void> {
      await this.sessionReady;
      if (!this.session) {
        return;
      }
      this.dispatchMessage(this.session.sealBinary(bytes).buffer);
    }

    private dispatchMessage(data: string | ArrayBuffer): void {
      this.dispatchEvent(new MessageEvent('message', { data }));
    }
  }

  async function tokenIdFromSecretHash(secretHash: ArrayBuffer): Promise<string> {
    const digest = await sha256(concatBytes(encoder.encode('rmux-token-id-v1'), new Uint8Array(secretHash)));
    return base64Url(new Uint8Array(digest).subarray(0, 16));
  }

  async function sha256(bytes: Uint8Array): Promise<ArrayBuffer> {
    return crypto.subtle.digest('SHA-256', bytes);
  }

  function tokenFromLocation(): string {
    return new URLSearchParams(window.location.hash.replace(/^#/, '')).get('t')
      ?? window.__rmuxShareMockToken
      ?? '';
  }

  function base64Url(bytes: Uint8Array): string {
    let binary = '';
    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
  }

  function base64UrlDecode(value: string): Uint8Array {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  function concatBytes(...chunks: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }

  Object.defineProperty(window, 'WebSocket', {
    configurable: true,
    value: MockWebSocket,
  });
}

declare global {
  interface Window {
    __rmuxShareReadyControls?: boolean;
    __rmuxShareReadyRole?: 'spectator' | 'operator';
    __rmuxShareReadyScope?: 'pane' | 'session';
    __rmuxShareReadySize?: { cols: number; rows: number };
    __rmuxShareReadyOperatorsActive?: number;
    __rmuxShareReadyOperatorsMax?: number;
    __rmuxShareReadySpectatorsActive?: number;
    __rmuxShareReadySpectatorsMax?: number;
    __rmuxShareSpectatorAccess?: boolean;
    __rmuxShareSessionView?: {
      size: { cols: number; rows: number };
      panes: Array<{
        id: number;
        x: number;
        y: number;
        cols: number;
        rows: number;
        active?: boolean;
        history_size: number;
        scroll_offset: number;
        alternate_on: boolean;
        mouse_on?: boolean;
      }>;
      windows?: Array<{
        index: number;
        name: string;
        active: boolean;
      }>;
    };
    __rmuxShareRequirePin?: boolean;
    __rmuxShareShowViewers?: boolean;
    __rmuxShareSpectatorPairingCode?: string;
    __rmuxShareSockets?: Array<{
      sent: unknown[];
      serverText(message: unknown): Promise<void>;
      serverBinary(bytes: Uint8Array | number[]): Promise<void>;
      closeWith(code: number, reason: string): void;
    }>;
    __rmuxSharePostSnapshotFrames?: ArrayBuffer[];
    __rmuxShareInitialSnapshot?: string;
    __rmuxShareTerminalPalette?: {
      foreground: string;
      background: string;
      cursor: string;
      ansi: string[];
    };
    __rmuxShareViewerCount?: {
      type: 'viewer_count';
      spectators_active: number;
      spectators_max: number;
      operators_active: number;
      operators_max?: number;
      viewers_connected: number;
    };
    __rmuxShareMockToken?: string;
  }
}
