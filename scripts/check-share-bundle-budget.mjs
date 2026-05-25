import { gzipSync } from 'node:zlib';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const budgetBytes = 250 * 1024;
const distRoot = new URL('../dist/', import.meta.url);
const entries = [
  ['share root', new URL('index.html', distRoot)],
];

for (const [name, entry] of entries) {
  if (!existsSync(entry)) {
    throw new Error(`${fileURLToPath(entry)} is missing; run astro build first`);
  }

  const assets = collectAssets(entry);
  const total = totalGzipBytes(assets);
  const kib = (total / 1024).toFixed(1);
  console.log(`${name} bundle gzip: ${kib} KiB / 250.0 KiB`);

  if (total > budgetBytes) {
    throw new Error(`${name} bundle gzip budget exceeded: ${total} > ${budgetBytes}`);
  }
}

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

  return seen;
}

function totalGzipBytes(assets) {
  return [...assets].reduce((sum, asset) => {
    const bytes = readFileSync(asset);
    return sum + gzipSync(bytes, { level: 9 }).length;
  }, 0);
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
    return fileURLToPath(new URL(`.${ref}`, distRoot));
  }
  if (ref.startsWith('_astro/')) {
    return fileURLToPath(new URL(ref, distRoot));
  }
  return normalize(join(dirname(owner), ref));
}
