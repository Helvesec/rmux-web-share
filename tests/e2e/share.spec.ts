import { expect, test } from '@playwright/test';

import { installMockShareWebSocket } from '../support/mock-share-websocket';

const readToken = `read_${'a'.repeat(48)}`;
const operatorToken = `operator_${'b'.repeat(48)}`;

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installMockShareWebSocket);
});

test('read-only client confirms endpoint and receives the initial snapshot', async ({ page }) => {
  await page.goto(`/#t=${readToken}`);
  await expect(page.locator('[data-share-confirm]')).toBeVisible();
  await expect.poll(() => new URL(page.url()).hash).toBe('');
  expect(page.url()).not.toContain(readToken);
  await expect(page.locator('[data-share-endpoint]')).toHaveText('127.0.0.1:9777');
  await expect(page.locator('[data-share-confirm-detail]')).toContainText('Click Allow');
  await expect(page.locator('[data-share-confirm-connect]')).toHaveText('Connect to local daemon');
  await expect(page.locator('[data-share-terminal-theme]')).toHaveValue('user');
  await expect(page.locator('.share-brand-context')).toHaveText('Web Multiplex');
  await expect(page.locator('[data-share-role]')).toHaveText('Read Only');
  await expect.poll(() => socketCount(page)).toBe(0);

  await page.locator('[data-share-terminal-theme]').selectOption('light');
  await expect(page.locator('.share-app')).toHaveAttribute('data-terminal-theme', 'light');
  await expect(page.locator('.share-app')).toHaveAttribute('data-terminal-mode', 'light');

  await page.locator('[data-share-confirm-connect]').click();

  await expect(page.locator('[data-share-status]')).toHaveText('Connected');
  await expect(page.locator('[data-share-terminal]')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('[data-share-terminal]')).toHaveAttribute('data-theme-mode', 'light');
  await expect(page.locator('[data-share-toast]')).toContainText('share.rmux.io only served this static app');
  await expect(page.locator('[data-share-toast]')).toContainText('More info');
  await expect(page.locator('.xterm')).toContainText('hello from rmux');
  await expect.poll(() => sentFrames(page)).toContainEqual(
    JSON.stringify({
      type: 'auth',
      protocol_version: 2,
      capabilities: ['token-auth', 'terminal-palette-v1'],
      token: readToken,
    }),
  );
});

test('explicit endpoint links keep the short e/t fragment contract', async ({ page }) => {
  await page.goto(`/#e=wss://terminal.example/share&t=${readToken}`);

  await expect(page.locator('[data-share-endpoint]')).toHaveText('terminal.example');
  await page.locator('[data-share-confirm-connect]').click();

  await expect(page.locator('[data-share-status]')).toHaveText('Connected');
  await expect.poll(() => sentFrames(page)).toContainEqual(
    JSON.stringify({
      type: 'auth',
      protocol_version: 2,
      capabilities: ['token-auth', 'terminal-palette-v1'],
      token: readToken,
    }),
  );
});

test('viewer count option shows the live connected browser count', async ({ page }) => {
  await page.goto(`/#t=${readToken}&viewers=on`);
  await page.locator('[data-share-confirm-connect]').click();

  await expect(page.locator('[data-share-viewers]')).toBeVisible();
  await expect(page.locator('[data-share-viewers-count]')).toHaveText('3');
  await expect(page.locator('[data-share-viewers] svg')).toBeVisible();
});

test('terminal theme selection persists locally', async ({ page }) => {
  const url = `/#t=${readToken}`;
  await page.goto(url);
  await page.locator('[data-share-terminal-theme]').selectOption('dark');
  await page.reload();

  await expect(page.locator('[data-share-terminal-theme]')).toHaveValue('dark');
  await expect(page.locator('.share-app')).toHaveAttribute('data-terminal-theme', 'dark');
});

