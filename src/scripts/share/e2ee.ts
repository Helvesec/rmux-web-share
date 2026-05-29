import type { ShareParams } from './types';
import { WEB_SHARE_CLIENT_CAPABILITIES, WEB_SHARE_PROTOCOL_VERSION } from './wire';

const ENCRYPTED_FRAME = 0xe0;
const PLAINTEXT_TEXT = 0x00;
const PLAINTEXT_BINARY = 0x01;
const CLIENT_DIRECTION = 'c2s';
const SERVER_DIRECTION = 's2c';
const TOKEN_ID_DOMAIN = 'rmux-token-id-v1';
const SPECTATOR_TOKEN_INFO = 'rmux read token v1';
const INFO_KEY_PREFIX = 'rmux web-share e2ee v1 key ';
const INFO_NONCE_PREFIX = 'rmux web-share e2ee v1 nonce ';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface ClientHello {
  text: string;
  state: ClientHandshakeState;
}

export interface ClientHandshakeState {
  tokenId: string;
  clientNonce: string;
  secretHash: ArrayBuffer;
}

export interface ChallengeMessage {
  type: 'challenge';
  protocol_version: number;
  capabilities: string[];
  server_nonce: string;
}

export type DecryptedWebSocketMessage =
  | { type: 'text'; text: string }
  | { type: 'binary'; bytes: Uint8Array };

export class EncryptedShareTransport {
  private openChain = Promise.resolve();
  private sendChain = Promise.resolve();

  constructor(
    private readonly socket: WebSocket,
    private readonly opener: FrameCodec,
    private readonly sealer: FrameCodec,
  ) {}

  get readyState(): number {
    return this.socket.readyState;
  }

  sendText(text: string): void {
    this.queueSend(PLAINTEXT_TEXT, encoder.encode(text));
  }

  sendBinary(bytes: Uint8Array): void {
    this.queueSend(PLAINTEXT_BINARY, bytes);
  }

  async open(data: ArrayBuffer): Promise<DecryptedWebSocketMessage> {
    const frame = new Uint8Array(data);
    const task = this.openChain.then(() => this.openFrame(frame));
    this.openChain = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  private async openFrame(frame: Uint8Array): Promise<DecryptedWebSocketMessage> {
    const plain = await this.opener.open(frame);
    const kind = plain[0];
    const body = plain.subarray(1);
    if (kind === PLAINTEXT_TEXT) {
      return { type: 'text', text: decoder.decode(body) };
    }
    if (kind === PLAINTEXT_BINARY) {
      return { type: 'binary', bytes: body };
    }
    throw new Error('unknown encrypted frame kind');
  }

  private queueSend(kind: number, body: Uint8Array): void {
    const payload = copyPlaintext(kind, body);
    this.sendChain = this.sendChain.then(async () => {
      if (this.socket.readyState !== WebSocket.OPEN) {
        return;
      }
      this.socket.send(await this.sealer.seal(payload));
    });
    this.sendChain.catch(() => this.socket.close(4006, 'e2ee_encrypt_failed'));
  }
}

export async function createClientHello(params: ShareParams): Promise<ClientHello> {
  const secretHash = await sha256(encoder.encode(params.token));
  const tokenId = await tokenIdForToken(params.token);
  const clientNonce = randomNonce();
  return {
    text: JSON.stringify({
      type: 'hello',
      protocol_version: WEB_SHARE_PROTOCOL_VERSION,
      capabilities: WEB_SHARE_CLIENT_CAPABILITIES,
      token_id: tokenId,
      client_nonce: clientNonce,
    }),
    state: {
      tokenId,
      clientNonce,
      secretHash,
    },
  };
}

export async function tokenIdForToken(token: string): Promise<string> {
  const secretHash = await sha256(encoder.encode(token));
  const tokenId = await sha256(concatBytes(
    encoder.encode(TOKEN_ID_DOMAIN),
    new Uint8Array(secretHash),
  ));
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

export async function createEncryptedTransport(
  socket: WebSocket,
  state: ClientHandshakeState,
  challenge: ChallengeMessage,
): Promise<EncryptedShareTransport> {
  validateChallenge(challenge);
  const salt = concatBytes(
    encoder.encode(state.tokenId),
    base64UrlDecode(state.clientNonce),
    base64UrlDecode(challenge.server_nonce),
  );
  const opener = await FrameCodec.derive(state.secretHash, salt, SERVER_DIRECTION);
  const sealer = await FrameCodec.derive(state.secretHash, salt, CLIENT_DIRECTION);
  return new EncryptedShareTransport(socket, opener, sealer);
}

export function parseChallenge(data: string): ChallengeMessage {
  const parsed = JSON.parse(data) as Partial<ChallengeMessage>;
  if (parsed.type !== 'challenge') {
    throw new Error('first server frame must be e2ee challenge');
  }
  return parsed as ChallengeMessage;
}

function validateChallenge(challenge: ChallengeMessage): void {
  if (
    challenge.protocol_version !== WEB_SHARE_PROTOCOL_VERSION
    || !challenge.capabilities?.includes('e2ee-token-auth')
    || base64UrlDecode(challenge.server_nonce).length !== 16
  ) {
    throw new Error('invalid e2ee challenge');
  }
}

class FrameCodec {
  private nextSeq = 0n;

  private constructor(
    private readonly key: CryptoKey,
    private readonly noncePrefix: Uint8Array,
  ) {}

  static async derive(secretHash: ArrayBuffer, salt: Uint8Array, direction: string): Promise<FrameCodec> {
    const key = await deriveAesKey(secretHash, salt, `${INFO_KEY_PREFIX}${direction}`);
    const noncePrefix = await deriveBits(secretHash, salt, `${INFO_NONCE_PREFIX}${direction}`, 32);
    return new FrameCodec(key, noncePrefix);
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

  async open(frame: Uint8Array): Promise<Uint8Array> {
    if (frame.length < 25 || frame[0] !== ENCRYPTED_FRAME) {
      throw new Error('invalid encrypted frame');
    }
    const seq = readSeq(frame.subarray(1, 9));
    if (seq !== this.nextSeq) {
      throw new Error('out-of-order encrypted frame');
    }
    const plain = new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonceFrom(this.noncePrefix, seq), additionalData: frame.subarray(0, 9) },
      this.key,
      frame.subarray(9),
    ));
    this.nextSeq += 1n;
    return plain;
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

async function deriveBits(
  secretHash: ArrayBuffer,
  salt: Uint8Array,
  info: string,
  bits: number,
): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey('raw', secretHash, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: encoder.encode(info) },
    keyMaterial,
    bits,
  ));
}

function encryptedHeader(seq: bigint): Uint8Array {
  const header = new Uint8Array(9);
  header[0] = ENCRYPTED_FRAME;
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

function copyPlaintext(kind: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + body.length);
  out[0] = kind;
  out.set(body, 1);
  return out;
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
