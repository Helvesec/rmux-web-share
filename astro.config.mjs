import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://share.rmux.io',
  trailingSlash: 'always',
  devToolbar: {
    enabled: false,
  },
});