test('security provenance dialog displays build proof links', async ({ page }) => {
  await page.route('**/.well-known/rmux-web-share.json', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      repository: 'https://github.com/Helvesec/rmux-web-share',
      commit_sha1: '0123456789abcdef0123456789abcdef01234567',
      commit_url: 'https://github.com/Helvesec/rmux-web-share/commit/0123456789abcdef0123456789abcdef01234567',
      security_statement: 'share.rmux.io serves only the static frontend and does not relay terminal data. The token stays in the URL fragment, the source is public, builds are verifiable, deployments are traceable, and the frontend can be self-hosted.',
      github_actions: {
        run_id: '123456',
        run_url: 'https://github.com/Helvesec/rmux-web-share/actions/runs/123456',
      },
      cloudflare_pages: {
        project: 'rmux-web-share',
        deployment_proof: 'https://e05fdd29.rmux-web-share.pages.dev',
      },
    }),
  }));

  await page.goto(`/#t=${readToken}`);
  await page.locator('[data-share-provenance-open]').click();

  await expect(page.locator('[data-share-provenance]')).toBeVisible();
  await expect(page.locator('[data-share-provenance-statement]')).toContainText('builds are verifiable');
  await expect(page.locator('[data-share-provenance-commit]')).toHaveText('0123456789ab');
  await expect(page.locator('[data-share-provenance-run]')).toHaveText('run 123456');
  await expect(page.locator('[data-share-provenance-cloudflare]')).toHaveText('rmux-web-share');
});

test('operator sends xterm data and can open session actions', async ({ page }) => {
  await page.goto(`/#t=${operatorToken}`);
  await page.locator('[data-share-confirm-connect]').click();

  await expect(page.locator('.share-role-badge')).toBeHidden();
  await page.locator('.xterm').click();
  await page.keyboard.type('x');
  await expect.poll(() => sentFrames(page)).toContainEqual([0x80, 120]);

  await page.locator('[data-share-status-menu]').click();
  await expect(page.locator('[data-share-session-actions]')).toBeVisible();
  await expect(page.locator('[data-share-session-detach]')).toBeVisible();
  await expect(page.locator('[data-share-session-detach]')).toHaveText('Disconnect browser');
  await expect(page.locator('[data-share-session-release]')).toHaveCount(0);
  await expect(page.locator('[data-share-session-logout]')).toBeHidden();
});

test('operator can disconnect, copy the sanitized link, and reconnect from the same tab', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          (window as unknown as { __rmuxCopiedShareLink?: string }).__rmuxCopiedShareLink = text;
        },
      },
    });
  });
  await page.goto(`/#t=${operatorToken}`);
  await page.locator('[data-share-confirm-connect]').click();
  await expect.poll(() => socketCount(page)).toBe(1);
  await expect.poll(() => new URL(page.url()).hash).toBe('');

  await page.locator('[data-share-status-menu]').click();
  await page.locator('[data-share-session-detach]').click();

  await expect(page.locator('[data-share-reconnect]')).toBeVisible();
  await expect(page.locator('[data-share-status]')).toHaveText('Disconnected');
  await page.locator('[data-share-reconnect-copy]').click();
  await expect(page.locator('[data-share-reconnect-copy]')).toHaveText('Copied');
  const copied = await page.evaluate(() => {
    return (window as unknown as { __rmuxCopiedShareLink?: string }).__rmuxCopiedShareLink;
  });
  expect(copied).toContain(`/#t=${operatorToken}`);
  expect(copied).not.toContain('endpoint=');
  expect(copied).not.toContain('token=');

  await page.locator('[data-share-reconnect-connect]').click();
  await expect.poll(() => socketCount(page)).toBe(2);
  await expect(page.locator('[data-share-reconnect]')).toBeHidden();
  await expect(page.locator('[data-share-status]')).toHaveText('Connected');
});

test('session operator can logout the shared session from the status menu', async ({ page }) => {
  await page.addInitScript(() => {
    window.__rmuxShareReadyScope = 'session';
    window.__rmuxShareReadyControls = true;
  });
  await page.goto(`/#t=${operatorToken}`);
  await page.locator('[data-share-confirm-connect]').click();

  await page.locator('[data-share-status-menu]').click();
  await expect(page.locator('[data-share-session-actions]')).toBeVisible();
  await expect(page.locator('[data-share-session-logout]')).toBeVisible();
  await page.locator('[data-share-session-logout]').click();
  await expect.poll(() => logoutFrameCount(page)).toBe(1);
  await expect(page.locator('[data-share-status]')).toHaveText('Disconnected');
});

test('session operator without controls cannot logout from the status menu', async ({ page }) => {
  await page.addInitScript(() => {
    window.__rmuxShareReadyScope = 'session';
  });
  await page.goto(`/#t=${operatorToken}`);
  await page.locator('[data-share-confirm-connect]').click();

  await page.locator('[data-share-status-menu]').click();
  await expect(page.locator('[data-share-session-actions]')).toBeVisible();
  await expect(page.locator('[data-share-session-detach]')).toBeVisible();
  await expect(page.locator('[data-share-session-logout]')).toBeHidden();
  await expect.poll(() => logoutFrameCount(page)).toBe(0);
});

