export function installMockShareWebSocket(): void {
  const NativeWebSocket = window.WebSocket;
  const nativeReplaceState = window.history.replaceState;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const serverNonce = 'EDEODQwLCgkIBwYFBAMCAQ';

  window.history.replaceState = function replaceState(...args) {
    window.__rmuxShareMockToken ??= tokenFromLocation();
    return nativeReplaceState.apply(this, args);
  };

  class MockWebSocket extends EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    binaryType = 'blob';
    readyState = MockWebSocket.CONNECTING;
    sent: unknown[] = [];
    private opener?: FrameCodec;
    private sealer?: FrameCodec;
    private token = '';

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
      void this.handleSend(data);
    }

    close(): void {
      this.readyState = MockWebSocket.CLOSED;
      this.dispatchEvent(new CloseEvent('close', { code: 1000 }));
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
        if (!frame || !this.opener) {
          this.closeWith(4006, 'invalid_frame');
          return;
        }
        const message = await this.opener.open(frame);
        if (message.kind === 0) {
          const text = decoder.decode(message.body);
          this.sent.push(text);
          const parsed = JSON.parse(text);
          if (parsed.type === 'auth') {
            await this.handleAuth(parsed);
          } else if (parsed.type === 'logout') {
            this.close();
          }
          return;
        }
        this.sent.push(Array.from(message.body));
      } catch {
        this.closeWith(4006, 'e2ee_failed');
      }
    }

    private async handleHello(data: string): Promise<void> {
      const hello = JSON.parse(data);
      if (hello.type !== 'hello') {
        this.closeWith(4006, 'first_frame_must_hello');
        return;
      }
      this.token = tokenFromLocation();
      const secretHash = await sha256(encoder.encode(this.token));
      const expectedTokenId = await tokenIdFromSecretHash(secretHash);
      if (hello.token_id !== expectedTokenId) {
        this.closeWith(4000, 'invalid_auth');
        return;
      }
      this.sent.push({ type: 'hello', token_id: hello.token_id });
      const salt = concatBytes(
        encoder.encode(hello.token_id),
        base64UrlDecode(hello.client_nonce),
        base64UrlDecode(serverNonce),
      );
      this.opener = await FrameCodec.derive(secretHash, salt, 'c2s');
      this.sealer = await FrameCodec.derive(secretHash, salt, 's2c');
      this.dispatchMessage(JSON.stringify({
        type: 'challenge',
        protocol_version: 3,
        capabilities: ['e2ee-token-auth', 'terminal-palette-v1'],
        server_nonce: serverNonce,
      }));
    }

    private async handleAuth(auth: { pin?: string }): Promise<void> {
      if (window.__rmuxShareRequirePin && !auth.pin) {
        this.closeWith(4008, 'pin_required');
        return;
      }
      const role = window.__rmuxShareReadyRole
        ?? (this.token.includes('operator') ? 'operator' : 'read');
      const ready = {
        type: 'ready',
        protocol_version: 3,
        capabilities: ['e2ee-token-auth', 'terminal-palette-v1'],
        pane_size: window.__rmuxShareReadySize ?? { cols: 24, rows: 6 },
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
      await this.dispatchEncryptedText(JSON.stringify(ready));
      await this.dispatchEncryptedText(JSON.stringify(window.__rmuxShareViewerCount ?? {
        type: 'viewer_count',
        readers_active: 2,
        readers_max: 5,
        operator_connected: true,
        viewers_connected: 3,
      }));
      await this.dispatchEncryptedBinary(
        new Uint8Array([0x10, ...encoder.encode(window.__rmuxShareInitialSnapshot ?? 'hello from rmux')]),
      );
      for (const frame of window.__rmuxSharePostSnapshotFrames ?? []) {
        await this.dispatchEncryptedBinary(new Uint8Array(frame));
      }
    }

    private async dispatchEncryptedText(text: string): Promise<void> {
      await this.dispatchEncrypted(0, encoder.encode(text));
    }

    private async dispatchEncryptedBinary(bytes: Uint8Array): Promise<void> {
      await this.dispatchEncrypted(1, bytes);
    }

    private async dispatchEncrypted(kind: number, body: Uint8Array): Promise<void> {
      if (!this.sealer) {
        return;
      }
      const payload = new Uint8Array(1 + body.length);
      payload[0] = kind;
      payload.set(body, 1);
      this.dispatchMessage((await this.sealer.seal(payload)).buffer);
    }

    private dispatchMessage(data: string | ArrayBuffer): void {
      this.dispatchEvent(new MessageEvent('message', { data }));
    }

    private closeWith(code: number, reason: string): void {
      this.readyState = MockWebSocket.CLOSED;
      this.dispatchEvent(new CloseEvent('close', { code, reason }));
    }
  }

  class FrameCodec {
    private nextSeq = 0n;

    constructor(
      private readonly key: CryptoKey,
      private readonly noncePrefix: Uint8Array,
    ) {}

    static async derive(secretHash: ArrayBuffer, salt: Uint8Array, direction: string): Promise<FrameCodec> {
      return new FrameCodec(
        await deriveAesKey(secretHash, salt, `rmux web-share e2ee v1 key ${direction}`),
        await deriveBits(secretHash, salt, `rmux web-share e2ee v1 nonce ${direction}`, 32),
      );
    }

    async seal(plain: Uint8Array): Promise<Uint8Array> {
      const seq = this.nextSeq;
      const header = encryptedHeader(seq);
      const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: nonceFrom(this.noncePrefix, seq), additionalData: header },
        this.key,
        plain,
      ));
      this.nextSeq += 1n;
      return concatBytes(header, ciphertext);
    }

    async open(frame: Uint8Array): Promise<{ kind: number; body: Uint8Array }> {
      const seq = readSeq(frame.subarray(1, 9));
      const plain = new Uint8Array(await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: nonceFrom(this.noncePrefix, seq), additionalData: frame.subarray(0, 9) },
        this.key,
        frame.subarray(9),
      ));
      this.nextSeq += 1n;
      return { kind: plain[0], body: plain.subarray(1) };
    }
  }

  async function deriveAesKey(secretHash: ArrayBuffer, salt: Uint8Array, info: string): Promise<CryptoKey> {
    const keyMaterial = await crypto.subtle.importKey('raw', secretHash, 'HKDF', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt, info: encoder.encode(info) },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  }

  async function deriveBits(secretHash: ArrayBuffer, salt: Uint8Array, info: string, bits: number): Promise<Uint8Array> {
    const keyMaterial = await crypto.subtle.importKey('raw', secretHash, 'HKDF', false, ['deriveBits']);
    return new Uint8Array(await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt, info: encoder.encode(info) },
      keyMaterial,
      bits,
    ));
  }

  async function tokenIdFromSecretHash(secretHash: ArrayBuffer): Promise<string> {
    const digest = await sha256(concatBytes(encoder.encode('rmux-token-id-v1'), new Uint8Array(secretHash)));
    return base64Url(new Uint8Array(digest).subarray(0, 16));
  }

  async function sha256(bytes: Uint8Array): Promise<ArrayBuffer> {
    return crypto.subtle.digest('SHA-256', bytes);
  }

  function encryptedHeader(seq: bigint): Uint8Array {
    const header = new Uint8Array(9);
    header[0] = 0xe0;
    writeSeq(header, 1, seq);
    return header;
  }

  function nonceFrom(prefix: Uint8Array, seq: bigint): Uint8Array {
    const nonce = new Uint8Array(12);
    nonce.set(prefix, 0);
    writeSeq(nonce, 4, seq);
    return nonce;
  }

  function writeSeq(target: Uint8Array, offset: number, seq: bigint): void {
    for (let index = 7; index >= 0; index -= 1) {
      target[offset + index] = Number(seq & 0xffn);
      seq >>= 8n;
    }
  }

  function readSeq(bytes: Uint8Array): bigint {
    let seq = 0n;
    for (const byte of bytes) {
      seq = (seq << 8n) | BigInt(byte);
    }
    return seq;
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
    __rmuxShareReadyRole?: 'read' | 'operator';
    __rmuxShareReadyScope?: 'pane' | 'session';
    __rmuxShareReadySize?: { cols: number; rows: number };
    __rmuxShareRequirePin?: boolean;
    __rmuxShareShowViewers?: boolean;
    __rmuxShareSockets?: Array<{ sent: unknown[] }>;
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
      readers_active: number;
      readers_max: number;
      operator_connected: boolean;
      viewers_connected: number;
    };
    __rmuxShareMockToken?: string;
  }
}
