import { defineConfig, devices } from '@playwright/test';

// Runs the e2e suite against the DEPLOYED production site (no local dev server).
// The mock intercepts WebSocket and loads the v4 crypto from the deployed
// /share-crypto/ path, so this exercises the real shipped frontend.
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 45_000,
  expect: { timeout: 12_000 },
  use: {
    baseURL: 'https://share.rmux.io',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium-desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 820 } },
    },
    {
      name: 'chromium-mobile',
      use: { ...devices['Pixel 7'] },
    },
  ],
});
