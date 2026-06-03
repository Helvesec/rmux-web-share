// Fail-closed provenance gate for the committed crypto WASM blobs.
//
// The shipped E2EE primitive is an opaque binary (rmux_web_crypto_wasm_bg.wasm)
// plus its generated JS shim. This script recomputes their sha256 and checks them
// against the hashes pinned in each dir's PROVENANCE.json BEFORE the bundle is
// built. A blob can therefore not change without a matching, reviewable
// PROVENANCE.json diff — turning the otherwise-unreviewable binary into a
// tamper-evident artifact tied to a documented, reproducible build recipe.
//
// This does NOT by itself re-derive the binary from Rust source (that requires
// wasm-pack with the pinned toolchain — see PROVENANCE.json `build_command`); it
// guarantees the served bytes match the recorded provenance, and makes any
// substitution an explicit diff a reviewer must approve.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const shareRoot = fileURLToPath(new URL('../src/scripts/share/', import.meta.url));
const WASM_DIRS = ['wasm', 'wasm-test'];

const sha256 = (file) => `sha256:${createHash('sha256').update(readFileSync(file)).digest('hex')}`;

let checked = 0;
for (const dir of WASM_DIRS) {
  const provenancePath = join(shareRoot, dir, 'PROVENANCE.json');
  let provenance;
  try {
    provenance = JSON.parse(readFileSync(provenancePath, 'utf8'));
  } catch (error) {
    throw new Error(`wasm provenance: cannot read ${dir}/PROVENANCE.json (${error.message})`);
  }
  const artifacts = provenance.artifacts;
  if (!artifacts || Object.keys(artifacts).length === 0) {
    throw new Error(`wasm provenance: ${dir}/PROVENANCE.json lists no artifacts to pin`);
  }
  for (const [name, expected] of Object.entries(artifacts)) {
    const actual = sha256(join(shareRoot, dir, name));
    if (actual !== expected) {
      throw new Error(
        `wasm provenance: ${dir}/${name} hash mismatch\n  expected ${expected}\n  actual   ${actual}\n` +
          'The committed WASM no longer matches its recorded provenance. If this change is intended, ' +
          'rebuild via the rmux scripts/build-web-crypto-wasm.sh recipe and update PROVENANCE.json.',
      );
    }
    checked += 1;
  }
}

console.log(`wasm provenance: ${checked} artifact hash(es) match PROVENANCE.json`);
