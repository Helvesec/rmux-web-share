// Post-build integrity injection. Runs after `astro build` and BEFORE
// write-build-provenance.mjs, so the provenance/checksums describe the final
// served bytes; index.html is re-hashed after integrity injection.
//
// 1. Pin the single crypto WASM: compute its sha256 and replace the
//    `__RMUX_WASM_INTEGRITY__` placeholder that e2ee.ts carries into the built
//    JS — done first, so the JS bytes are final before they are hashed for SRI.
// 2. Add Subresource Integrity (+ crossorigin) to the /_astro script and
//    stylesheet referenced by index.html.
//
// Scope guard: SRI cannot protect index.html itself on a host that rewrites it,
// and a malicious origin can ship a bundle that omits the wasm pin. This catches
// a tampered subresource under an otherwise-honest entry document only.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const distRoot = fileURLToPath(new URL('../dist/', import.meta.url));
const astroDir = join(distRoot, '_astro');
const indexPath = join(distRoot, 'index.html');
const WASM_PLACEHOLDER = '__RMUX_WASM_INTEGRITY__';

const sriFor = (file) => `sha256-${createHash('sha256').update(readFileSync(file)).digest('base64')}`;

const astroFiles = readdirSync(astroDir);

// 1. WASM pin. Match the crypto WASM explicitly and require exactly one, so a
// future second .wasm cannot silently leave the wrong (or no) file pinned.
const wasmFiles = astroFiles.filter((name) => /^rmux_web_crypto_wasm_bg\..*\.wasm$/.test(name));
if (wasmFiles.length !== 1) {
  throw new Error(`inject-integrity: expected exactly one crypto .wasm in dist/_astro, found ${wasmFiles.length}`);
}
const wasmFile = wasmFiles[0];
const wasmIntegrity = sriFor(join(astroDir, wasmFile));

let patchedJs = 0;
for (const name of astroFiles.filter((entry) => entry.endsWith('.js'))) {
  const path = join(astroDir, name);
  const source = readFileSync(path, 'utf8');
  if (source.includes(WASM_PLACEHOLDER)) {
    writeFileSync(path, source.replaceAll(WASM_PLACEHOLDER, wasmIntegrity));
    patchedJs += 1;
  }
}
if (patchedJs === 0) {
  throw new Error(`inject-integrity: placeholder ${WASM_PLACEHOLDER} not found in any dist/_astro JS`);
}

// 2. SRI on the entry document's script/stylesheet subresources (now final).
let injected = 0;
const html = readFileSync(indexPath, 'utf8').replace(
  /<(?:script|link)\b[^>]*?(?:src|href)="(\/_astro\/[^"]+\.(?:js|css))"[^>]*>/g,
  (tag, ref) => {
    if (tag.includes('integrity=')) {
      return tag;
    }
    const integrity = sriFor(join(distRoot, ref.replace(/^\//, '')));
    const withCors = tag.includes('crossorigin') ? tag : tag.replace(/\s*>$/, ' crossorigin="anonymous">');
    injected += 1;
    return withCors.replace(/\s*>$/, ` integrity="${integrity}">`);
  },
);
if (injected === 0) {
  throw new Error('inject-integrity: no /_astro script/style subresources found in index.html');
}
writeFileSync(indexPath, html);

console.log(`integrity: pinned wasm in ${patchedJs} JS file(s), SRI on ${injected} subresource(s)`);
