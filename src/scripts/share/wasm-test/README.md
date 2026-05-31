# rmux-web-crypto test WASM

This directory is the Playwright-only WASM build of `rmux-web-crypto`.

It is built with `--features wasm-test`, which exposes `ServerSession` so the
browser-side daemon mock can speak the real encrypted protocol. The production
frontend imports `../wasm/` instead, which exposes only `ClientSession`.