test('session controls send attach input until pass-through is enabled', async ({ page }) => {
  await page.addInitScript(() => {
    window.__rmuxShareReadyScope = 'session';
    window.__rmuxShareReadyControls = true;
  });
  await page.goto(`/#t=${operatorToken}`);
  await page.locator('[data-share-confirm-connect]').click();

  await expect(page.locator('[data-share-controls]')).toBeVisible();
  await expect(page.locator('[data-share-controls]')).toContainText('Controls');
  await expect(page.locator('[data-share-controls-passthrough]')).toHaveText('rmux keys');
  await page.locator('.xterm').click();
  await page.keyboard.type('x');
  await expect.poll(() => sentFrames(page)).toContainEqual([0x83, 120]);

  await page.locator('[data-share-controls-passthrough]').click();
  await expect(page.locator('[data-share-controls]')).toHaveAttribute('data-passthrough', 'pty');
  await expect(page.locator('[data-share-controls-passthrough]')).toHaveText('PTY keys');
  await page.keyboard.type('y');
  await expect.poll(() => sentFrames(page)).toContainEqual([0x80, 121]);
});

test('mouse wheel scroll stays local and does not send shell input', async ({ page }) => {
  await page.addInitScript(() => {
    window.__rmuxShareReadyScope = 'session';
    window.__rmuxShareReadyControls = true;
  });
  await page.goto(`/#t=${operatorToken}`);
  await page.locator('[data-share-confirm-connect]').click();
  await page.locator('.xterm').hover();

  const before = await sentFrames(page);
  await page.mouse.wheel(0, 600);
  await expect.poll(() => sentFrames(page)).toEqual(before);
});

test('toolbar visibility is a session preference', async ({ page }) => {
  const url = `/#t=${readToken}`;
  await page.goto(url);
  await page.locator('[data-share-confirm-cancel]').click();

  await page.locator('[data-share-chrome-hide]').click();
  await expect(page.locator('.share-app')).toHaveAttribute('data-chrome', 'hidden');
  await page.reload();
  await expect(page.locator('.share-app')).toHaveAttribute('data-chrome', 'hidden');

  await page.locator('[data-share-chrome-show]').click();
  await expect(page.locator('.share-app')).toHaveAttribute('data-chrome', 'visible');
});

test('URL options can remove chrome and disclaimer', async ({ page }) => {
  const url = `/#t=${readToken}&navbar=off&disclaimer=off&theme=dark`;
  await page.goto(url);
  await page.locator('[data-share-confirm-connect]').click();

  await expect(page.locator('.share-app')).toHaveAttribute('data-navbar', 'off');
  await expect(page.locator('.share-app')).toHaveAttribute('data-chrome', 'hidden');
  await expect(page.locator('.share-app')).toHaveAttribute('data-terminal-theme', 'dark');
  await expect(page.locator('[data-share-terminal-theme]')).toHaveValue('dark');
  await expect(page.locator('[data-share-chrome-show]')).toBeHidden();
  await expect(page.locator('[data-share-toast]')).toBeHidden();
  await expect(page.locator('[data-share-status]')).toHaveText('Connected');
});

test('pin-protected URLs send the out-of-band pairing code', async ({ page }) => {
  const url = `/#t=${readToken}&pin=required`;
  await page.goto(url);

  await expect(page.locator('[data-share-pin]')).toBeVisible();
  await page.locator('[data-share-confirm-connect]').click();
  await expect(page.locator('[data-share-pin-error]')).toContainText('6-digit');

  await page.locator('[data-share-pin]').fill('123456');
  await page.locator('[data-share-confirm-connect]').click();

  await expect.poll(() => sentFrames(page)).toContainEqual(
    JSON.stringify({
      type: 'auth',
      protocol_version: 2,
      capabilities: ['token-auth', 'terminal-palette-v1'],
      token: readToken,
      pin: '123456',
    }),
  );
  await expect(page.locator('[data-share-status]')).toHaveText('Connected');
});

test('pin-protected minimal links stay readable in a light user theme', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  const url = `/#t=${readToken}&pin=required&navbar=off&disclaimer=off`;
  await page.goto(url);

  await expect(page.locator('[data-share-confirm]')).toBeVisible();
  await expect(page.locator('.share-app')).toHaveAttribute('data-terminal-mode', 'light');
  await expect(page.locator('.share-confirm')).toHaveCSS('background-color', 'rgb(255, 250, 240)');
  await expect(page.locator('.share-confirm h1')).toHaveCSS('color', 'rgb(16, 33, 26)');
  await expect(page.locator('[data-share-pin]')).toHaveCSS('color', 'rgb(16, 33, 26)');

  await page.locator('[data-share-pin]').fill('123456');
  await page.locator('[data-share-confirm-connect]').click();

  await expect(page.locator('[data-share-status]')).toHaveText('Connected');
  await expect(page.locator('[data-share-toast]')).toBeHidden();
  await expect(page.locator('.xterm')).toBeVisible();
  await expect(page.locator('.xterm')).toContainText('hello from rmux');
});

