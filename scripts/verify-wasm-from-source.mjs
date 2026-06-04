// Source-to-binary gate for the production crypto WASM.
//
// The deploy workflow rebuilds the shipped blob from the pinned rmux source
// commit and requires byte-for-byte equality before publishing share.rmux.io.
// Set RMUX_WASM_DIRS=wasm,wasm-test when the test-only blob also needs checking.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const shareRoot = fileURLToPath(new URL('../src/scripts/share/', import.meta.url));
const VALID_WASM_DIRS = new Set(['wasm', 'wasm-test']);
const requestedDirs = (process.env.RMUX_WASM_DIRS ?? 'wasm')
  .split(',')
  .map((dir) => dir.trim())
  .filter(Boolean);
if (requestedDirs.length === 0) {
  throw new Error('wasm source gate: RMUX_WASM_DIRS did not name any artifact directory');
}
for (const dir of requestedDirs) {
  if (!VALID_WASM_DIRS.has(dir)) {
    throw new Error(`wasm source gate: unsupported artifact directory '${dir}'`);
  }
}
const WASM_DIRS = requestedDirs; // dir name doubles as the build feature set
const BUILD_SCRIPT = 'scripts/build-web-crypto-wasm.sh';

const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

function readProvenance(dir) {
  const path = join(shareRoot, dir, 'PROVENANCE.json');
  let provenance;
  try {
    provenance = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`wasm source gate: cannot read ${dir}/PROVENANCE.json (${error.message})`);
  }
  const commit = provenance.source?.source_commit;
  const artifacts = provenance.artifacts;
  if (!commit || !/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error(`wasm source gate: ${dir}/PROVENANCE.json has no valid source.source_commit`);
  }
  if (!artifacts || Object.keys(artifacts).length === 0) {
    throw new Error(`wasm source gate: ${dir}/PROVENANCE.json lists no artifacts`);
  }
  return { commit, artifacts, rustc: provenance.toolchain?.rustc ?? null, repository: provenance.source?.repository };
}

// Resolve a base rmux git checkout to build from. Returns { dir, cleanup }.
function resolveSource(repository) {
  const local = process.env.RMUX_SOURCE_DIR;
  if (local) {
    try {
      run('git', ['-C', local, 'rev-parse', '--git-dir']);
    } catch {
      throw new Error(`wasm source gate: RMUX_SOURCE_DIR=${local} is not a git checkout`);
    }
    return { dir: local, cleanup: () => {} };
  }
  if (!repository) {
    throw new Error('wasm source gate: no RMUX_SOURCE_DIR and PROVENANCE has no source.repository to clone');
  }
  const dir = mkdtempSync(join(tmpdir(), 'rmux-src-'));
  console.log(`wasm source gate: cloning ${repository} (set RMUX_SOURCE_DIR to reuse a local checkout)`);
  try {
    run('git', ['clone', '--quiet', `${repository}.git`, dir], { stdio: 'inherit' });
    // Make sure non-default branches (e.g. release/*) are present so any pinned
    // source_commit is reachable for the worktree.
    run('git', ['-C', dir, 'fetch', '--quiet', '--all']);
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`wasm source gate: failed to clone ${repository} (${error.message})`);
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// Build `feature` from `sourceDir` at `commit` in a throwaway detached worktree and
// return the freshly produced pkg files as { name -> Buffer }.
function buildAtCommit(sourceDir, commit, feature, rustc, artifactNames) {
  try {
    run('git', ['-C', sourceDir, 'cat-file', '-e', `${commit}^{commit}`]);
  } catch {
    throw new Error(
      `wasm source gate: commit ${commit} is not present in the rmux source.\n` +
        '  The pinned source_commit must be reachable — push/fetch the rmux branch that contains it.',
    );
  }
  const worktree = mkdtempSync(join(tmpdir(), 'rmux-wt-'));
  try {
    run('git', ['-C', sourceDir, 'worktree', 'add', '--quiet', '--detach', worktree, commit]);
    const env = { ...process.env };
    if (rustc) {
      env.RUSTUP_TOOLCHAIN = rustc; // pin codegen; overrides the worktree's rust-toolchain.toml
      // Assert the pinned toolchain is actually installed and active. Without this,
      // RUSTUP_TOOLCHAIN to a missing version silently auto-downloads a *different*
      // rustc (or falls through to a floating 'stable'), changing codegen — a wrong
      // build that the operator wouldn't notice until an opaque byte mismatch.
      let active = '';
      try {
        active = run('rustc', [`+${rustc}`, '--version'], { env }).trim();
      } catch {
        throw new Error(
          `wasm source gate: pinned rustc ${rustc} is not installed.\n` +
            `  Install it: rustup toolchain install ${rustc} --target wasm32-unknown-unknown`,
        );
      }
      if (!active.split(/\s+/).includes(rustc)) {
        throw new Error(`wasm source gate: active rustc "${active}" is not the pinned ${rustc}`);
      }
    }
    console.log(`wasm source gate: building '${feature}' at ${commit.slice(0, 12)}${rustc ? ` (rustc ${rustc})` : ''}`);
    run('bash', [join(worktree, BUILD_SCRIPT), feature], { cwd: worktree, env, stdio: ['ignore', 'inherit', 'inherit'] });
    const pkg = join(worktree, 'crates/rmux-web-crypto/pkg');
    return Object.fromEntries(artifactNames.map((name) => [name, readFileSync(join(pkg, name))]));
  } finally {
    try {
      run('git', ['-C', sourceDir, 'worktree', 'remove', '--force', worktree]);
    } catch {
      rmSync(worktree, { recursive: true, force: true });
    }
  }
}

const source = resolveSource(readProvenance(WASM_DIRS[0]).repository);
let checked = 0;
const failures = [];
try {
  for (const dir of WASM_DIRS) {
    const { commit, artifacts, rustc } = readProvenance(dir);
    const built = buildAtCommit(source.dir, commit, dir, rustc, Object.keys(artifacts));
    for (const [name, recorded] of Object.entries(artifacts)) {
      const rebuilt = sha256(built[name]);
      const committed = sha256(readFileSync(join(shareRoot, dir, name)));
      // Two independent assertions (NOT else-if): the source rebuild reproducing the
      // committed bytes must not mask a stale/wrong PROVENANCE hash.
      let ok = true;
      if (rebuilt !== committed) {
        ok = false;
        failures.push(
          `${dir}/${name}: rebuilt-from-source bytes differ from the committed blob\n` +
            `    committed       ${committed}\n    rebuilt(source) ${rebuilt}`,
        );
      }
      if (committed !== recorded) {
        ok = false;
        failures.push(
          `${dir}/${name}: committed bytes do not match PROVENANCE.json hash\n` +
            `    committed  ${committed}\n    provenance ${recorded}`,
        );
      }
      if (ok) console.log(`wasm source gate: ${dir}/${name} reproduces from source ✓ ${rebuilt}`);
      checked += 1;
    }
  }
} finally {
  source.cleanup();
}

if (failures.length > 0) {
  throw new Error(
    `wasm source gate: ${failures.length} artifact(s) do NOT match their Rust source.\n` +
      failures.map((f) => `  - ${f}`).join('\n') +
      '\nThe shipped binary diverges from the auditable source. Rebuild with the pinned toolchain ' +
      'via rmux scripts/build-web-crypto-wasm.sh and update the committed blob + PROVENANCE.json.',
  );
}

console.log(`wasm source gate: ${checked} artifact(s) reproduce byte-for-byte from rmux source`);
