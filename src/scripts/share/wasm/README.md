# rmux-web-crypto-wasm

WebAssembly bindings exposing the rmux web-share **client** record channel
(`sealed-channel` + the kind-byte framing from `rmux-web-crypto`) to the browser.

It contains **no crypto of its own** — it reuses the exact key-schedule and
ChaCha20-Poly1305 record framing the native rmux daemon uses, so the wire format
has a single source of truth across the daemon and the browser. The asymmetric
half (ephemeral X25519 + `SHA-256(token)`) is done by the browser's WebCrypto;
the X25519 private key stays a **non-extractable** WebCrypto key and never enters
WASM linear memory. That is why this crate is built **without** `x25519-dalek`
(`rmux-web-crypto` is depended on with `default-features = false`).

## Build runbook (requires tooling not present in every environment)

These steps need `wasm-pack` (`cargo install wasm-pack`), the matching
`wasm-bindgen-cli`, and `wasm-opt` (from `binaryen`). They were **not run in the
authoring sandbox** (the crate is only verified to compile to
`wasm32-unknown-unknown`); run them in your build environment:

```sh
# 1. Build the wasm module + JS bindings straight into the frontend.
wasm-pack build rmux-web-crypto-wasm --release --target web \
  --out-dir ../rmux-web-share/src/scripts/share/wasm

# 2. Shrink the wasm (the release build is already small; -Oz trims further).
wasm-opt -Oz \
  ../rmux-web-share/src/scripts/share/wasm/rmux_web_crypto_wasm_bg.wasm \
  -o ../rmux-web-share/src/scripts/share/wasm/rmux_web_crypto_wasm_bg.wasm

# 3. Build the frontend and check the bundle budget.
cd ../rmux-web-share && npm run build      # runs scripts/check-share-bundle-budget.mjs

# 4. End-to-end tests (needs `npx playwright install` once).
npm run test:e2e
```

`src/scripts/share/e2ee.ts` imports the generated module from
`./wasm/rmux_web_crypto_wasm.js` (default export = the `init` function,
`ClientSession` = the session class). Adjust `--out-dir` if you place the `pkg`
elsewhere.

## CSP

Loading WASM requires the page CSP to allow it:

```
script-src 'self' 'wasm-unsafe-eval'
```

Use `'wasm-unsafe-eval'` (WASM compilation only), **not** the broader
`'unsafe-eval'`. If a target browser cannot run with `'wasm-unsafe-eval'`, refuse
the E2EE mode rather than loosening the policy.