test('user terminal theme applies the palette from the ready message', async ({ page }) => {
  await page.addInitScript(() => {
    window.__rmuxShareTerminalPalette = {
      foreground: '#d6e7e8',
      background: '#00343d',
      cursor: '#f8fafc',
      ansi: [
        '#002b36', '#dc322f', '#859900', '#b58900',
        '#268bd2', '#d33682', '#2aa198', '#eee8d5',
        '#073642', '#cb4b16', '#586e75', '#657b83',
        '#839496', '#6c71c4', '#93a1a1', '#fdf6e3',
      ],
    };
  });

  await page.goto(`/#t=${readToken}`);
  await page.locator('[data-share-confirm-connect]').click();

  await expect(page.locator('[data-share-terminal]')).toHaveAttribute('data-theme', 'user');
  await expect(page.locator('[data-share-terminal]')).toHaveAttribute('data-theme-mode', 'dark');
  await expect(page.locator('.share-app')).toHaveAttribute('data-terminal-mode', 'dark');
  await expect(page.locator('.share-app')).toHaveAttribute('data-client-palette', 'present');
  await expect.poll(() => customProperty(page, '--share-client-bg')).toBe('#00343d');
  await expect(page.locator('.xterm')).toContainText('hello from rmux');

  await page.locator('[data-share-terminal-theme]').selectOption('dark');
  await expect(page.locator('.share-app')).toHaveAttribute('data-terminal-mode', 'dark');
  await expect(page.locator('.share-app')).toHaveAttribute('data-client-palette', 'absent');
  await page.locator('[data-share-terminal-theme]').selectOption('user');
  await expect(page.locator('.share-app')).toHaveAttribute('data-terminal-mode', 'dark');
  await expect(page.locator('.share-app')).toHaveAttribute('data-client-palette', 'present');
});

test('light client terminal palette drives the surrounding chrome', async ({ page }) => {
  await page.addInitScript(() => {
    window.__rmuxShareTerminalPalette = {
      foreground: '#002b36',
      background: '#fdf6e3',
      cursor: '#073642',
      ansi: [
        '#073642', '#dc322f', '#859900', '#b58900',
        '#268bd2', '#d33682', '#2aa198', '#eee8d5',
        '#002b36', '#cb4b16', '#586e75', '#657b83',
        '#839496', '#6c71c4', '#93a1a1', '#fdf6e3',
      ],
    };
  });

  await page.goto(`/#t=${readToken}`);
  await page.locator('[data-share-confirm-connect]').click();

  await expect(page.locator('.share-app')).toHaveAttribute('data-terminal-theme', 'user');
  await expect(page.locator('.share-app')).toHaveAttribute('data-terminal-mode', 'light');
  await expect(page.locator('.share-app')).toHaveAttribute('data-client-palette', 'present');
  await expect.poll(() => customProperty(page, '--share-client-bg')).toBe('#fdf6e3');
  await expect.poll(() => customProperty(page, '--share-client-fg')).toBe('#002b36');
});

test('invalid terminal theme in the URL is rejected', async ({ page }) => {
  await page.goto(`/#t=${readToken}&theme=solarized`);

  await expect(page.locator('[data-share-status]')).toHaveText('Disconnected');
  await expect(page.locator('[data-share-terminal]')).toContainText('invalid terminal theme');
  await expect.poll(() => socketCount(page)).toBe(0);
});

async function sentFrames(page: import('@playwright/test').Page) {
  return page.evaluate(() => window.__rmuxShareSockets?.flatMap((socket) => socket.sent) ?? []);
}

async function socketCount(page: import('@playwright/test').Page) {
  return page.evaluate(() => window.__rmuxShareSockets?.length ?? 0);
}

async function logoutFrameCount(page: import('@playwright/test').Page) {
  const frames = await sentFrames(page);
  return frames.filter((frame) => typeof frame === 'string' && frame.includes('"logout"')).length;
}

async function customProperty(page: import('@playwright/test').Page, name: string) {
  return page.locator('.share-app').evaluate((element, property) => {
    return getComputedStyle(element).getPropertyValue(property).trim();
  }, name);
}
