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
     * Derives the client session from the PSK, the X25519 DH shared secret, and
     * the exact handshake transcript bytes.
     *
     * - `psk`: `SHA-256(token)`, 32 bytes (computed in the browser).
     * - `dh`: the X25519 shared secret, exactly 32 bytes (from WebCrypto).
     * - `client_hello` / `server_challenge`: the exact wire bytes of the two
     *   handshake messages, as sent/received.
     */
    constructor(psk: Uint8Array, dh: Uint8Array, client_hello: Uint8Array, server_challenge: Uint8Array);
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

/**
 * The **server** side of a session. Not used by the production browser client
 * (the daemon is the server); it exists so browser-side tests can drive a real
 * v4 server against [`ClientSession`], exercising the exact native code path.
 */
export class ServerSession {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Derives the server session. Mirrors [`ClientSession::new`] but seals the
     * server-to-client direction and opens client-to-server.
     */
    constructor(psk: Uint8Array, dh: Uint8Array, client_hello: Uint8Array, server_challenge: Uint8Array);
    /**
     * Opens a client-to-server wire frame.
     */
    open(frame: Uint8Array): Opened;
    /**
     * Seals a binary message (server to client).
     */
    sealBinary(body: Uint8Array): Uint8Array;
    /**
     * Seals a UTF-8 text message (server to client).
     */
    sealText(text: string): Uint8Array;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_clientsession_free: (a: number, b: number) => void;
    readonly __wbg_opened_free: (a: number, b: number) => void;
    readonly __wbg_serversession_free: (a: number, b: number) => void;
    readonly clientsession_new: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number];
    readonly clientsession_open: (a: number, b: number, c: number) => [number, number, number];
    readonly clientsession_sealBinary: (a: number, b: number, c: number) => [number, number, number, number];
    readonly clientsession_sealText: (a: number, b: number, c: number) => [number, number, number, number];
    readonly opened_binary: (a: number) => [number, number];
    readonly opened_isText: (a: number) => number;
    readonly opened_text: (a: number) => [number, number];
    readonly serversession_new: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number];
    readonly serversession_open: (a: number, b: number, c: number) => [number, number, number];
    readonly serversession_sealBinary: (a: number, b: number, c: number) => [number, number, number, number];
    readonly serversession_sealText: (a: number, b: number, c: number) => [number, number, number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_start: () => void;
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
