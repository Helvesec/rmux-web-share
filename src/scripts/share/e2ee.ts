import type { ShareParams } from './types';
import { WEB_SHARE_CLIENT_CAPABILITIES, WEB_SHARE_PROTOCOL_VERSION } from './wire';
// WebAssembly client crypto (rmux-web-crypto record layer + ML-KEM-768 + kind-byte
// framing). Build from the rmux workspace with rmux/scripts/build-web-crypto-wasm.sh
// (wasm-pack, --out-name rmux_web_crypto_wasm, wasm-opt disabled for determinism).
import initWasm, { ClientSession, MlKemKeyPair } from './wasm/rmux_web_crypto_wasm.js';
import wasmUrl from './wasm/rmux_web_crypto_wasm_bg.wasm?url';

/** ML-KEM-768 sizes (FIPS 203). */
const ML_KEM_KEYGEN_RANDOMNESS_LEN = 64;
const ML_KEM_CIPHERTEXT_LEN = 1088;

const TOKEN_ID_DOMAIN = 'rmux-token-id-v1';
const SPECTATOR_TOKEN_INFO = 'rmux read token v1';

const encoder = new TextEncoder();

// Replaced at build time by scripts/inject-integrity.mjs with the WASM's
// `sha256-<base64>`. The regex guard (not a literal compare) keeps the bundler
// from constant-folding the placeholder away, so both the pinned branch and the
// token survive into dist for the post-build replacement. In dev (placeholder
// intact) we skip pinning and let the loader resolve the URL itself. This pins
// the wasm only relative to an honest bundle; a malicious origin can ship JS that
// omits the pin — it is not protection against a compromised host.
const WASM_INTEGRITY = '__RMUX_WASM_INTEGRITY__';

let wasmReady: Promise<void> | undefined;

/** Lazily initialises the WASM crypto module exactly once. */
function ensureWasm(): Promise<void> {
  if (!wasmReady) {
    const init = /^sha256-/.test(WASM_INTEGRITY)
      ? initWasm({ module_or_path: new Request(wasmUrl, { integrity: WASM_INTEGRITY }) })
      : initWasm();
    wasmReady = init.then(() => undefined);
  }
  return wasmReady;
}

/**
 * Client-side handshake state carried between the hello and the challenge.
 *
 * `privateKey` is a **non-extractable** WebCrypto X25519 private key: it never
 * leaves the WebCrypto subsystem and never enters WASM linear memory, so an XSS
 * cannot exfiltrate it. `helloText` is the exact hello text we sent — it is
 * bound, byte-for-byte, into the session transcript (never re-serialised).
 */
export interface ClientHandshakeState {
  tokenId: string;
  clientNonce: string;
  helloText: string;
  privateKey: CryptoKey;
  /** The ML-KEM keypair; its secret key stays inside WASM. Used to decapsulate
   * the server ciphertext into the hybrid ML-KEM shared secret. */
  mlKem: MlKemKeyPair;
  psk: Uint8Array;
}

export interface ChallengeMessage {
  type: 'challenge';
  protocol_version: number;
  capabilities: string[];
  server_nonce: string;
  server_public: string;
  /** The server's ML-KEM-768 ciphertext (base64url, 1088 bytes). */
  server_ml_kem_ct: string;
  /** The exact challenge text received, bound into the transcript. */
  raw: string;
}

export type DecryptedWebSocketMessage =
  | { type: 'text'; text: string }
  | { type: 'binary'; bytes: Uint8Array };

/**
 * A forward-secret, authenticated transport over the WebSocket. All record
 * sealing/opening is delegated to the WASM `ClientSession`, which runs the exact
 * same ChaCha20-Poly1305 + HKDF code as the native rmux daemon.
 */
export class EncryptedShareTransport {
  private openChain = Promise.resolve();
  private sendChain = Promise.resolve();

  constructor(
    private readonly socket: WebSocket,
    private readonly session: ClientSession,
  ) {}

  get readyState(): number {
    return this.socket.readyState;
  }

  sendText(text: string): void {
    this.queueSend(() => this.session.sealText(text));
  }

  sendBinary(bytes: Uint8Array): void {
    this.queueSend(() => this.session.sealBinary(bytes));
  }

