import { defineConfig } from 'astro/config';

const base = normalizeBasePath(process.env.RMUX_SHARE_BASE_PATH);

export default defineConfig({
  site: 'https://share.rmux.io',
  base,
  trailingSlash: 'always',
  devToolbar: {
    enabled: false,
  },
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
