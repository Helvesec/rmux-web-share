/* tslint:disable */
/* eslint-disable */
export const memory: WebAssembly.Memory;
export const __wbg_clientsession_free: (a: number, b: number) => void;
export const __wbg_mlkemkeypair_free: (a: number, b: number) => void;
export const __wbg_opened_free: (a: number, b: number) => void;
export const clientsession_new: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => [number, number, number];
export const clientsession_open: (a: number, b: number, c: number) => [number, number, number];
export const clientsession_sealBinary: (a: number, b: number, c: number) => [number, number, number, number];
export const clientsession_sealText: (a: number, b: number, c: number) => [number, number, number, number];
export const mlkemkeypair_decapsulate: (a: number, b: number, c: number) => [number, number, number, number];
export const mlkemkeypair_encapsulationKey: (a: number) => [number, number];
export const mlkemkeypair_new: (a: number, b: number) => [number, number, number];
export const opened_binary: (a: number) => [number, number];
export const opened_isText: (a: number) => number;
export const opened_text: (a: number) => [number, number];
export const serversession_mlKemEncapsulate: (a: number, b: number, c: number, d: number) => [number, number, number, number];
export const serversession_new: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => [number, number, number];
export const serversession_sealText: (a: number, b: number, c: number) => [number, number, number, number];
export const serversession_sealBinary: (a: number, b: number, c: number) => [number, number, number, number];
export const serversession_open: (a: number, b: number, c: number) => [number, number, number];
export const __wbg_serversession_free: (a: number, b: number) => void;
export const __wbindgen_externrefs: WebAssembly.Table;
export const __wbindgen_malloc: (a: number, b: number) => number;
export const __externref_table_dealloc: (a: number) => void;
export const __wbindgen_free: (a: number, b: number, c: number) => void;
export const __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
export const __wbindgen_start: () => void;
