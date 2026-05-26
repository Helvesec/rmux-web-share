import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const distRoot = new URL('../dist/', import.meta.url);
const shareEntry = new URL('index.html', distRoot);
const output = new URL('offline-manifest.json', distRoot);
const extras = ['/', '/share.webmanifest', '/icon-192.png', '/icon-512.png'];

if (!existsSync(shareEntry)) {
  throw new Error('dist/index.html is missing; run astro build first');
}

const assets = [...new Set([...extras, ...collectAssets(shareEntry)])].sort();
const version = manifestVersion(assets);
mkdirSync(dirname(fileURLToPath(output)), { recursive: true });
writeFileSync(output, `${JSON.stringify({ version, assets }, null, 2)}\n`);
console.log(`share offline manifest: ${assets.length} assets, version ${version}`);

function collectAssets(entryUrl) {
  const seen = new Set();
  const entry = fileURLToPath(entryUrl);
  const queue = [entry, ...assetRefs(readFileSync(entryUrl, 'utf8'), entry)];

  for (let index = 0; index < queue.length; index += 1) {
    const asset = queue[index];
    if (seen.has(asset)) {
      continue;
    }
    seen.add(asset);

    if (asset.endsWith('.js')) {
      for (const next of assetRefs(readFileSync(asset, 'utf8'), asset)) {
        if (!seen.has(next)) {
          queue.push(next);
        }
      }
    }
  }

  return [...seen].map(publicPath).filter((path) => path.startsWith('/_astro/'));
}

function assetRefs(text, owner) {
  const refs = [];
  const patterns = [
    /(?:src|href)=["']([^"']*\/_astro\/[^"']+\.(?:js|css))["']/g,
    /(?:import\(|from\s*)["']([^"']+\.(?:js|css))["']/g,
    /["']([^"']*_astro\/[^"']+\.(?:js|css))["']/g,
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      refs.push(resolveAsset(match[1], owner));
    }
  }
  return refs;
}

function resolveAsset(ref, owner) {
  if (ref.startsWith('/')) {
    const assetPath = ref.includes('/_astro/') ? ref.slice(ref.indexOf('/_astro/')) : ref;
    return fileURLToPath(new URL(`.${assetPath}`, distRoot));
  }
  if (ref.startsWith('_astro/')) {
    return fileURLToPath(new URL(ref, distRoot));
  }
  return normalize(join(dirname(owner), ref));
}

function publicPath(file) {
  const root = fileURLToPath(distRoot);
  return `/${normalize(file).slice(root.length).replaceAll('\\', '/')}`;
}

function manifestVersion(paths) {
  const hash = createHash('sha256');
  for (const path of paths) {
    hash.update(path);
    hash.update('\0');
    const file = path === '/' ? fileURLToPath(shareEntry) : fileURLToPath(new URL(`.${path}`, distRoot));
    if (existsSync(file)) {
      hash.update(readFileSync(file));
    }
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}