  async open(data: ArrayBuffer): Promise<DecryptedWebSocketMessage> {
    const frame = new Uint8Array(data);
    const task = this.openChain.then((): DecryptedWebSocketMessage => {
      const opened = this.session.open(frame);
      if (opened.isText) {
        return { type: 'text', text: opened.text ?? '' };
      }
      return { type: 'binary', bytes: opened.binary ?? new Uint8Array() };
    });
    this.openChain = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  private queueSend(seal: () => Uint8Array): void {
    this.sendChain = this.sendChain.then(() => {
      if (this.socket.readyState !== WebSocket.OPEN) {
        return;
      }
      this.socket.send(seal());
    });
    this.sendChain.catch(() => this.socket.close(4006, 'e2ee_encrypt_failed'));
  }
}

export async function createClientHello(
  params: ShareParams,
): Promise<{ text: string; state: ClientHandshakeState }> {
  await ensureWasm();
  const psk = new Uint8Array(await sha256(encoder.encode(params.token)));
  const tokenId = await tokenIdForToken(params.token);
  const clientNonce = randomNonce();

  // Ephemeral X25519 key pair; the private key is non-extractable (forward
  // secrecy + XSS cannot steal it). The public key is exported raw (32 bytes).
  const keyPair = (await crypto.subtle.generateKey({ name: 'X25519' }, false, [
    'deriveBits',
  ])) as CryptoKeyPair;
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));

  // ML-KEM-768 keypair (post-quantum hybrid). Keygen entropy is WebCrypto; the
  // secret key never leaves WASM. The encapsulation key rides in the hello, so
  // the transcript binds it.
  const mlKem = new MlKemKeyPair(crypto.getRandomValues(new Uint8Array(ML_KEM_KEYGEN_RANDOMNESS_LEN)));

  const text = JSON.stringify({
    type: 'hello',
    protocol_version: WEB_SHARE_PROTOCOL_VERSION,
    capabilities: WEB_SHARE_CLIENT_CAPABILITIES,
    token_id: tokenId,
    client_nonce: clientNonce,
    client_public: base64Url(publicRaw),
    client_ml_kem_ek: base64Url(mlKem.encapsulationKey()),
  });

  return {
    text,
    state: { tokenId, clientNonce, helloText: text, privateKey: keyPair.privateKey, mlKem, psk },
  };
}

export function parseChallenge(data: string): ChallengeMessage {
  const parsed = JSON.parse(data) as Partial<ChallengeMessage>;
  if (parsed.type !== 'challenge') {
    throw new Error('first server frame must be e2ee challenge');
  }
  return { ...(parsed as ChallengeMessage), raw: data };
}

export async function createEncryptedTransport(
  socket: WebSocket,
  state: ClientHandshakeState,
  challenge: ChallengeMessage,
): Promise<EncryptedShareTransport> {
  await ensureWasm();
  validateChallenge(challenge);

  const serverPublic = base64UrlDecode(challenge.server_public);
  const serverKey = await crypto.subtle.importKey('raw', serverPublic, { name: 'X25519' }, false, []);
  // X25519 Diffie-Hellman: 32-byte shared secret. The ephemeral private key is
  // consumed conceptually here; it is dropped with the handshake state.
  const dh = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'X25519', public: serverKey }, state.privateKey, 256),
  );

  // Decapsulate the server's ML-KEM ciphertext into the hybrid shared secret.
  // The exact length was validated above; the WASM wrapper rejects any mismatch.
  // The keypair is used exactly once, so free it immediately to shrink the window
  // the ML-KEM decapsulation key lives in WASM linear memory.
  const mlKemSecret = state.mlKem.decapsulate(base64UrlDecode(challenge.server_ml_kem_ct));
  state.mlKem.free();

  // Derive the session in WASM, binding the EXACT hello + challenge bytes and
  // mixing both the X25519 and ML-KEM shared secrets.
  const session = new ClientSession(
    state.psk,
    dh,
    mlKemSecret,
    encoder.encode(state.helloText),
    encoder.encode(challenge.raw),
  );
  // Best-effort wipe now the WASM session owns its own copies. `dh` and the
  // ML-KEM secret carry forward secrecy and are not recomputable; `psk` is
  // SHA-256(token), re-derivable from params.token. Partial only: params.token
  // is an immutable un-wipeable string and the WASM linear-memory scratch copy
  // cannot be reached from JS (the X25519 private key is already non-extractable).
  mlKemSecret.fill(0);
  dh.fill(0);
  state.psk.fill(0);
  return new EncryptedShareTransport(socket, session);
}

function validateChallenge(challenge: ChallengeMessage): void {
  if (
    challenge.protocol_version !== WEB_SHARE_PROTOCOL_VERSION ||
    !challenge.capabilities?.includes('e2ee-token-auth') ||
    base64UrlDecode(challenge.server_nonce).length !== 16 ||
    base64UrlDecode(challenge.server_public).length !== 32 ||
    base64UrlDecode(challenge.server_ml_kem_ct).length !== ML_KEM_CIPHERTEXT_LEN
  ) {
    throw new Error('invalid e2ee challenge');
  }
}

export async function tokenIdForToken(token: string): Promise<string> {
  const secretHash = await sha256(encoder.encode(token));
  const tokenId = await sha256(
    concatBytes(encoder.encode(TOKEN_ID_DOMAIN), new Uint8Array(secretHash)),
  );
  return base64Url(new Uint8Array(tokenId).subarray(0, 16));
}

export async function deriveSpectatorToken(operatorToken: string): Promise<string> {
  const secret = base64UrlDecode(operatorToken);
  if (secret.length !== 32) {
    throw new Error('operator token is not derivable');
  }
  const keyMaterial = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits']);
  const derived = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(),
      info: encoder.encode(SPECTATOR_TOKEN_INFO),
    },
    keyMaterial,
    256,
  );
  return base64Url(new Uint8Array(derived));
}

async function sha256(bytes: Uint8Array): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', bytes);
}

function randomNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return base64Url(bytes);
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
