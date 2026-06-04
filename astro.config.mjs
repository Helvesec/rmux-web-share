import { defineConfig } from 'astro/config';

const base = normalizeBasePath(process.env.RMUX_SHARE_BASE_PATH);
const allowedHosts = normalizeAllowedHosts(process.env.RMUX_SHARE_ALLOWED_HOSTS);

export default defineConfig({
  site: 'https://share.rmux.io',
  base,
  trailingSlash: 'always',
  devToolbar: {
    enabled: false,
  },
  vite: allowedHosts.length > 0
    ? {
        server: {
          allowedHosts,
        },
      }
    : undefined,
});

function normalizeBasePath(value) {
  if (!value || value === '/') {
    return '/';
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed === '/') {
    return '/';
  }
  return `/${trimmed.replace(/^\/+|\/+$/g, '')}`;
}

function normalizeAllowedHosts(value) {
  if (!value) {
    return [];
  }
  return value
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean);
}
