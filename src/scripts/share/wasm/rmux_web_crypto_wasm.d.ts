/* tslint:disable */
/* eslint-disable */

/**
 * A derived client session: seals client-to-server frames and opens
 * server-to-client frames.
 */
export class ClientSession {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Derives the client session from the PSK, the X25519 DH shared secret,
     * and the exact handshake transcript bytes.
     *
     * - `psk`: `SHA-256(token)`, 32 bytes, computed in the browser.
     * - `dh`: X25519 shared secret, exactly 32 bytes, from WebCrypto.
     * - `client_hello` / `server_challenge`: exact wire bytes.
     */
    constructor(psk: Uint8Array, dh: Uint8Array, ml_kem_secret: Uint8Array, client_hello: Uint8Array, server_challenge: Uint8Array);
    /**
     * Opens a wire frame, returning a tagged [`Opened`] message.
     */
    open(frame: Uint8Array): Opened;
    /**
     * Seals a binary message, returning the wire frame.
     */
    sealBinary(body: Uint8Array): Uint8Array;
    /**
     * Seals a UTF-8 text message, returning the wire frame.
     */
    sealText(text: string): Uint8Array;
}

/**
 * A browser ML-KEM-768 keypair: generated from WebCrypto entropy, its secret key
 * never leaves WASM. The encapsulation key goes in the client hello; the server
 * ciphertext is decapsulated back into the hybrid ML-KEM shared secret.
 */
export class MlKemKeyPair {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Decapsulates the server ciphertext (exactly 1088 bytes) into the ML-KEM
     * shared secret (32 bytes). Fails closed on a wrong-length ciphertext.
     */
    decapsulate(ciphertext: Uint8Array): Uint8Array;
    /**
     * The encapsulation key to send in the client hello (1184 bytes).
     */
    encapsulationKey(): Uint8Array;
    /**
     * Generates a keypair from exactly 64 bytes of `crypto.getRandomValues`.
     */
    constructor(randomness: Uint8Array);
}

/**
 * A decrypted message returned to JavaScript. Exactly one of `text` / `binary`
 * is set, indicated by `isText`.
 */
export class Opened {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * The raw bytes, if this is a binary message.
     */
    readonly binary: Uint8Array | undefined;
    /**
     * `true` for a text message, `false` for a binary message.
     */
    readonly isText: boolean;
    /**
     * The UTF-8 text, if this is a text message.
     */
    readonly text: string | undefined;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_clientsession_free: (a: number, b: number) => void;
    readonly __wbg_mlkemkeypair_free: (a: number, b: number) => void;
    readonly __wbg_opened_free: (a: number, b: number) => void;
    readonly clientsession_new: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => void;
    readonly clientsession_open: (a: number, b: number, c: number, d: number) => void;
    readonly clientsession_sealBinary: (a: number, b: number, c: number, d: number) => void;
    readonly clientsession_sealText: (a: number, b: number, c: number, d: number) => void;
    readonly mlkemkeypair_decapsulate: (a: number, b: number, c: number, d: number) => void;
    readonly mlkemkeypair_encapsulationKey: (a: number, b: number) => void;
    readonly mlkemkeypair_new: (a: number, b: number, c: number) => void;
    readonly opened_binary: (a: number, b: number) => void;
    readonly opened_isText: (a: number) => number;
    readonly opened_text: (a: number, b: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export: (a: number, b: number) => number;
    readonly __wbindgen_export2: (a: number, b: number, c: number) => void;
    readonly __wbindgen_export3: (a: number, b: number, c: number, d: number) => number;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
