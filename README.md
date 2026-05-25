# rmux-web-share

Standalone static frontend for `share.rmux.io`.

The browser receives an rmux web-share URL, strips the secret fragment from the address bar, and connects directly to the daemon WebSocket endpoint from the browser. Terminal data does not transit through `share.rmux.io`.

## Development

```bash
npm ci
npm run dev
```

Open:

```text
http://127.0.0.1:4321/#endpoint=ws://127.0.0.1:9777/share&token=<token>
```

## Build

```bash
npm run build
```

The static output is written to `dist/`. The build also writes:

- `dist/.well-known/rmux-web-share.json`: deployed commit, build run, Cloudflare project, and asset hashes.
- `dist/checksums.txt`: SHA-256 checksums for the public assets.

## Verification

Each deployment exposes public provenance:

```bash
curl https://share.rmux.io/.well-known/rmux-web-share.json
curl https://share.rmux.io/checksums.txt
```

To compare the deployed frontend with the source:

```bash
git clone https://github.com/Helvesec/rmux-web-share.git
cd rmux-web-share
git checkout <commit-from-rmux-web-share-json>
npm ci
npm run build
sha256sum dist/index.html
```

The GitHub Actions run summary also records the GitHub SHA-1 and Cloudflare Pages deployment URL.

## Cloudflare Pages

Recommended Pages settings:

```text
Project name: rmux-web-share
Production branch: main
Build command: npm run build
Build output directory: dist
Custom domain: share.rmux.io
```

The rmux daemon must allow the browser origin:

```text
https://share.rmux.io
```
