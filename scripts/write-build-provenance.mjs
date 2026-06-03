import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY = 'Helvesec/rmux-web-share';
const PUBLIC_ORIGIN = 'https://share.rmux.io';
const PROJECT_NAME = 'rmux-web-share';
const SECURITY_STATEMENT = [
  'This static page runs in your browser.',
  'It connects directly to your rmux daemon through loopback or your tunnel, with terminal traffic encrypted end-to-end.',
  'The share token stays in the URL fragment and is never sent to share.rmux.io.',
].join(' ');

const distRoot = fileURLToPath(new URL('../dist/', import.meta.url));
const metadataPath = join(distRoot, '.well-known', 'rmux-web-share.json');
const checksumsPath = join(distRoot, 'checksums.txt');

if (!existsSync(join(distRoot, 'index.html'))) {
  throw new Error('dist/index.html is missing; run astro build first');
}

const commit = envOrGit('GITHUB_SHA', ['rev-parse', 'HEAD']);
const refName = process.env.GITHUB_REF_NAME ?? envOrGit('GITHUB_REF', ['branch', '--show-current']);
const runId = process.env.GITHUB_RUN_ID ?? '';
const runAttempt = process.env.GITHUB_RUN_ATTEMPT ?? '';
const runUrl = runId ? `https://github.com/${REPOSITORY}/actions/runs/${runId}` : null;
const commitUrl = commit ? `https://github.com/${REPOSITORY}/commit/${commit}` : null;
const assets = buildAssetProofs();

const metadata = {
  schema_version: 1,
  project: 'rmux-web-share',
  public_origin: PUBLIC_ORIGIN,
  repository: `https://github.com/${REPOSITORY}`,
  commit_sha1: commit,
  commit_url: commitUrl,
  ref: refName || null,
  github_actions: {
    run_id: runId || null,
    run_attempt: runAttempt || null,
    run_url: runUrl,
  },
  cloudflare_pages: {
    project: PROJECT_NAME,
    public_domain: PUBLIC_ORIGIN,
    deployment_proof: runUrl
      ? `${runUrl}#summary`
      : 'GitHub Actions step summary after Cloudflare accepts the upload',
  },
  build: {
    command: 'npm ci && npm run build',
    generated_at: new Date().toISOString(),
    asset_hash: 'sha256',
  },
  security_statement: SECURITY_STATEMENT,
  verification: {
    // Independently auditable: these hashes are served by the origin, and build integrity
    // can be verified by rebuilding from the public source at the commit below and diffing
    // the result against checksums.txt.
    note: 'Independently auditable. Rebuild from source at the commit below and compare against checksums.txt to verify build integrity.',
    source_checkout: `git clone https://github.com/${REPOSITORY}.git && cd rmux-web-share && git checkout ${commit}`,
    reproduce: 'npm ci && npm run build',
  },
  assets,
};

mkdirSync(dirname(metadataPath), { recursive: true });
writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
writeFileSync(checksumsPath, checksumsText(assets));
console.log(`build provenance: ${assets.length} assets, commit ${shortSha(commit)}`);

function buildAssetProofs() {
  const files = publicFiles(distRoot)
    .filter((file) => !isGeneratedProofFile(file))
    .map((file) => assetProof(file))
    .sort((left, right) => left.path.localeCompare(right.path));

  const index = files.find((file) => file.path === '/index.html');
  if (index) {
    files.unshift({ ...index, path: '/' });
  }
  return files;
}

function publicFiles(root) {
  const pending = [root];
  const files = [];
  for (let index = 0; index < pending.length; index += 1) {
    const current = pending[index];
    for (const entry of readdirSync(current)) {
      const path = join(current, entry);
      const stats = statSync(path);
      if (stats.isDirectory()) {
        pending.push(path);
      } else if (stats.isFile()) {
        files.push(path);
      }
    }
  }
  return files;
}

function assetProof(file) {
  const content = readFileSync(file);
  const digest = createHash('sha256').update(content).digest();
  return {
    path: publicPath(file),
    bytes: content.byteLength,
    sha256: digest.toString('hex'),
    integrity: `sha256-${digest.toString('base64')}`,
  };
}

function publicPath(file) {
  return `/${relative(distRoot, file).split(sep).join('/')}`;
}

function isGeneratedProofFile(file) {
  const path = publicPath(file);
  return path === '/.well-known/rmux-web-share.json' || path === '/checksums.txt';
}

function checksumsText(assets) {
  return assets
    .map((asset) => `${asset.sha256}  ${asset.path}`)
    .join('\n')
    .concat('\n');
}

function envOrGit(envName, args) {
  if (process.env[envName]) {
    return process.env[envName];
  }
  try {
    return execFileSync('git', args, { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function shortSha(value) {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, 12) : 'unknown';
}
