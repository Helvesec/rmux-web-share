import { expect, test } from '@playwright/test';

import { installMockShareWebSocket } from '../support/mock-share-websocket';

const spectatorToken = `spectator_${'a'.repeat(48)}`;
const operatorToken = `operator_${'b'.repeat(48)}`;

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installMockShareWebSocket);
});

test('spectator client connects immediately and receives the initial snapshot', async ({ page }) => {
  await page.goto(`/#t=${spectatorToken}`);
  await expect.poll(() => new URL(page.url()).hash).toBe('');
  expect(page.url()).not.toContain(spectatorToken);
  await expect(page.locator('[data-share-confirm]')).toBeHidden();
  await expect(page.locator('[data-share-terminal-theme]')).toHaveValue('user');
  await expect(page.locator('[data-share-terminal-theme] option[value="user"]')).toHaveText('Host');
  await expect(page.locator('.share-brand-context')).toHaveText('SHARE');
  await expect(page.locator('.share-brand-context')).toHaveAttribute('href', '/');
  await expect(page.locator('[data-share-role]')).toHaveText('Spectator');
  await expect.poll(() => socketCount(page)).toBe(1);

  await page.locator('[data-share-terminal-theme]').selectOption('light');
  await expect(page.locator('.share-app')).toHaveAttribute('data-terminal-theme', 'light');
  await expect(page.locator('.share-app')).toHaveAttribute('data-terminal-mode', 'light');

  await expect(page.locator('[data-share-status]')).toHaveText('Connected');
  await expect(page.locator('[data-share-terminal]')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('[data-share-terminal]')).toHaveAttribute('data-theme-mode', 'light');
  await expect(page.locator('[data-share-toast]')).toHaveCount(0);
  await expect(page.locator('.xterm')).toContainText('hello from rmux');
  await expect.poll(() => sentFrames(page)).toContainEqual(
    JSON.stringify({
      type: 'auth',
      protocol_version: 1,
      capabilities: ['e2ee-token-auth', 'terminal-palette-v1'],
    }),
  );
  expect(JSON.stringify(await sentFrames(page))).not.toContain(spectatorToken);
});

test('terminal SHARE link returns to the dashboard instead of reopening the share', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.includes('mobile'), 'The SHARE label is hidden in the mobile topbar.');
  await page.goto(`/#t=${spectatorToken}`);
  await expect(page.locator('[data-share-status]')).toHaveText('Connected');

  await page.locator('.share-brand-context').click();

  await expect(page.locator('.home-connect-card')).toBeVisible();
  await expect(page.locator('[data-share-terminal]')).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => window.sessionStorage.getItem('rmux.share.activeParams.v1')))
    .toBeNull();
});

test('Firefox local links do not show a local access permission prompt', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'userAgent', {
      configurable: true,
      get: () => 'Mozilla/5.0 Firefox/145.0',
    });
    Object.defineProperty(Navigator.prototype, 'userAgentData', {
      configurable: true,
      get: () => undefined,
    });
  });

  await page.goto(`/?again=1#t=${spectatorToken}`);

  await expect(page.locator('[data-share-confirm]')).toBeHidden();
  await expect(page.locator('[data-share-terminal]')).not.toContainText('Local Network Access');
  await expect(page.locator('[data-share-status]')).toHaveText('Connected');
});

test('unsupported browser crypto shows a modal before connecting', async ({ page }) => {
  await page.addInitScript(() => {
    const generateKey = SubtleCrypto.prototype.generateKey;
    SubtleCrypto.prototype.generateKey = function failingX25519(algorithm, ...args) {
      const name = typeof algorithm === 'string' ? algorithm : algorithm.name;
      if (name === 'X25519') {
        return Promise.reject(new DOMException('X25519 unavailable', 'NotSupportedError'));
      }
      return generateKey.call(this, algorithm, ...args);
    };
  });

  await page.goto(`/#t=${spectatorToken}`);

  await expect(page.locator('[data-share-confirm]')).toBeVisible();
  await expect(page.locator('[data-share-confirm-title]')).toHaveText('Browser encryption unavailable');
  await expect(page.locator('[data-share-confirm-detail]')).toContainText('RMUX end-to-end encryption');
  await expect(page.locator('[data-share-confirm-connect]')).toHaveText('Copy link');
  await expect.poll(() => socketCount(page)).toBe(0);
});

test('public-to-local links use browser-specific local access copy', async ({ page }) => {
  await page.goto('/');

  const policy = await page.evaluate(async () => {
    const {
      localAccessPromptCopy,
      localAccessBlockedCopy,
      safariLocalAccessCopy,
      shouldShowLocalAccessPromptIn,
      shouldShowSafariLocalAccessPromptIn,
    } = await import('/src/scripts/share/local-access.ts');
    const endpoint = 'ws://127.0.0.1:9777/share';
    const chromiumDesktop = {
      brands: [{ brand: 'Google Chrome' }],
      confirmed: false,
      hostname: 'share.rmux.io',
      maxTouchPoints: 0,
      protocol: 'https:',
      userAgent: 'Mozilla/5.0 Chrome/145.0',
    };
    const edgeDesktop = {
      ...chromiumDesktop,
      brands: [{ brand: 'Microsoft Edge' }],
      userAgent: 'Mozilla/5.0 Chrome/145.0 Edg/145.0',
    };
    const safariDesktop = {
      ...chromiumDesktop,
      brands: [],
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
    };
    return {
      copy: localAccessPromptCopy(endpoint),
      edgeCopy: localAccessPromptCopy(endpoint, edgeDesktop),
      edgeBlockedCopy: localAccessBlockedCopy(endpoint, edgeDesktop),
      safariCopy: safariLocalAccessCopy(endpoint),
      chromiumDesktop: shouldShowLocalAccessPromptIn(endpoint, chromiumDesktop),
      edgeDesktop: shouldShowLocalAccessPromptIn(endpoint, edgeDesktop),
      safariDesktop: shouldShowSafariLocalAccessPromptIn(endpoint, safariDesktop),
      safariChromiumPrompt: shouldShowLocalAccessPromptIn(endpoint, safariDesktop),
      confirmedChromium: shouldShowLocalAccessPromptIn(endpoint, {
        ...chromiumDesktop,
        confirmed: true,
      }),
      firefoxDesktop: shouldShowLocalAccessPromptIn(endpoint, {
        ...chromiumDesktop,
        brands: [],
        userAgent: 'Mozilla/5.0 Firefox/145.0',
      }),
      localFrontend: shouldShowLocalAccessPromptIn(endpoint, {
        ...chromiumDesktop,
        hostname: '127.0.0.1',
        protocol: 'http:',
      }),
      mobileChrome: shouldShowLocalAccessPromptIn(endpoint, {
        ...chromiumDesktop,
        userAgent: 'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 CriOS/145.0 Mobile/15E148',
      }),
      tunnelEndpoint: shouldShowLocalAccessPromptIn('wss://terminal.example/share', chromiumDesktop),
    };
  });

  expect(policy.copy).toEqual({
    button: 'Continue',
    detail: 'Chrome may ask for Local Network Access before it can reach 127.0.0.1:9777. Click Allow if the browser prompts you.',
    title: 'Allow local access',
    local: true,
    action: 'connect',
  });
  expect(policy.edgeCopy).toEqual({
    button: 'Continue',
    detail: 'Edge may ask for Local Network Access before it can reach 127.0.0.1:9777. Click Allow if the browser prompts you.',
    title: 'Allow local access',
    local: true,
    action: 'connect',
  });
  expect(policy.edgeBlockedCopy).toEqual({
    button: 'Retry connection',
    detail: 'Edge blocked access to 127.0.0.1:9777. If no browser prompt appears, reset Local Network Access for share.rmux.io in Edge site settings, then retry.',
    title: 'Allow local access in Edge',
    local: true,
    action: 'connect',
  });
  expect(policy.safariCopy).toEqual({
    button: 'Copy link',
    detail: 'Safari does not allow this page to connect to RMUX on 127.0.0.1:9777. Open this link in Chrome, Edge, or Firefox, or start the share with a tunnel provider for Safari.',
    title: 'Safari blocks local web-share',
    local: true,
    action: 'copy-link',
  });
  expect(policy.chromiumDesktop).toBe(true);
  expect(policy.edgeDesktop).toBe(true);
  expect(policy.safariDesktop).toBe(true);
  expect(policy.safariChromiumPrompt).toBe(false);
  expect(policy.confirmedChromium).toBe(false);
  expect(policy.firefoxDesktop).toBe(false);
  expect(policy.localFrontend).toBe(false);
  expect(policy.mobileChrome).toBe(false);
  expect(policy.tunnelEndpoint).toBe(false);
});

test('local access success is remembered without prompting', async ({ page }) => {
  await page.goto(`/#t=${spectatorToken}`);
  await expect(page.locator('[data-share-status]')).toHaveText('Connected');
  await expect.poll(() => page.evaluate(() => window.sessionStorage.getItem('rmux.share.localAccessConfirmed'))).toBe('1');

  await page.goto(`/?again=1#t=${spectatorToken}`);

  await expect(page.locator('[data-share-confirm]')).toBeHidden();
  await expect(page.locator('[data-share-status]')).toHaveText('Connected');
});

test('explicit endpoint links keep the short e/t fragment contract', async ({ page }) => {
  await page.goto(`/#e=wss://terminal.example/share&t=${spectatorToken}`);

  await expect(page.locator('[data-share-status]')).toHaveText('Connected');
  await expect.poll(() => sentFrames(page)).toContainEqual(
    JSON.stringify({
      type: 'auth',
      protocol_version: 1,
      capabilities: ['e2ee-token-auth', 'terminal-palette-v1'],
    }),
  );
});

test('server shows the live connected browser count by default', async ({ page }) => {
  await page.goto(`/#t=${spectatorToken}`);

  await expect(page.locator('[data-share-viewers]')).toBeVisible();
  await expect(page.locator('[data-share-viewers-count]')).toHaveText('3');
  await expect(page.locator('[data-share-viewers] svg')).toBeVisible();
});

test('URL cannot force the live viewer count when the server disabled it', async ({ page }) => {
  await page.addInitScript(() => {
    window.__rmuxShareShowViewers = false;
  });
  await page.goto(`/#t=${spectatorToken}&viewers=on`);

  await expect(page.locator('[data-share-status]')).toHaveText('Connected');
  await expect(page.locator('[data-share-viewers]')).toBeHidden();
});

test('home dashboard receives recent shares from another window in the same browser', async ({ context }) => {
  await context.addInitScript(installMockShareWebSocket);
  const home = await context.newPage();
  await home.goto('/');
  await expect(home.locator('.home-connect-card')).toBeVisible();
  await expect(home.locator('.home-recent-row')).toHaveCount(0);

  const share = await context.newPage();
  await share.goto(`/#t=${operatorToken}`);

  await expect(share.locator('[data-share-status]')).toHaveText('Connected');
  await expect(home.locator('.home-recent-row')).toHaveCount(1);
  await expect(home.locator('.home-recent-title strong')).toHaveText('%1');
  await expect(home.locator('.home-viewers')).toContainText('3');

  await share.close();
  await home.close();
});

test('home provenance opens from learn more and home logo follows the theme', async ({ page }) => {
  await page.route('**/.well-known/rmux-web-share.json', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      repository: 'https://github.com/Helvesec/rmux-web-share',
      commit_sha1: 'fedcba9876543210fedcba9876543210fedcba98',
      commit_url: 'https://github.com/Helvesec/rmux-web-share/commit/fedcba9876543210fedcba9876543210fedcba98',
      security_statement: 'Builds are verifiable and deployments are traceable.',
      github_actions: {
        run_id: '987654',
        run_url: 'https://github.com/Helvesec/rmux-web-share/actions/runs/987654',
      },
      cloudflare_pages: {
        project: 'rmux-web-share',
        deployment_proof: 'https://fedcba98.rmux-web-share.pages.dev',
      },
    }),
  }));

  await page.goto('/');
  await expect(page.locator('.home-section')).toHaveText('SHARE');
  await expect(page.locator('[data-home-docs]')).toHaveText('Docs');
  await expect(page.locator('[data-home-docs]')).toHaveAttribute('href', 'https://rmux.io/docs/web-share/');
  await expect(page.locator('button[data-home-theme]')).toHaveAttribute('data-target-theme', 'dark');
  await expect(page.locator('.home-brand-logo-light')).toBeVisible();
  await expect(page.locator('.home-brand-logo-dark')).toBeHidden();

  await page.locator('[data-home-provenance-open]').click();
  await expect(page.locator('[data-share-provenance]')).toBeVisible();
  await expect(page.locator('.share-provenance-panel')).toHaveCSS('background-color', 'rgb(247, 251, 246)');
  await expect(page.locator('[data-share-provenance-docs]')).toHaveText('See the docs');
  await expect(page.locator('[data-share-provenance-docs]')).toHaveAttribute('href', 'https://rmux.io/docs/web-share/');
  await expect(page.locator('[data-share-provenance-commit]')).toHaveText('fedcba987654');
  await page.locator('[data-share-provenance] .share-dialog-close').click();

  await page.locator('button[data-home-theme]').click();
  await expect(page.locator('button[data-home-theme]')).toHaveAttribute('data-target-theme', 'light');
  await expect(page.locator('.home-brand-logo-dark')).toBeVisible();
  await expect(page.locator('.home-brand-logo-light')).toBeHidden();
});

test('spectator recent-link forget is immediate and shows feedback', async ({ page }) => {
  await page.goto(`/#t=${spectatorToken}`);
  await expect(page.locator('[data-share-status]')).toHaveText('Connected');
  await page.locator('[data-share-session-menu]').click();
  await expect(page.locator('.home-recent-row')).toHaveCount(1);

  await page.locator('.home-menu-button').click();
  await page.locator('.home-menu-popover .danger').click();

  await expect(page.locator('[data-home-forget-dialog]')).toBeHidden();
  await expect(page.locator('.home-recent-row')).toHaveCount(0);
  await expect(page.locator('[data-home-toast]')).toHaveText('Share forgotten');
});

test('recent-link action menu opens upward near the viewport bottom', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 520 });
  await page.goto(`/#t=${spectatorToken}`);
  await expect(page.locator('[data-share-status]')).toHaveText('Connected');
  await page.locator('[data-share-session-menu]').click();
  await expect(page.locator('.home-recent-row')).toHaveCount(1);
  await page.locator('.home-row-menu').scrollIntoViewIfNeeded();

  await page.locator('.home-menu-button').click();

  const menu = page.locator('.home-menu-popover');
  await expect(menu).toBeVisible();
  await expect(menu).toHaveAttribute('data-placement', 'top');
  const box = await menu.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(720);
});

test('resize acknowledgement does not clear the initial snapshot', async ({ page }) => {
  await page.addInitScript(() => {
    window.__rmuxSharePostSnapshotFrames = [
      new Uint8Array([0x02, 0x00, 0x18, 0x00, 0x06]).buffer,
    ];
  });
  await page.goto(`/#t=${operatorToken}&theme=dark`);

  await expect(page.locator('[data-share-status]')).toHaveText('Connected');
  await expect(page.locator('.xterm')).toContainText('hello from rmux');
});

test('full snapshots replace the previous terminal frame', async ({ page }) => {
  await page.addInitScript(() => {
    window.__rmuxSharePostSnapshotFrames = [
      new Uint8Array([0x10, ...new TextEncoder().encode('fresh snapshot after resize')]).buffer,
    ];
  });
  await page.goto(`/#t=${spectatorToken}`);

  await expect(page.locator('[data-share-status]')).toHaveText('Connected');
  await expect(page.locator('.xterm')).toContainText('fresh snapshot after resize');
  await expect(page.locator('.xterm')).not.toContainText('hello from rmux');
});

test('session viewer keeps the remote grid local without sending resize frames', async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 360 });
  await page.addInitScript(() => {
    window.__rmuxShareReadyScope = 'session';
    window.__rmuxShareReadyRole = 'spectator';
    window.__rmuxShareReadySize = { cols: 12, rows: 3 };
    window.__rmuxShareInitialSnapshot = '\x1b[0m\x1b[?25l\x1b[3J\x1b[2J\x1b[Hprompt'
      + '\x1b[9;1H\x1b[30;42m[ci] 0:bash* "very-long-hostname" 16:34 27-May-26\x1b[0m';
  });

  await page.goto(`/#t=${spectatorToken}`);

  await expect(page.locator('[data-share-status]')).toHaveText('Connected');
  await expect.poll(() => terminalProjection(page)).toMatchObject({
    fitsViewport: true,
    noTransform: true,
    noScrollbars: true,
    promptAtTop: true,
    statusAtBottom: true,
    statusGreen: true,
    rowCount: 9,
    singleStatusRow: true,
  });
  expect((await sentFrames(page)).some(isResizeFrame)).toBe(false);

  await page.setViewportSize({ width: 960, height: 560 });
  await expect.poll(() => terminalProjection(page)).toMatchObject({
    fitsViewport: true,
    noTransform: true,
    noScrollbars: true,
    promptAtTop: true,
    statusAtBottom: true,
    statusGreen: true,
    rowCount: 9,
    singleStatusRow: true,
  });
  expect((await sentFrames(page)).some(isResizeFrame)).toBe(false);
});

test('session viewer scales tall remote snapshots into the browser height', async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 420 });
  await page.addInitScript(() => {
    window.__rmuxShareReadyScope = 'session';
    window.__rmuxShareReadyRole = 'spectator';
    window.__rmuxShareReadySize = { cols: 80, rows: 55 };
    window.__rmuxShareInitialSnapshot =
      '\x1b[0m\x1b[?25l\x1b[3J\x1b[2J\x1b[Htop-left prompt'
      + '\x1b[40;1Hoffscreen pane content that must not create vertical browser scroll'
      + '\x1b[55;1H[ci] 0:bash* "very-long-hostname" 16:34 27-May-26';
  });

  await page.goto(`/#t=${spectatorToken}`);

  await expect(page.locator('[data-share-status]')).toHaveText('Connected');
  await expect.poll(() => terminalProjection(page)).toMatchObject({
    fitsViewport: true,
    noScrollbars: true,
    promptAtTop: true,
    scaledDown: true,
    singleStatusRow: true,
    statusAtBottom: true,
  });
});

test('session viewer keeps the status row visible after a remote resize notice', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.addInitScript(() => {
    window.__rmuxShareReadyScope = 'session';
    window.__rmuxShareReadyRole = 'spectator';
    window.__rmuxShareReadySize = { cols: 120, rows: 32 };
    window.__rmuxShareInitialSnapshot =
      '\x1b[0m\x1b[?25l\x1b[3J\x1b[2J\x1b[Hprompt'
      + '\x1b[32;1H[ci] 0:bash* "very-long-hostname" 16:34 27-May-26';
    window.__rmuxSharePostSnapshotFrames = [
      new Uint8Array([0x02, 0x00, 0xb4, 0x00, 0x40]).buffer,
    ];
  });

  await page.goto(`/#t=${spectatorToken}`);

  await expect(page.locator('[data-share-status]')).toHaveText('Connected');
  await expect.poll(() => terminalProjection(page)).toMatchObject({
    fitsViewport: true,
    noScrollbars: true,
    promptAtTop: true,
    scaledDown: true,
    singleStatusRow: true,
    statusAtBottom: true,
  });
});

test('mobile browser chrome keeps both the navbar and session status row visible', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes('mobile'), 'Chrome iOS viewport chrome only affects mobile layout');
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'userAgent', {
      configurable: true,
      get: () => 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/145.0 Mobile/15E148 Safari/604.1',
    });
    window.__rmuxShareReadyScope = 'session';
    window.__rmuxShareReadyRole = 'spectator';
    window.__rmuxShareReadySize = { cols: 80, rows: 24 };
    window.__rmuxShareInitialSnapshot =
      '\x1b[0m\x1b[?25l\x1b[3J\x1b[2J\x1b[Hprompt'
      + '\x1b[24;1H[ci] 0:bash* "host" 16:34 27-May-26';
    window.__rmuxShareSessionView = {
      size: { cols: 80, rows: 24 },
      panes: [
        { id: 1, x: 0, y: 0, cols: 80, rows: 23, active: true, history_size: 0, scroll_offset: 0, alternate_on: false },
      ],
      windows: [{ index: 0, name: 'bash', active: true }],
    };
  });
  await page.addInitScript(() => {
    // Chrome on iOS can expose a layout viewport taller than the visible
    // viewport while browser chrome covers the top and bottom. There is no
    // keyboard; the app must reserve both occluded strips locally.
    const topToolbar = 96;
    const bottomToolbar = 64;
    const target = new EventTarget();
    const vv = {
      get height() { return window.innerHeight - topToolbar - bottomToolbar; },
      get width() { return window.innerWidth; },
      get offsetTop() { return topToolbar; },
      get offsetLeft() { return 0; },
      get pageTop() { return topToolbar; },
      get pageLeft() { return 0; },
      get scale() { return 1; },
      addEventListener: (t: string, l: EventListenerOrEventListenerObject) => target.addEventListener(t, l),
      removeEventListener: (t: string, l: EventListenerOrEventListenerObject) => target.removeEventListener(t, l),
      dispatchEvent: (e: Event) => target.dispatchEvent(e),
    };
    try {
      Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => vv });
    } catch {
      // Some engines lock visualViewport; the projection assertion below will flag it.
    }
  });

  await page.goto(`/#t=${spectatorToken}`);

  await expect(page.locator('[data-share-status]')).toHaveText('Connected');
  await expect.poll(() => terminalProjection(page)).toMatchObject({
    singleStatusRow: true,
    statusAtBottom: true,
    statusInsideVisualViewport: true,
    topbarInsideVisualViewport: true,
    terminalInsideVisualViewport: true,
  });
});

test('session operator click selects the clicked pane without shell input', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.includes('mobile'), 'mobile selects panes from the pane picker.');

  await page.addInitScript(() => {
    window.__rmuxShareReadyScope = 'session';
    window.__rmuxShareReadyRole = 'operator';
    window.__rmuxShareReadySize = { cols: 80, rows: 24 };
    window.__rmuxShareInitialSnapshot =
      '\x1b[0m\x1b[?25l\x1b[3J\x1b[2J\x1b[Hleft pane'
      + '\x1b[1;42Hright pane'
      + '\x1b[24;1H[ci] 0:bash* "host" 16:34 27-May-26';
    window.__rmuxShareSessionView = {
      size: { cols: 80, rows: 24 },
      panes: [
        { id: 1, x: 0, y: 0, cols: 40, rows: 23, history_size: 0, scroll_offset: 0, alternate_on: false },
        { id: 2, x: 41, y: 0, cols: 39, rows: 23, history_size: 0, scroll_offset: 0, alternate_on: false },
      ],
    };
  });
  await page.goto(`/#t=${operatorToken}`);
  await expect(page.locator('[data-share-status]')).toHaveText('Connected');

  const screen = await page.locator('.xterm-screen').boundingBox();
  expect(screen).not.toBeNull();
  await page.mouse.click(screen!.x + screen!.width * 0.75, screen!.y + 44);

  await expect.poll(() => selectedPaneFrames(page)).toContainEqual({
    type: 'select_pane',
    pane_id: 2,
  });
  expect(await sentInputFrameCount(page)).toBe(0);
});

test('session operator can drag a pane divider without shell input', async ({ page }) => {
  await page.setViewportSize({ width: 1040, height: 640 });
  await page.addInitScript(() => {
    window.__rmuxShareReadyScope = 'session';
    window.__rmuxShareReadyRole = 'operator';
    window.__rmuxShareReadySize = { cols: 80, rows: 24 };
    window.__rmuxShareInitialSnapshot =
      '\x1b[0m\x1b[?25l\x1b[3J\x1b[2J\x1b[Hleft pane'
      + '\x1b[1;42Hright pane'
      + '\x1b[24;1H[ci] 0:bash* "host" 16:34 27-May-26';
    window.__rmuxShareSessionView = {
      size: { cols: 80, rows: 24 },
      panes: [
        { id: 1, x: 0, y: 0, cols: 40, rows: 23, history_size: 0, scroll_offset: 0, alternate_on: false },
        { id: 2, x: 41, y: 0, cols: 39, rows: 23, history_size: 0, scroll_offset: 0, alternate_on: false },
      ],
    };
  });
  await page.goto(`/#t=${operatorToken}`);
  await expect(page.locator('[data-share-status]')).toHaveText('Connected');

  const screen = await page.locator('.xterm-screen').boundingBox();
  expect(screen).not.toBeNull();
  const dividerX = screen!.x + screen!.width * (40.5 / 80);
  const dividerY = screen!.y + screen!.height * (8 / 24);
  await page.mouse.move(dividerX, dividerY);
  await expect(page.locator('.share-terminal-stage')).toHaveAttribute('data-resize-axis', 'vertical');
  await expect(page.locator('.xterm-screen')).toHaveCSS('cursor', 'col-resize');
  await page.mouse.move(dividerX + screen!.width * (0.3 / 80), dividerY);
  await expect(page.locator('.share-terminal-stage')).toHaveAttribute('data-resize-axis', 'vertical');
  await page.mouse.down();
  await page.mouse.move(dividerX + screen!.width * (5 / 80), dividerY, { steps: 8 });
  await page.mouse.up();

  await expect.poll(() => paneResizeFrames(page)).toContainEqual(
    expect.objectContaining({ direction: 1, pane_id: 1 }),
  );
  expect(await sentInputFrameCount(page)).toBe(0);
});

test('session operator toolbar sends typed controls and window actions', async ({ page }) => {
  await page.setViewportSize({ width: 1040, height: 640 });
  await page.addInitScript(() => {
    window.__rmuxShareReadyScope = 'session';
    window.__rmuxShareReadyRole = 'operator';
    window.__rmuxShareReadySize = { cols: 80, rows: 24 };
    window.__rmuxShareInitialSnapshot =
      '\x1b[0m\x1b[?25l\x1b[3J\x1b[2J\x1b[Hleft pane'
      + '\x1b[1;42Hright pane'
      + '\x1b[24;1H[ci] 0:bash* 1:logs "host" 16:34 27-May-26';
    window.__rmuxShareSessionView = {
      size: { cols: 80, rows: 24 },
      panes: [
        { id: 1, x: 0, y: 0, cols: 40, rows: 23, active: false, history_size: 0, scroll_offset: 0, alternate_on: false },
        { id: 2, x: 41, y: 0, cols: 39, rows: 23, active: true, history_size: 0, scroll_offset: 0, alternate_on: false },
      ],
      windows: [
        { index: 0, name: 'bash', active: true },
        { index: 1, name: 'logs', active: false },
      ],
    };
  });
  await page.goto(`/#t=${operatorToken}`);
  await expect(page.locator('[data-share-status]')).toHaveText('Connected');
  await expect(page.locator('[data-share-session-controls]')).toBeVisible();
  await expect(page.locator('[data-share-split-horizontal]')).toHaveAttribute('title', 'Split right');
  await expect(page.locator('[data-share-split-vertical]')).toHaveAttribute('title', 'Split down');
  await expect(page.locator('[data-share-new-window]')).toHaveAttribute('title', 'New window');
  await expect(page.locator('[data-share-kill-pane]')).toHaveAttribute('title', 'Close active pane');
  await expect(page.locator('.share-pane-active-prompt')).toHaveCount(1);

  await page.locator('[data-share-split-horizontal]').click();
  await page.locator('[data-share-split-vertical]').click();
  await page.locator('[data-share-new-window]').click();
  await page.locator('[data-share-kill-pane]').click();
  await expect.poll(() => jsonFrames(page)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: 'split_pane', direction: 'horizontal' }),
      expect.objectContaining({ type: 'split_pane', direction: 'vertical' }),
      expect.objectContaining({ type: 'new_window' }),
      expect.objectContaining({ type: 'kill_pane' }),
    ]),
  );

  const screen = await page.locator('.xterm-screen').boundingBox();
  const prompt = await page.locator('.share-pane-active-prompt').boundingBox();
  expect(screen).not.toBeNull();
  expect(prompt).not.toBeNull();
  expect(prompt!.x).toBeGreaterThan(screen!.x + screen!.width * 0.45);
  const bashLabelX = screen!.x + screen!.width * (8 / 80);
  const logsLabelX = screen!.x + screen!.width * (16 / 80);
  const statusY = screen!.y + screen!.height - 6;
  await page.mouse.move(logsLabelX, statusY);
  await expect(page.locator('.share-terminal-stage')).toHaveAttribute('data-window-actions', 'true');
  await expect(page.locator('.xterm-screen')).toHaveCSS('cursor', 'context-menu');
  await page.mouse.click(logsLabelX, statusY);

  await page.mouse.click(bashLabelX, statusY, { button: 'right' });
  await expect(page.locator('[data-share-window-menu]')).toBeVisible();
  await page.locator('[data-share-window-edit]').click();

  await page.mouse.click(bashLabelX, statusY, { button: 'right' });
  await page.locator('[data-share-window-new]').click();

  await page.mouse.click(bashLabelX, statusY, { button: 'right' });
  await page.locator('[data-share-window-kill]').click();
  await expect.poll(() => jsonFrames(page)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: 'select_window', window_index: 1 }),
      expect.objectContaining({ type: 'select_window', window_index: 0 }),
      expect.objectContaining({ type: 'kill_window', window_index: 0 }),
    ]),
  );
  await expect.poll(() => sentFrames(page)).toEqual(
    expect.arrayContaining([[0x83, 0x02, 0x2c]]),
  );
});

test('single-pane session operator hides close-pane actions and ends cleanly when the pane exits', async ({ page }) => {
  await page.setViewportSize({ width: 1040, height: 640 });
  await page.addInitScript(() => {
    window.__rmuxShareReadyScope = 'session';
    window.__rmuxShareReadyRole = 'operator';
    window.__rmuxShareReadySize = { cols: 80, rows: 24 };
    window.__rmuxShareInitialSnapshot =
      '\x1b[0m\x1b[?25l\x1b[3J\x1b[2J\x1b[Honly pane'
      + '\x1b[24;1H[ci] 0:bash* "host" 16:34 27-May-26';
    window.__rmuxShareSessionView = {
      size: { cols: 80, rows: 24 },
      panes: [
        { id: 1, x: 0, y: 0, cols: 80, rows: 23, active: true, history_size: 0, scroll_offset: 0, alternate_on: false },
      ],
    };
  });
  await page.goto(`/#t=${operatorToken}`);

  await expect(page.locator('[data-share-status]')).toHaveText('Connected');
  await expect(page.locator('[data-share-session-controls]')).toBeVisible();
  await expect(page.locator('[data-share-kill-pane]')).toBeHidden();

  const screen = await page.locator('.xterm-screen').boundingBox();
  expect(screen).not.toBeNull();
  await page.mouse.click(screen!.x + 32, screen!.y + 32, { button: 'right' });
  await expect(page.locator('[data-share-terminal-controls]')).toBeVisible();
  await expect(page.locator('[data-share-terminal-split-horizontal]')).toBeVisible();
  await expect(page.locator('[data-share-terminal-kill-pane]')).toBeHidden();

  await page.evaluate(async () => {
    await window.__rmuxShareSockets?.at(-1)?.serverText({ type: 'pane_process_exit', exit_code: 0 });
  });

  await expect(page.locator('[data-share-status]')).toHaveText('Disconnected');
  await expect(page.locator('[data-share-session-controls]')).toBeHidden();
  await expect(page.locator('[data-share-terminal-placeholder]')).toContainText('Session ended');
  expect(await jsonFrames(page)).not.toContainEqual(expect.objectContaining({ type: 'kill_pane' }));
});

test('close-pane controls follow live session pane count', async ({ page }) => {
  await page.setViewportSize({ width: 1040, height: 640 });
  await page.addInitScript(() => {
    window.__rmuxShareReadyScope = 'session';
    window.__rmuxShareReadyRole = 'operator';
    window.__rmuxShareReadySize = { cols: 80, rows: 24 };
    window.__rmuxShareInitialSnapshot =
      '\x1b[0m\x1b[?25l\x1b[3J\x1b[2J\x1b[Hleft pane'
      + '\x1b[24;1H[ci] 0:bash* "host" 16:34 27-May-26';
    window.__rmuxShareSessionView = {
      size: { cols: 80, rows: 24 },
      panes: [
        { id: 1, x: 0, y: 0, cols: 80, rows: 23, active: true, history_size: 0, scroll_offset: 0, alternate_on: false },
      ],
    };
  });
  await page.goto(`/#t=${operatorToken}`);

  // Wait until the connection is fully established (initial snapshot rendered)
  // before pushing runtime session-view frames, so they are sealed and
  // delivered in order after the handshake frames rather than racing them
  // (v4's record layer rejects out-of-order frames).
  await expect(page.locator('.xterm')).toContainText('left pane');
  await expect(page.locator('[data-share-kill-pane]')).toBeHidden();
  await dispatchSessionView(page, {
    size: { cols: 80, rows: 24 },
    panes: [
      { id: 1, x: 0, y: 0, cols: 40, rows: 23, active: false, history_size: 0, scroll_offset: 0, alternate_on: false },
      { id: 2, x: 41, y: 0, cols: 39, rows: 23, active: true, history_size: 0, scroll_offset: 0, alternate_on: false },
    ],
  });
  await expect(page.locator('[data-share-kill-pane]')).toBeVisible();

  const screen = await page.locator('.xterm-screen').boundingBox();
  expect(screen).not.toBeNull();
  await page.mouse.click(screen!.x + 32, screen!.y + 32, { button: 'right' });
  await expect(page.locator('[data-share-terminal-kill-pane]')).toBeVisible();
  await page.mouse.click(screen!.x + 32, screen!.y + 32);

  await dispatchSessionView(page, {
    size: { cols: 80, rows: 24 },
    panes: [
      { id: 2, x: 0, y: 0, cols: 80, rows: 23, active: true, history_size: 0, scroll_offset: 0, alternate_on: false },
    ],
  });
  await expect(page.locator('[data-share-kill-pane]')).toBeHidden();
  await page.mouse.click(screen!.x + 32, screen!.y + 32, { button: 'right' });
  await expect(page.locator('[data-share-terminal-kill-pane]')).toBeHidden();
});

test('revoked session marks the terminal disconnected and disables session controls', async ({ page }) => {
  await page.setViewportSize({ width: 1040, height: 640 });
  await page.addInitScript(() => {
    window.__rmuxShareReadyScope = 'session';
    window.__rmuxShareReadyRole = 'operator';
    window.__rmuxShareReadySize = { cols: 80, rows: 24 };
    window.__rmuxShareInitialSnapshot =
      '\x1b[0m\x1b[?25l\x1b[3J\x1b[2J\x1b[Hleft pane'
      + '\x1b[1;42Hright pane'
      + '\x1b[24;1H[ci] 0:bash* "host" 16:34 27-May-26';
    window.__rmuxShareSessionView = {
      size: { cols: 80, rows: 24 },
      panes: [
        { id: 1, x: 0, y: 0, cols: 40, rows: 23, active: false, history_size: 0, scroll_offset: 0, alternate_on: false },
        { id: 2, x: 41, y: 0, cols: 39, rows: 23, active: true, history_size: 0, scroll_offset: 0, alternate_on: false },
      ],
    };
  });
  await page.goto(`/#t=${operatorToken}`);

  await expect(page.locator('[data-share-status]')).toHaveText('Connected');
  await expect(page.locator('[data-share-kill-pane]')).toBeVisible();
  await page.evaluate(async () => {
    await window.__rmuxShareSockets?.at(-1)?.serverText({ type: 'share_revoked', reason: 'session_gone' });
  });

  await expect(page.locator('[data-share-status]')).toHaveText('Disconnected');
  await expect(page.locator('[data-share-session-controls]')).toBeHidden();
  await expect(page.locator('[data-share-kill-pane]')).toBeHidden();
  await expect(page.locator('[data-share-terminal-placeholder]')).toContainText('Session ended');
});

test('session spectator cannot drag pane dividers', async ({ page }) => {
  await page.setViewportSize({ width: 1040, height: 640 });
  await page.addInitScript(() => {
    window.__rmuxShareReadyScope = 'session';
    window.__rmuxShareReadyRole = 'spectator';
    window.__rmuxShareReadySize = { cols: 80, rows: 24 };
    window.__rmuxShareInitialSnapshot =
      '\x1b[0m\x1b[?25l\x1b[3J\x1b[2J\x1b[Hleft pane'
      + '\x1b[1;42Hright pane'
      + '\x1b[24;1H[ci] 0:bash* "host" 16:34 27-May-26';
    window.__rmuxShareSessionView = {
      size: { cols: 80, rows: 24 },
      panes: [
        { id: 1, x: 0, y: 0, cols: 40, rows: 23, history_size: 0, scroll_offset: 0, alternate_on: false },
        { id: 2, x: 41, y: 0, cols: 39, rows: 23, history_size: 0, scroll_offset: 0, alternate_on: false },
      ],
    };
  });
  await page.goto(`/#t=${spectatorToken}`);
  await expect(page.locator('[data-share-status]')).toHaveText('Connected');
  await expect(page.locator('[data-share-session-controls]')).toBeHidden();
  await expect(page.locator('.share-role-badge')).toBeVisible();

  const screen = await page.locator('.xterm-screen').boundingBox();
  expect(screen).not.toBeNull();
  const dividerX = screen!.x + screen!.width * (40.5 / 80);
  const dividerY = screen!.y + screen!.height * (8 / 24);
  await page.mouse.move(dividerX, dividerY);
  await expect(page.locator('.share-terminal-stage')).not.toHaveAttribute('data-resize-axis', 'vertical');
  await page.mouse.down();
  await page.mouse.move(dividerX + screen!.width * (5 / 80), dividerY, { steps: 8 });
  await page.mouse.up();

  expect(await paneResizeFrames(page)).toEqual([]);
});

test('mobile session view opens a pane picker instead of desktop controls', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes('mobile'), 'mobile pane picker depends on coarse pointer layout');
  await page.addInitScript(() => {
    window.__rmuxShareReadyScope = 'session';
    window.__rmuxShareReadyRole = 'operator';
    window.__rmuxShareReadyControls = true;
    window.__rmuxShareReadySize = { cols: 80, rows: 28 };
    window.__rmuxShareInitialSnapshot =
      '\x1b[0m\x1b[?25l\x1b[3J\x1b[2J\x1b[Htop pane'
      + '\x1b[15;1Hbottom pane'
      + '\x1b[28;1H[ci] 0:bash* "host" 16:34 27-May-26';
    window.__rmuxShareSessionView = {
      size: { cols: 80, rows: 28 },
      panes: [
        { id: 1, x: 0, y: 0, cols: 80, rows: 13, active: true, history_size: 0, scroll_offset: 0, alternate_on: false },
        { id: 2, x: 0, y: 14, cols: 80, rows: 13, active: false, history_size: 0, scroll_offset: 0, alternate_on: false },
      ],
      windows: [
        { index: 0, name: 'bash', active: true },
      ],
    };
  });

  await page.goto(`/#t=${operatorToken}`);
  await expect(page.locator('[data-share-status]')).toHaveText('Connected');
  await expect(page.locator('[data-share-session-controls]')).toBeHidden();
  await expect(page.locator('[data-share-mobile-actions]')).toBeVisible();
  await expect(page.locator('[data-share-mobile-pane-select-row]')).toBeVisible();
  await expect(page.locator('[data-share-mobile-pane-current]')).toHaveText('All panes');
  await expect(page.locator('[data-share-terminal]')).not.toHaveAttribute('data-mobile-pane-focus', 'true');

  await page.locator('[data-share-mobile-actions]').click();
  await expect(page.locator('[data-share-mobile-control-menu]')).toBeVisible();
  await expect(page.locator('[data-share-mobile-stop-process]')).toContainText('Stop process');
  await expect(page.locator('[data-share-mobile-clear-screen]')).toContainText('Clear screen');
  await expect(page.locator('[data-share-mobile-reverse-search]')).toContainText('Reverse search');
  await expect(page.locator('[data-share-mobile-copy-pane]')).toContainText('Copy pane');
  await page.keyboard.press('Escape');

  await page.locator('[data-share-mobile-pane-select]').click();
  await expect(page.locator('[data-share-mobile-pane-menu]')).toBeVisible();
  await expect(page.locator('[data-share-mobile-pane-title]')).toHaveText('Window 0:bash');
  await expect(page.locator('[data-share-mobile-pane-list] button')).toHaveCount(3);
  await expect(page.locator('[data-share-mobile-pane-list] button').nth(0)).toContainText('All panes');
  await expect(page.locator('[data-share-mobile-pane-list] button').nth(1)).toContainText('Pane %1');
  await expect(page.locator('[data-share-mobile-pane-list] button').nth(2)).toContainText('Pane %2');

  await page.locator('[data-share-mobile-pane-list] button').nth(2).click();

  await expect(page.locator('[data-share-mobile-pane-menu]')).toBeHidden();
  await expect(page.locator('[data-share-terminal]')).toHaveAttribute('data-mobile-pane-focus', 'true');
  await expect(page.locator('[data-share-mobile-pane-current]')).toHaveText('Pane %2');
  // Focusing a single pane clips the stage to that pane so neighbours cannot leak in.
  await expect
    .poll(() => page.locator('.share-terminal-stage').evaluate((el) => (el as HTMLElement).style.clipPath))
    .not.toBe('none');
  await expect.poll(() => selectedPaneFrames(page)).toContainEqual({
    type: 'select_pane',
    pane_id: 2,
  });

  await page.locator('[data-share-mobile-pane-select]').click();
  await page.locator('[data-share-mobile-pane-list] button').nth(0).click();
  await expect(page.locator('[data-share-terminal]')).not.toHaveAttribute('data-mobile-pane-focus', 'true');
  await expect(page.locator('[data-share-mobile-pane-current]')).toHaveText('All panes');
  // All-panes mode shows the full grid, so the clip is removed.
  await expect
    .poll(() => page.locator('.share-terminal-stage').evaluate((el) => (el as HTMLElement).style.clipPath))
    .toBe('none');
});

test('mobile keyboard does not resize the remote grid while a pane is focused', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes('mobile'), 'keyboard inset only applies to the coarse-pointer mobile layout');
  await page.addInitScript(() => {
    window.__rmuxShareReadyScope = 'session';
    window.__rmuxShareReadyRole = 'operator';
    window.__rmuxShareReadyControls = true;
    window.__rmuxShareReadySize = { cols: 80, rows: 24 };
    window.__rmuxShareSessionView = {
      size: { cols: 80, rows: 24 },
      panes: [
        { id: 1, x: 0, y: 0, cols: 80, rows: 11, active: false },
        { id: 2, x: 0, y: 12, cols: 80, rows: 11, active: true },
      ],
      windows: [{ index: 0, name: 'bash', active: true }],
    };
  });
  await page.addInitScript(() => {
    // Controllable visualViewport so the test can raise/lower the on-screen
    // keyboard (which shrinks the visible viewport by `kb` px).
    let kb = 0;
    const target = new EventTarget();
    const vv = {
      get height() { return window.innerHeight - kb; },
      get width() { return window.innerWidth; },
      get offsetTop() { return 0; },
      get offsetLeft() { return 0; },
      get pageTop() { return 0; },
      get pageLeft() { return 0; },
      get scale() { return 1; },
      addEventListener: (t: string, l: EventListenerOrEventListenerObject) => target.addEventListener(t, l),
      removeEventListener: (t: string, l: EventListenerOrEventListenerObject) => target.removeEventListener(t, l),
      dispatchEvent: (e: Event) => target.dispatchEvent(e),
    };
    try {
      Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => vv });
    } catch {
      // Some engines lock visualViewport; the test's height-drop poll will flag it.
    }
    (window as unknown as { __setKeyboard: (px: number) => void }).__setKeyboard = (px: number) => {
      kb = px;
      vv.dispatchEvent(new Event('resize'));
      window.dispatchEvent(new Event('resize'));
    };
  });
  await page.goto(`/#t=${operatorToken}`);
  await expect(page.locator('[data-share-status]')).toHaveText('Connected');

  // Focus a single pane: focus-fill grows the remote so the pane fills the screen.
  await page.locator('[data-share-mobile-pane-select]').click();
  await page.locator('[data-share-mobile-pane-list] button').nth(2).click();
  await expect(page.locator('[data-share-terminal]')).toHaveAttribute('data-mobile-pane-focus', 'true');
  await expect.poll(async () => (await sentFrames(page)).some(isResizeFrame)).toBe(true);

  // Let the focus-fill resize settle, then snapshot how many resizes were sent.
  await page.waitForTimeout(250);
  const beforeCount = (await sentFrames(page)).filter(isResizeFrame).length;
  const heightBefore = await page.locator('[data-share-terminal]').evaluate((el) => el.clientHeight);

  // Raise the keyboard: the visible viewport (and the terminal) shrinks.
  await page.evaluate(() => (window as unknown as { __setKeyboard: (px: number) => void }).__setKeyboard(340));
  await expect
    .poll(() => page.locator('[data-share-terminal]').evaluate((el) => el.clientHeight))
    .toBeLessThan(heightBefore);
  await page.waitForTimeout(300);

  // The remote grid is keyboard-independent, so opening the keyboard must NOT
  // send another resize (which is what made the focused pane jump on iOS).
  const afterCount = (await sentFrames(page)).filter(isResizeFrame).length;
  expect(afterCount).toBe(beforeCount);
});

test('mobile keyboard inset survives per-keystroke viewport scroll jitter', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes('mobile'), 'keyboard inset only applies to the coarse-pointer mobile layout');
  // Single-pane session operator with a full-screen TUI + bottom status bar — the
  // exact shape from the iOS bug report.
  await page.addInitScript(() => {
    window.__rmuxShareReadyScope = 'session';
    window.__rmuxShareReadyRole = 'operator';
    window.__rmuxShareReadyControls = true;
    window.__rmuxShareReadySize = { cols: 80, rows: 24 };
    window.__rmuxShareInitialSnapshot =
      '\x1b[0m\x1b[?25l\x1b[3J\x1b[2J\x1b[Hwelcome'
      + '\x1b[24;1H[ci] 0:bash* "host" 16:34 27-May-26';
    window.__rmuxShareSessionView = {
      size: { cols: 80, rows: 24 },
      panes: [{ id: 1, x: 0, y: 0, cols: 80, rows: 23, active: true, history_size: 0, scroll_offset: 0, alternate_on: false }],
      windows: [{ index: 0, name: 'bash', active: true }],
    };
  });
  // Controllable visualViewport. iOS scrolls the layout viewport under the keyboard
  // on every keystroke, spiking visualViewport.offsetTop while the keyboard height
  // (kb) is unchanged. The old inset formula subtracted offsetTop, so a spike made
  // the keyboard look (briefly) closed and zeroed the inset mid-typing — which
  // collapsed the remote grid and the whole terminal on WebKit.
  await page.addInitScript(() => {
    let kb = 0;
    let offTop = 0;
    const target = new EventTarget();
    const vv = {
      get height() { return window.innerHeight - kb; },
      get width() { return window.innerWidth; },
      get offsetTop() { return offTop; },
      get offsetLeft() { return 0; },
      get pageTop() { return offTop; },
      get pageLeft() { return 0; },
      get scale() { return 1; },
      addEventListener: (t: string, l: EventListenerOrEventListenerObject) => target.addEventListener(t, l),
      removeEventListener: (t: string, l: EventListenerOrEventListenerObject) => target.removeEventListener(t, l),
      dispatchEvent: (e: Event) => target.dispatchEvent(e),
    };
    try {
      Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => vv });
    } catch {
      // Some engines lock visualViewport; the inset assertions below will flag it.
    }
    (window as unknown as { __kbd: Record<string, (px?: number) => void> }).__kbd = {
      open: (px = 336) => { kb = px; offTop = 0; vv.dispatchEvent(new Event('resize')); window.dispatchEvent(new Event('resize')); },
      scrollSpike: (px = 0) => { offTop = px; vv.dispatchEvent(new Event('scroll')); },
      close: () => { kb = 0; offTop = 0; vv.dispatchEvent(new Event('resize')); window.dispatchEvent(new Event('resize')); },
    };
  });

  await page.goto(`/#t=${operatorToken}`);
  await expect(page.locator('[data-share-status]')).toHaveText('Connected');

  const inset = () =>
    page.locator('.share-app').evaluate((el) => getComputedStyle(el).getPropertyValue('--keyboard-inset').trim());
  const frame = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));

  // Open the on-screen keyboard: the inset lifts the terminal above it.
  await page.evaluate(() => (window as unknown as { __kbd: { open: (px?: number) => void } }).__kbd.open(336));
  await expect.poll(inset).toBe('336px');
  const openInset = await inset();

  // Per-keystroke scroll jitter: visualViewport.offsetTop spikes while the keyboard
  // stays open. The inset MUST hold — it must never read the keyboard as closed or
  // partial, which is what shrank the grid and made everything jump to the top.
  for (const spike of [260, 0, 220, 0, 280, 0, 240]) {
    await page.evaluate((px) => (window as unknown as { __kbd: { scrollSpike: (px: number) => void } }).__kbd.scrollSpike(px), spike);
    await frame();
    const current = await inset();
    expect(current, `keyboard inset changed to ${current} on a ${spike}px scroll spike (keyboard still open)`).toBe(openInset);
  }

  // A genuine, sustained keyboard close still lowers the inset back to 0.
  await page.evaluate(() => (window as unknown as { __kbd: { close: () => void } }).__kbd.close());
  await expect.poll(inset).toBe('0px');
});

test('mobile single-pane session hides the redundant pane picker row', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes('mobile'), 'mobile pane picker depends on coarse pointer layout');
  await page.addInitScript(() => {
    window.__rmuxShareReadyScope = 'session';
    window.__rmuxShareReadyRole = 'operator';
    window.__rmuxShareReadyControls = true;
    window.__rmuxShareReadySize = { cols: 80, rows: 24 };
    window.__rmuxShareInitialSnapshot =
      '\x1b[0m\x1b[?25l\x1b[3J\x1b[2J\x1b[Honly pane'
      + '\x1b[24;1H[ci] 0:bash* "host" 16:34 27-May-26';
    window.__rmuxShareSessionView = {
      size: { cols: 80, rows: 24 },
      panes: [
        { id: 1, x: 0, y: 0, cols: 80, rows: 23, active: true, history_size: 0, scroll_offset: 0, alternate_on: false },
      ],
      windows: [
        { index: 0, name: 'bash', active: true },
      ],
    };
  });

  await page.goto(`/#t=${operatorToken}`);
  await expect(page.locator('[data-share-status]')).toHaveText('Connected');
  await expect(page.locator('[data-share-mobile-actions]')).toBeVisible();
  await expect(page.locator('[data-share-mobile-pane-select-row]')).toBeHidden();
});

test('mobile leaves the terminal long-press to native selection and puts clipboard in the actions menu', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes('mobile'), 'mobile menu depends on the mobile viewport');
  await page.addInitScript(() => {
    window.__rmuxShareReadyScope = 'session';
    window.__rmuxShareReadyRole = 'operator';
    window.__rmuxShareReadyControls = true;
    window.__rmuxShareReadySize = { cols: 80, rows: 24 };
    window.__rmuxShareInitialSnapshot =
      '\x1b[0m\x1b[?25l\x1b[3J\x1b[2J\x1b[Hleft pane'
      + '\x1b[24;1H[ci] 0:bash* "host" 16:34 27-May-26';
    window.__rmuxShareSessionView = {
      size: { cols: 80, rows: 24 },
      panes: [
        { id: 1, x: 0, y: 0, cols: 80, rows: 23, active: true, history_size: 0, scroll_offset: 0, alternate_on: false },
      ],
    };
  });
  await page.goto(`/#t=${operatorToken}`);
  await expect(page.locator('[data-share-status]')).toHaveText('Connected');

  const screen = await page.locator('.xterm-screen').boundingBox();
  expect(screen).not.toBeNull();
  await page.mouse.click(screen!.x + 32, screen!.y + 32, { button: 'right' });

  // The custom terminal menu no longer hijacks a long-press on mobile, so the
  // browser can do native text selection; clipboard lives in the actions menu.
  await expect(page.locator('[data-share-terminal-menu]')).toBeHidden();
  await page.locator('[data-share-mobile-actions]').click();
  await expect(page.locator('[data-share-mobile-control-menu]')).toBeVisible();
  await expect(page.locator('[data-share-mobile-copy]')).toBeVisible();
  await expect(page.locator('[data-share-mobile-paste]')).toBeVisible();
});

test('session operator stays pinned to the top when typing into a scaled grid', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.includes('mobile'), 'needs a focused desktop terminal to drive keystrokes');
  // A tall session grid in a short viewport is CSS-scaled to fit. The scale
  // transform is visual only, so the container stays scrollable. Typing calls
  // followLiveOutput on each key; for a session that must keep the grid pinned to
  // the top, NOT scroll to the bottom (which blanked the top rows each keystroke on
  // iOS/WebKit, where the untransformed layout height keeps the container scrollable).
  await page.setViewportSize({ width: 520, height: 320 });
  await page.addInitScript(() => {
    window.__rmuxShareReadyScope = 'session';
    window.__rmuxShareReadyRole = 'operator';
    window.__rmuxShareReadyControls = true;
    window.__rmuxShareReadySize = { cols: 80, rows: 40 };
    window.__rmuxShareInitialSnapshot =
      '\x1b[0m\x1b[?25l\x1b[3J\x1b[2J\x1b[Htop line one'
      + '\x1b[40;1H[ci] 0:bash* "host" 22:00 31-May-26';
    window.__rmuxShareSessionView = {
      size: { cols: 80, rows: 40 },
      panes: [{ id: 1, x: 0, y: 0, cols: 80, rows: 39, active: true, history_size: 0, scroll_offset: 0, alternate_on: false }],
      windows: [{ index: 0, name: 'bash', active: true }],
    };
  });
  await page.goto(`/#t=${operatorToken}`);
  await expect(page.locator('[data-share-status]')).toHaveText('Connected');
  await expect(page.locator('.xterm')).toContainText('top line one');

  const container = page.locator('[data-share-terminal]');
  // The grid is taller than the container — the precondition for the scroll blank.
  const scrollable = await container.evaluate((el) => el.scrollHeight - el.clientHeight);
  expect(scrollable, 'the scaled session grid should overflow the short container').toBeGreaterThan(0);

  await page.locator('.xterm-screen').click({ position: { x: 8, y: 8 } });
  await page.keyboard.type('echo hi');

  // Typing must not scroll the session away from the top.
  await expect.poll(() => container.evaluate((el) => el.scrollTop)).toBe(0);
});

test('mobile keyboard keeps a single-pane session readable instead of shrinking it', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes('mobile'), 'keyboard scaling is mobile-only');
  await page.addInitScript(() => {
    // A grid that fits the phone WIDTH but is much taller than it — so the keyboard
    // makes the height overflow while the width stays at natural (full) scale.
    window.__rmuxShareReadyScope = 'session';
    window.__rmuxShareReadyRole = 'operator';
    window.__rmuxShareReadyControls = true;
    window.__rmuxShareReadySize = { cols: 40, rows: 60 };
    window.__rmuxShareInitialSnapshot =
      '\x1b[0m\x1b[?25l\x1b[3J\x1b[2J\x1b[Htop line one'
      + '\x1b[60;1H[ci] 0:bash* "host" 22:00 31-May-26';
    window.__rmuxShareSessionView = {
      size: { cols: 40, rows: 60 },
      panes: [{ id: 1, x: 0, y: 0, cols: 40, rows: 59, active: true, history_size: 0, scroll_offset: 0, alternate_on: false }],
      windows: [{ index: 0, name: 'bash', active: true }],
    };
  });
  await page.addInitScript(() => {
    let kb = 0;
    const target = new EventTarget();
    const vv = {
      get height() { return window.innerHeight - kb; },
      get width() { return window.innerWidth; },
      get offsetTop() { return 0; },
      get offsetLeft() { return 0; },
      get pageTop() { return 0; },
      get pageLeft() { return 0; },
      get scale() { return 1; },
      addEventListener: (t: string, l: EventListenerOrEventListenerObject) => target.addEventListener(t, l),
      removeEventListener: (t: string, l: EventListenerOrEventListenerObject) => target.removeEventListener(t, l),
      dispatchEvent: (e: Event) => target.dispatchEvent(e),
    };
    try {
      Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => vv });
    } catch {
      // ignore engines that lock visualViewport; the precondition poll will flag it.
    }
    (window as unknown as { __kbd: { open: (px: number) => void } }).__kbd = {
      open: (px: number) => { kb = px; vv.dispatchEvent(new Event('resize')); window.dispatchEvent(new Event('resize')); },
    };
  });
  await page.goto(`/#t=${operatorToken}`);
  await expect(page.locator('[data-share-status]')).toHaveText('Connected');

  // Open the keyboard: the grid is kept at its full (keyboard-independent) height, so
  // the rendered xterm screen becomes taller than the now-shrunk container.
  await page.evaluate(() => (window as unknown as { __kbd: { open: (px: number) => void } }).__kbd.open(336));
  const screen = page.locator('.xterm-screen');
  const container = page.locator('[data-share-terminal]');
  await expect
    .poll(async () =>
      (await screen.evaluate((el) => el.clientHeight)) > (await container.evaluate((el) => el.clientHeight)))
    .toBe(true);

  // The stage must stay at (near) natural size — cursor-follow, not a heavy shrink to
  // an unreadable ~0.55 scale.
  await expect.poll(() => page.locator('.share-terminal-stage').evaluate((el) => {
    const transform = getComputedStyle(el).transform;
    return transform === 'none' ? 1 : new DOMMatrix(transform).a;
  }), {
    message: 'keyboard-open single-pane session should stay readable, not shrink',
  }).toBeGreaterThan(0.9);
});

test('short landscape grows the grid and lets the user pan to the top of a full-screen app', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes('mobile'), 'landscape view-pan is touch-only');
  await page.setViewportSize({ width: 800, height: 360 });
  await page.addInitScript(() => {
    window.__rmuxShareReadyScope = 'session';
    window.__rmuxShareReadyRole = 'operator';
    window.__rmuxShareReadyControls = true;
    window.__rmuxShareReadySize = { cols: 80, rows: 40 };
    window.__rmuxShareInitialSnapshot =
      '\x1b[0m\x1b[?25l\x1b[3J\x1b[2J\x1b[HTOP HEADER LINE'
      + '\x1b[40;1H[ci] 0:app* "host" 00:00 01-Jun-26';
    // A single full-screen (alternate-screen) app, taller than the short landscape.
    window.__rmuxShareSessionView = {
      size: { cols: 80, rows: 40 },
      panes: [{ id: 1, x: 0, y: 0, cols: 80, rows: 40, active: true, history_size: 0, scroll_offset: 0, alternate_on: true }],
      windows: [{ index: 0, name: 'app', active: true }],
    };
  });
  await page.goto(`/#t=${operatorToken}`);
  await expect(page.locator('[data-share-status]')).toHaveText('Connected');
  expect(
    await page.evaluate(() => window.matchMedia('(pointer: coarse) and (orientation: landscape) and (max-height: 480px)').matches),
  ).toBe(true);

  // The operator requests a TALLER grid than the short viewport fits (so the app can
  // draw its whole UI), not the ~18 rows that fit at natural size.
  await expect
    .poll(async () => {
      const frames = (await sentFrames(page)).filter(isResizeFrame).map(decodeResizeFrame);
      return frames.length ? Math.max(...frames.map((f) => f.rows)) : 0;
    })
    .toBeGreaterThan(24);

  const translateY = () =>
    page.locator('.share-terminal-stage').evaluate((el) => {
      const transform = getComputedStyle(el).transform;
      return transform === 'none' ? 0 : new DOMMatrix(transform).f;
    });
  // Default view is pinned to the BOTTOM of the tall grid (where the cursor/input is),
  // so the stage is translated up (translateY < 0).
  await expect.poll(translateY).toBeLessThan(-20);
  const atBottom = await translateY();

  // Drag one finger DOWN on the terminal → reveal the TOP (translateY moves toward 0).
  await page.evaluate(() => {
    const el = document.querySelector('[data-share-terminal]') as HTMLElement;
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y0 = rect.top + 16;
    const fire = (type: string, y: number) =>
      el.dispatchEvent(new PointerEvent(type, { pointerId: 1, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, cancelable: true }));
    fire('pointerdown', y0);
    for (let dy = 12; dy <= 220; dy += 12) {
      fire('pointermove', y0 + dy);
    }
    fire('pointerup', y0 + 220);
  });
  expect(await translateY(), 'dragging down should reveal the top of the app').toBeGreaterThan(atBottom + 20);
});

test('mobile: tapping the green status bar selects the window without focusing the terminal', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes('mobile'), 'status-bar keyboard behaviour is mobile-only');
  await page.addInitScript(() => {
    window.__rmuxShareReadyScope = 'session';
    window.__rmuxShareReadyRole = 'operator';
    window.__rmuxShareReadyControls = true;
    window.__rmuxShareReadySize = { cols: 80, rows: 24 };
    window.__rmuxShareInitialSnapshot =
      '\x1b[0m\x1b[?25l\x1b[3J\x1b[2J\x1b[Hhome'
      + '\x1b[24;1H[ci] 0:bash* 1:logs "host" 16:34 27-May-26';
    window.__rmuxShareSessionView = {
      size: { cols: 80, rows: 24 },
      panes: [{ id: 1, x: 0, y: 0, cols: 80, rows: 23, active: true, history_size: 0, scroll_offset: 0, alternate_on: false }],
      windows: [
        { index: 0, name: 'bash', active: true },
        { index: 1, name: 'logs', active: false },
      ],
    };
  });
  await page.goto(`/#t=${operatorToken}`);
  await expect(page.locator('[data-share-status]')).toHaveText('Connected');
  await expect(page.locator('.xterm')).toContainText('logs');

  const textareaFocused = () =>
    page.evaluate(() => document.activeElement === document.querySelector('.xterm-helper-textarea'));
  const screen = await page.locator('.xterm-screen').boundingBox();
  expect(screen).not.toBeNull();

  // Sanity: a real touch tap on the CONTENT focuses the terminal (so the keyboard
  // would open) — this proves the focus check below is meaningful.
  await page.touchscreen.tap(screen!.x + screen!.width * 0.5, screen!.y + screen!.height * 0.25);
  await expect.poll(textareaFocused).toBe(true);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

  // A real touch tap on the "1:logs" label of the green status row selects the
  // window WITHOUT focusing the terminal (so no on-screen keyboard pops up).
  await page.touchscreen.tap(screen!.x + screen!.width * (16 / 80), screen!.y + screen!.height - 4);
  await expect
    .poll(() => jsonFrames(page))
    .toEqual(expect.arrayContaining([expect.objectContaining({ type: 'select_window', window_index: 1 })]));
  expect(await textareaFocused(), 'tapping the status bar must not focus the terminal').toBe(false);
});

test('session operator drives the remote size from the browser viewport', async ({ page }) => {
  await page.setViewportSize({ width: 1040, height: 640 });
  await page.addInitScript(() => {
    window.__rmuxShareReadyScope = 'session';
    window.__rmuxShareReadyRole = 'operator';
    window.__rmuxShareReadySize = { cols: 80, rows: 24 };
    window.__rmuxShareInitialSnapshot =
      '\x1b[0m\x1b[?25l\x1b[3J\x1b[2J\x1b[Hprompt'
      + '\x1b[24;1H[ci] 0:bash* "very-long-hostname" 16:34 27-May-26';
  });

  await page.goto(`/#t=${operatorToken}`);
  await expect(page.locator('[data-share-status]')).toHaveText('Connected');
  await expect.poll(async () => (await sentFrames(page)).some(isResizeFrame)).toBe(true);
  const firstResize = (await sentFrames(page)).find(isResizeFrame);
  expect(firstResize).toBeDefined();
  expect(decodeResizeFrame(firstResize!)).toMatchObject({
    cols: expect.any(Number),
    rows: expect.any(Number),
  });

  await page.setViewportSize({ width: 720, height: 420 });
  // Both desktop and mobile operators drive the remote size from the browser
  // viewport, so shrinking the window sends a smaller follow-up resize.
  await expect.poll(async () => (await sentFrames(page)).filter(isResizeFrame).length).toBeGreaterThan(1);
  const resizeFrames = (await sentFrames(page)).filter(isResizeFrame);
  const last = decodeResizeFrame(resizeFrames.at(-1)!);
  const first = decodeResizeFrame(firstResize!);
  expect(last.cols).toBeLessThan(first.cols);
  expect(last.rows).toBeLessThan(first.rows);
});

test('bursty encrypted output frames are decrypted in wire order', async ({ page }) => {
  await page.addInitScript(() => {
    const decrypt = SubtleCrypto.prototype.decrypt;
    let calls = 0;
    SubtleCrypto.prototype.decrypt = function delayedDecrypt(...args) {
      const result = decrypt.apply(this, args);
      if (calls++ === 2) {
        return new Promise((resolve, reject) => {
          setTimeout(() => {
            result.then(resolve, reject);
          }, 30);
        });
      }
      return result;
    };
    window.__rmuxSharePostSnapshotFrames = [
      new Uint8Array([0x01, ...new TextEncoder().encode('burst one')]).buffer,
      new Uint8Array([0x01, ...new TextEncoder().encode('burst two')]).buffer,
    ];
  });

  await page.goto(`/#t=${spectatorToken}`);

  await expect(page.locator('[data-share-status]')).toHaveText('Connected');
  await expect(page.locator('.xterm')).toContainText('burst one');
  await expect(page.locator('.xterm')).toContainText('burst two');
  await expect(page.locator('[data-share-terminal]')).not.toContainText('encrypted frame failed authentication');
});

test('terminal theme selection persists locally', async ({ page }) => {
  const url = `/#t=${spectatorToken}`;
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
      security_statement: 'This static page runs in your browser. It connects directly to your rmux daemon through loopback or your tunnel, with terminal traffic encrypted end-to-end. The share token stays in the URL fragment and is never sent to share.rmux.io.',
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

  await page.goto(`/#t=${spectatorToken}`);
  await expect(page.locator('[data-share-status]')).toHaveText('Connected');
  const screen = await page.locator('.xterm-screen').boundingBox();
  expect(screen).not.toBeNull();
  await page.mouse.click(screen!.x + 32, screen!.y + 32, { button: 'right' });
  await expect(page.locator('[data-share-terminal-menu]')).toBeVisible();
  await page.locator('[data-share-terminal-provenance]').click();

  await expect(page.locator('[data-share-provenance]')).toBeVisible();
  await expect(page.locator('[data-share-provenance-statement]')).toContainText('This static page runs in your browser.');
  await expect(page.locator('[data-share-provenance-statement]')).toContainText('never sent to share.rmux.io');
  await expect(page.locator('[data-share-provenance-docs]')).toHaveAttribute('href', 'https://rmux.io/docs/web-share/');
  await expect(page.locator('[data-share-provenance-commit]')).toHaveText('0123456789ab');
  await expect(page.locator('[data-share-provenance-run]')).toHaveText('run 123456');
  await expect(page.locator('[data-share-provenance-cloudflare]')).toHaveText('rmux-web-share');
});

test('operator sends xterm data and can open the disconnect dialog from exit', async ({ page }) => {
  await page.goto(`/#t=${operatorToken}`);

  await expect(page.locator('.share-role-badge')).toBeHidden();
  await page.locator('.xterm').click();
  await page.keyboard.type('x');
  await expect.poll(() => sentFrames(page)).toContainEqual([0x80, 120]);

  await page.locator('[data-share-session-menu]').click();
  await expect(page.locator('[data-share-session-actions]')).toBeVisible();
  await expect(page.locator('[data-share-session-actions] :is(h1, h2)')).toHaveText('Disconnect');
  await expect(page.locator('[data-share-session-detach]')).toBeVisible();
  await expect(page.locator('[data-share-session-detach]')).toHaveText('Disconnect only');
  await expect(page.locator('[data-share-session-release]')).toHaveCount(0);
  await expect(page.locator('[data-share-session-cancel]')).toHaveCount(0);
  await expect(page.locator('[data-share-session-provenance]')).toHaveCount(0);
  await expect(page.locator('[data-share-session-logout]')).toBeHidden();
  await page.locator('[data-share-session-close]').click();
  await expect(page.locator('[data-share-session-actions]')).toBeHidden();
});

test('terminal context menu exposes terminal actions without opening window actions', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.includes('mobile'), 'mobile uses a simplified terminal context menu.');
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        readText: async () => 'pwd',
        writeText: async (text: string) => {
          (window as unknown as { __rmuxCopiedTerminal?: string }).__rmuxCopiedTerminal = text;
        },
      },
    });
  });
  await page.goto(`/#t=${operatorToken}`);
  await expect(page.locator('[data-share-status]')).toHaveText('Connected');

  const screen = await page.locator('.xterm-screen').boundingBox();
  expect(screen).not.toBeNull();
  await page.mouse.click(screen!.x + 32, screen!.y + 32, { button: 'right' });

  await expect(page.locator('[data-share-terminal-menu]')).toBeVisible();
  await expect(page.locator('[data-share-window-menu]')).toBeHidden();
  await expect(page.locator('[data-share-terminal-copy]')).toBeDisabled();
  await expect(page.locator('[data-share-terminal-paste]')).toBeEnabled();
  await expect(page.locator('[data-share-terminal-toolbar-label]')).toHaveText('Hide toolbar');
  await expect(page.locator('[data-share-terminal-copy-shortcut]')).toHaveText(/^(Ctrl\+|⌘)C$/);
  await expect(page.locator('[data-share-terminal-paste-shortcut]')).toHaveText(/^(Ctrl\+|⌘)V$/);
  await expect(page.locator('[data-share-terminal-controls]')).toBeHidden();

  await page.locator('[data-share-terminal-paste]').click();
  await expect.poll(() => sentFrames(page)).toContainEqual([0x80, 112, 119, 100]);

  await page.mouse.click(screen!.x + 32, screen!.y + 32, { button: 'right' });
  await page.locator('[data-share-terminal-show-toolbar]').click();
  await expect(page.locator('.share-app')).toHaveAttribute('data-chrome', 'hidden');
});

test('session operator terminal menu exposes session controls with shortcuts', async ({ page }) => {
  await page.setViewportSize({ width: 1040, height: 640 });
  await page.addInitScript(() => {
    window.__rmuxShareReadyScope = 'session';
    window.__rmuxShareReadyRole = 'operator';
    window.__rmuxShareReadySize = { cols: 80, rows: 24 };
    window.__rmuxShareInitialSnapshot =
      '\x1b[0m\x1b[?25l\x1b[3J\x1b[2J\x1b[Hleft pane'
      + '\x1b[1;42Hright pane'
      + '\x1b[24;1H[ci] 0:bash* "host" 16:34 27-May-26';
    window.__rmuxShareSessionView = {
      size: { cols: 80, rows: 24 },
      panes: [
        { id: 1, x: 0, y: 0, cols: 40, rows: 23, active: false, history_size: 0, scroll_offset: 0, alternate_on: false },
        { id: 2, x: 41, y: 0, cols: 39, rows: 23, active: true, history_size: 0, scroll_offset: 0, alternate_on: false },
      ],
    };
  });
  await page.goto(`/#t=${operatorToken}`);
  await expect(page.locator('[data-share-status]')).toHaveText('Connected');

  const screen = await page.locator('.xterm-screen').boundingBox();
  expect(screen).not.toBeNull();
  const openTerminalMenu = async () => {
    await page.mouse.click(screen!.x + 32, screen!.y + 32, { button: 'right' });
    await expect(page.locator('[data-share-terminal-menu]')).toBeVisible();
    await expect(page.locator('[data-share-terminal-controls]')).toBeVisible();
  };

  await openTerminalMenu();
  await expect(page.locator('[data-share-terminal-split-horizontal]')).toContainText('Split Horizontally');
  await expect(page.locator('[data-share-terminal-split-horizontal] .share-menu-shortcut')).toHaveText('Ctrl+B %');
  await expect(page.locator('[data-share-terminal-split-vertical] .share-menu-shortcut')).toHaveText('Ctrl+B "');
  await expect(page.locator('[data-share-terminal-new-window] .share-menu-shortcut')).toHaveText('Ctrl+B C');
  await expect(page.locator('[data-share-terminal-kill-pane] .share-menu-shortcut')).toHaveText('Ctrl+B X');

  await page.locator('[data-share-terminal-split-horizontal]').click();
  await openTerminalMenu();
  await page.locator('[data-share-terminal-split-vertical]').click();
  await openTerminalMenu();
  await page.locator('[data-share-terminal-new-window]').click();
  await openTerminalMenu();
  await page.locator('[data-share-terminal-kill-pane]').click();

  await expect.poll(() => jsonFrames(page)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: 'split_pane', direction: 'horizontal' }),
      expect.objectContaining({ type: 'split_pane', direction: 'vertical' }),
      expect.objectContaining({ type: 'new_window' }),
      expect.objectContaining({ type: 'kill_pane' }),
    ]),
  );
});

test('disconnected session operator hides session controls while reconnecting automatically', async ({ page }) => {
  await page.setViewportSize({ width: 1040, height: 640 });
  await page.addInitScript(() => {
    window.__rmuxShareReadyScope = 'session';
    window.__rmuxShareReadyRole = 'operator';
    window.__rmuxShareReadyControls = true;
    window.__rmuxShareReadySize = { cols: 80, rows: 24 };
    window.__rmuxShareInitialSnapshot =
      '\x1b[0m\x1b[?25l\x1b[3J\x1b[2J\x1b[Hleft pane'
      + '\x1b[24;1H[ci] 0:bash* "host" 16:34 27-May-26';
    window.__rmuxShareSessionView = {
      size: { cols: 80, rows: 24 },
      panes: [
        { id: 1, x: 0, y: 0, cols: 80, rows: 23, active: true, history_size: 0, scroll_offset: 0, alternate_on: false },
      ],
    };
  });
  await page.goto(`/#t=${operatorToken}`);

  await expect(page.locator('[data-share-status]')).toHaveText('Connected');
  await expect(page.locator('[data-share-session-controls]')).toBeVisible();

  await page.evaluate(() => {
    const socket = window.__rmuxShareSockets?.at(-1) as unknown as { closeWith?: (code: number, reason: string) => void };
    socket?.closeWith?.(1006, '');
  });

  await expect(page.locator('[data-share-status]')).toHaveText('Disconnected');
  await expect(page.locator('[data-share-session-controls]')).toBeHidden();
  await expect(page.locator('.share-placeholder-state')).toContainText('Disconnected. Reconnecting...');

  const screen = await page.locator('.xterm-screen').boundingBox();
  expect(screen).not.toBeNull();
  await page.mouse.click(screen!.x + 32, screen!.y + 32, { button: 'right' });
  await expect(page.locator('[data-share-terminal-menu]')).toBeHidden();
  await expect(page.locator('[data-share-terminal-controls]')).toBeHidden();

  await expect.poll(() => socketCount(page)).toBe(2);
  await expect(page.locator('[data-share-status]')).toHaveText('Connected');
  await expect(page.locator('[data-share-session-controls]')).toBeVisible();
});

test('role capacity close shows a retrying max-limit state', async ({ page }) => {
  await page.goto(`/#t=${spectatorToken}`);
  await expect(page.locator('[data-share-status]')).toHaveText('Connected');

  const closedState = await page.evaluate(() => {
    const socket = window.__rmuxShareSockets?.at(-1) as unknown as { closeWith?: (code: number, reason: string) => void };
    socket?.closeWith?.(4009, 'capacity_reached');
    return {
      status: document.querySelector('[data-share-status]')?.textContent,
      placeholder: document.querySelector('.share-placeholder-state')?.textContent,
      spinner: Boolean(document.querySelector('.share-placeholder-spinner')),
    };
  });

  expect(closedState).toMatchObject({
    status: 'Disconnected',
    placeholder: expect.stringContaining('Max limit reached. Trying to reconnect...'),
    spinner: true,
  });

  await expect.poll(() => socketCount(page)).toBe(2);
  await expect(page.locator('[data-share-status]')).toHaveText('Connected');
});

test('operator disconnect returns to recent links without reusing the share secret', async ({ page }) => {
  await page.goto(`/#t=${operatorToken}`);
  await expect.poll(() => socketCount(page)).toBe(1);
  await expect.poll(() => new URL(page.url()).hash).toBe('');

  await page.locator('[data-share-session-menu]').click();
  await page.locator('[data-share-session-detach]').click();

  await expect(page.locator('.home-connect-card')).toBeVisible();
  await expect(page.locator('.home-recent-row')).toHaveCount(1);
  await expect(page.locator('.home-status')).toHaveText('Disconnected');
  await expect(page.locator('.home-row-connect')).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.sessionStorage.getItem('rmux.share.activeParams.v1')))
    .toBeNull();
});

test('active shares announce recent links to new index tabs', async ({ page, context }) => {
  await page.goto(`/#t=${operatorToken}`);
  await expect(page.locator('[data-share-status]')).toHaveText('Connected');

  const index = await context.newPage();
  await index.goto('/');
  await expect(index.locator('.home-recent-row')).toHaveCount(1);
  await expect(index.locator('.home-recent-title strong')).toHaveText('%1');
  await expect(index.locator('.home-status')).toHaveText('Active');
});

test('spectator exit returns to recent links without opening a disconnect dialog', async ({ page }) => {
  await page.goto(`/#t=${spectatorToken}`);
  await expect(page.locator('[data-share-status]')).toHaveText('Connected');

  await page.locator('[data-share-session-menu]').click();

  await expect(page.locator('[data-share-session-actions]')).toBeHidden();
  await expect(page.locator('.home-connect-card')).toBeVisible();
  await expect(page.locator('.home-status')).toHaveText('Disconnected');
});

test('session operator can logout the shared session from the exit menu', async ({ page }) => {
  await page.addInitScript(() => {
    window.__rmuxShareReadyScope = 'session';
    window.__rmuxShareReadyControls = true;
  });
  await page.goto(`/#t=${operatorToken}`);

  await page.locator('[data-share-session-menu]').click();
  await expect(page.locator('[data-share-session-actions]')).toBeVisible();
  await expect(page.locator('[data-share-session-logout]')).toBeVisible();
  await page.locator('[data-share-session-logout]').click();
  await expect.poll(() => logoutFrameCount(page)).toBe(1);
  await expect(page.locator('.home-connect-card')).toBeVisible();
  await expect(page.locator('.home-status')).toHaveText('Unavailable');
  await expect(page.locator('.home-viewers')).toContainText('0');
  await expect(page.locator('.home-expiry')).toHaveText('');
  await expect(page.locator('.home-row-connect')).toHaveCount(0);
  await expect(page.locator('.home-row-menu')).toHaveCount(0);
  await page.locator('.home-row-forget').click();
  await expect(page.locator('.home-recent-row')).toHaveCount(0);
  await expect(page.locator('[data-home-toast]')).toHaveText('Share forgotten');
});

test('operator session shares send attach input without a controls toggle', async ({ page }) => {
  await page.addInitScript(() => {
    window.__rmuxShareReadyScope = 'session';
    window.__rmuxShareReadyControls = true;
  });
  await page.goto(`/#t=${operatorToken}`);

  await expect(page.locator('[data-share-controls]')).toHaveCount(0);
  await expect(page.locator('[data-share-controls-passthrough]')).toHaveCount(0);
  await page.locator('.xterm').click();
  await page.keyboard.type('x');
  await expect.poll(() => sentFrames(page)).toContainEqual([0x83, 120]);
});

test('mouse wheel scroll stays local and does not send shell input', async ({ page }) => {
  await page.addInitScript(() => {
    window.__rmuxShareReadyScope = 'session';
    window.__rmuxShareReadyControls = true;
  });
  await page.goto(`/#t=${operatorToken}`);
  await page.locator('.xterm').hover();

  const before = await sentFrames(page);
  await page.mouse.wheel(0, 600);
  await expect.poll(() => sentFrames(page)).toEqual(before);
});

test('session pane scrollbar requests pane scroll without shell input', async ({ page }) => {
  await page.addInitScript(() => {
    window.__rmuxShareReadyScope = 'session';
    window.__rmuxShareReadyRole = 'spectator';
    window.__rmuxShareReadySize = { cols: 80, rows: 24 };
    window.__rmuxShareInitialSnapshot =
      '\x1b[0m\x1b[?25l\x1b[3J\x1b[2J\x1b[Hscrollable pane'
      + '\x1b[24;1H[ci] 0:bash* "host" 16:34 27-May-26';
    window.__rmuxShareSessionView = {
      size: { cols: 80, rows: 24 },
      panes: [{
        id: 7,
        x: 0,
        y: 0,
        cols: 80,
        rows: 23,
        history_size: 120,
        scroll_offset: 0,
        alternate_on: false,
      }],
    };
  });
  await page.goto(`/#t=${spectatorToken}`);
  await expect(page.locator('[data-share-status]')).toHaveText('Connected');
  await expect(page.locator('.share-pane-scrollbar')).toHaveCount(1);

  const screen = await page.locator('.xterm-screen').boundingBox();
  expect(screen).not.toBeNull();
  await page.mouse.move(screen!.x + 48, screen!.y + 64);
  await page.mouse.wheel(0, -240);

  await expect.poll(async () => (await paneScrollFrames(page)).length).toBeGreaterThan(0);
  const scroll = (await paneScrollFrames(page)).at(-1);
  expect(scroll).toMatchObject({ type: 'pane_scroll', pane_id: 7 });
  expect(scroll!.delta).toBeLessThan(0);
  expect(await sentInputFrameCount(page)).toBe(0);
});

test('session pane scrollbar drag survives redraws and scrolls both ways', async ({ page }) => {
  await page.addInitScript(() => {
    window.__rmuxShareReadyScope = 'session';
    window.__rmuxShareReadyRole = 'spectator';
    window.__rmuxShareReadySize = { cols: 80, rows: 24 };
    window.__rmuxShareInitialSnapshot =
      '\x1b[0m\x1b[?25l\x1b[3J\x1b[2J\x1b[Hdrag-scrollable pane'
      + '\x1b[24;1H[ci] 0:bash* "host" 16:34 27-May-26';
    window.__rmuxShareSessionView = {
      size: { cols: 80, rows: 24 },
      panes: [{
        id: 7,
        x: 0,
        y: 0,
        cols: 80,
        rows: 23,
        active: true,
        history_size: 120,
        scroll_offset: 0,
        alternate_on: false,
      }],
    };
  });
  await page.goto(`/#t=${spectatorToken}`);
  await expect(page.locator('[data-share-status]')).toHaveText('Connected');

  const scrollbar = page.locator('.share-pane-scrollbar');
  await expect(scrollbar).toHaveCount(1);
  await expect(scrollbar).toBeVisible();
  let box: { height: number; width: number; x: number; y: number } | null = null;
  await expect.poll(async () => {
    box = await scrollbar.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0
        ? { height: rect.height, width: rect.width, x: rect.left, y: rect.top }
        : null;
    });
    return box !== null;
  }).toBe(true);

  const x = box!.x + box!.width / 2;
  await page.mouse.move(x, box!.y + box!.height - 2);
  await page.mouse.down();

  await dispatchSessionView(page, {
    size: { cols: 80, rows: 24 },
    panes: [{
      id: 7,
      x: 0,
      y: 0,
      cols: 80,
      rows: 23,
      active: true,
      history_size: 120,
      scroll_offset: 0,
      alternate_on: false,
    }],
  });

  const beforeUpDrag = (await paneScrollFrames(page)).length;
  await page.mouse.move(x, box!.y + box!.height * 0.2, { steps: 4 });
  await expect.poll(async () => (await paneScrollFrames(page)).length).toBeGreaterThan(beforeUpDrag);
  const upScroll = (await paneScrollFrames(page)).at(-1);
  expect(upScroll).toMatchObject({ type: 'pane_scroll', pane_id: 7 });
  expect(upScroll!.delta).toBeLessThan(0);

  const beforeDownDrag = (await paneScrollFrames(page)).length;
  await page.mouse.move(x, box!.y + box!.height - 2, { steps: 4 });
  await expect.poll(async () => (await paneScrollFrames(page)).length).toBeGreaterThan(beforeDownDrag);
  const downScroll = (await paneScrollFrames(page)).at(-1);
  expect(downScroll).toMatchObject({ type: 'pane_scroll', pane_id: 7 });
  expect(downScroll!.delta).toBeGreaterThan(0);

  await page.mouse.up();
  expect(await sentInputFrameCount(page)).toBe(0);
});

test('session history scroll stays pinned across live refreshes until the user returns to bottom', async ({ page }) => {
  await page.addInitScript(() => {
    window.__rmuxShareReadyScope = 'session';
    window.__rmuxShareReadyRole = 'operator';
    window.__rmuxShareReadyControls = true;
    window.__rmuxShareReadySize = { cols: 80, rows: 24 };
    window.__rmuxShareInitialSnapshot =
      '\x1b[0m\x1b[?1004h\x1b[?25l\x1b[3J\x1b[2J\x1b[Hlive bottom frame'
      + '\x1b[24;1H[ci] 0:bash* "host" 16:34 27-May-26';
    window.__rmuxShareSessionView = {
      size: { cols: 80, rows: 24 },
      panes: [{
        id: 7,
        x: 0,
        y: 0,
        cols: 80,
        rows: 23,
        active: true,
        history_size: 120,
        scroll_offset: 0,
        alternate_on: false,
      }],
    };
  });
  await page.goto(`/#t=${operatorToken}`);
  await expect(page.locator('[data-share-status]')).toHaveText('Connected');
  await expect(page.locator('.xterm')).toContainText('live bottom frame');

  const screen = await page.locator('.xterm-screen').boundingBox();
  expect(screen).not.toBeNull();
  await page.mouse.move(screen!.x + 48, screen!.y + 64);
  await page.mouse.wheel(0, -240);
  await expect.poll(async () => (await paneScrollFrames(page)).at(-1)).toMatchObject({
    type: 'pane_scroll',
    pane_id: 7,
    delta: expect.any(Number),
  });

  await dispatchSessionSnapshot(
    page,
    '\x1b[0m\x1b[?25l\x1b[3J\x1b[2J\x1b[Hhistory frame at offset 40'
      + '\x1b[24;1H[ci] 0:bash* "host" 16:34 27-May-26',
  );
  await dispatchSessionSnapshot(
    page,
    '\x1b[0m\x1b[?25l\x1b[3J\x1b[2J\x1b[Hlive snapshot racing before history view'
      + '\x1b[24;1H[ci] 0:bash* "host" 16:34 27-May-26',
  );
  await dispatchSessionView(page, {
    size: { cols: 80, rows: 24 },
    panes: [{
      id: 7,
      x: 0,
      y: 0,
      cols: 80,
      rows: 23,
      active: true,
      history_size: 120,
      scroll_offset: 40,
      alternate_on: false,
    }],
  });
  await expect(page.locator('.xterm')).toContainText('history frame at offset 40');
  await expect(page.locator('.xterm')).not.toContainText('live snapshot racing before history view');

  await page.locator('.xterm-helper-textarea').evaluate((element) => {
    (element as HTMLElement).blur();
    (element as HTMLElement).focus();
  });
  await expect.poll(() => sentInputPayloads(page)).toContain('\x1b[I');

  await dispatchSessionSnapshot(
    page,
    '\x1b[0m\x1b[?25l\x1b[3J\x1b[2J\x1b[Hlive refresh that should stay hidden'
      + '\x1b[24;1H[ci] 0:bash* "host" 16:34 27-May-26',
  );
  await dispatchSessionView(page, {
    size: { cols: 80, rows: 24 },
    panes: [{
      id: 7,
      x: 0,
      y: 0,
      cols: 80,
      rows: 23,
      active: true,
      history_size: 120,
      scroll_offset: 0,
      alternate_on: false,
    }],
  });
  await expect(page.locator('.xterm')).toContainText('history frame at offset 40');
  await expect(page.locator('.xterm')).not.toContainText('live refresh that should stay hidden');

  const framesBeforeSecondScroll = (await paneScrollFrames(page)).length;
  await page.mouse.wheel(0, -240);
  await expect.poll(async () => (await paneScrollFrames(page)).length).toBeGreaterThan(framesBeforeSecondScroll);
  const secondScroll = (await paneScrollFrames(page)).at(-1);
  expect(secondScroll).toMatchObject({ type: 'pane_scroll', pane_id: 7 });
  expect(secondScroll!.delta).toBeLessThan(-40);
  const secondOffset = Math.abs(secondScroll!.delta);

  await dispatchSessionSnapshot(
    page,
    '\x1b[0m\x1b[?25l\x1b[3J\x1b[2J\x1b[Hstale shallower history while scrolling up'
      + '\x1b[24;1H[ci] 0:bash* "host" 16:34 27-May-26',
  );
  await dispatchSessionView(page, {
    size: { cols: 80, rows: 24 },
    panes: [{
      id: 7,
      x: 0,
      y: 0,
      cols: 80,
      rows: 23,
      active: true,
      history_size: 120,
      scroll_offset: Math.max(1, secondOffset - 10),
      alternate_on: false,
    }],
  });
  await expect(page.locator('.xterm')).toContainText('history frame at offset 40');
  await expect(page.locator('.xterm')).not.toContainText('stale shallower history while scrolling up');

  await dispatchSessionSnapshot(
    page,
    '\x1b[0m\x1b[?25l\x1b[3J\x1b[2J\x1b[Hdeeper history after repeated scroll'
      + '\x1b[24;1H[ci] 0:bash* "host" 16:34 27-May-26',
  );
  await dispatchSessionView(page, {
    size: { cols: 80, rows: 24 },
    panes: [{
      id: 7,
      x: 0,
      y: 0,
      cols: 80,
      rows: 23,
      active: true,
      history_size: 120,
      scroll_offset: secondOffset,
      alternate_on: false,
    }],
  });
  await expect(page.locator('.xterm')).toContainText('deeper history after repeated scroll');

  const framesBeforeQuietDown = (await paneScrollFrames(page)).length;
  await page.mouse.wheel(0, 120);
  await expect.poll(async () => (await paneScrollFrames(page)).length).toBeGreaterThan(framesBeforeQuietDown);
  const quietDownScroll = (await paneScrollFrames(page)).at(-1);
  expect(quietDownScroll).toMatchObject({ type: 'pane_scroll', pane_id: 7 });
  expect(quietDownScroll!.delta).toBeGreaterThan(0);
  const lowerOffset = Math.max(1, secondOffset - quietDownScroll!.delta);

  await dispatchSessionSnapshot(
    page,
    '\x1b[0m\x1b[?25l\x1b[3J\x1b[2J\x1b[Hstale deeper history while scrolling down'
      + '\x1b[24;1H[ci] 0:bash* "host" 16:34 27-May-26',
  );
  await dispatchSessionView(page, {
    size: { cols: 80, rows: 24 },
    panes: [{
      id: 7,
      x: 0,
      y: 0,
      cols: 80,
      rows: 23,
      active: true,
      history_size: 120,
      scroll_offset: secondOffset,
      alternate_on: false,
    }],
  });
  await expect(page.locator('.xterm')).toContainText('deeper history after repeated scroll');
  await expect(page.locator('.xterm')).not.toContainText('stale deeper history while scrolling down');

  await dispatchSessionSnapshot(
    page,
    '\x1b[0m\x1b[?25l\x1b[3J\x1b[2J\x1b[Hlower history after quiet downward scroll'
      + '\x1b[24;1H[ci] 0:bash* "host" 16:34 27-May-26',
  );
  await dispatchSessionView(page, {
    size: { cols: 80, rows: 24 },
    panes: [{
      id: 7,
      x: 0,
      y: 0,
      cols: 80,
      rows: 23,
      active: true,
      history_size: 120,
      scroll_offset: lowerOffset,
      alternate_on: false,
    }],
  });
  await expect(page.locator('.xterm')).toContainText('lower history after quiet downward scroll');

  await dispatchSessionSnapshot(
    page,
    '\x1b[0m\x1b[?25l\x1b[3J\x1b[2J\x1b[Hsecond live refresh that should stay hidden'
      + '\x1b[24;1H[ci] 0:bash* "host" 16:34 27-May-26',
  );
  await dispatchSessionView(page, {
    size: { cols: 80, rows: 24 },
    panes: [{
      id: 7,
      x: 0,
      y: 0,
      cols: 80,
      rows: 23,
      active: true,
      history_size: 120,
      scroll_offset: 0,
      alternate_on: false,
    }],
  });
  await expect(page.locator('.xterm')).toContainText('lower history after quiet downward scroll');
  await expect(page.locator('.xterm')).not.toContainText('second live refresh that should stay hidden');

  const framesBeforeSuppressedDown = (await paneScrollFrames(page)).length;
  await page.mouse.wheel(0, 120);
  await expect.poll(async () => (await paneScrollFrames(page)).length).toBeGreaterThan(framesBeforeSuppressedDown);
  const downAfterSuppressedReset = (await paneScrollFrames(page)).at(-1);
  expect(downAfterSuppressedReset).toMatchObject({ type: 'pane_scroll', pane_id: 7 });
  expect(downAfterSuppressedReset!.delta).toBeLessThan(0);
  const offsetAfterSuppressedDown = Math.max(1, Math.abs(downAfterSuppressedReset!.delta));
  expect(offsetAfterSuppressedDown).toBeLessThan(lowerOffset);

  await dispatchSessionSnapshot(
    page,
    '\x1b[0m\x1b[?25l\x1b[3J\x1b[2J\x1b[Hlower history after suppressed downward scroll'
      + '\x1b[24;1H[ci] 0:bash* "host" 16:34 27-May-26',
  );
  await dispatchSessionView(page, {
    size: { cols: 80, rows: 24 },
    panes: [{
      id: 7,
      x: 0,
      y: 0,
      cols: 80,
      rows: 23,
      active: true,
      history_size: 120,
      scroll_offset: offsetAfterSuppressedDown,
      alternate_on: false,
    }],
  });
  await expect(page.locator('.xterm')).toContainText('lower history after suppressed downward scroll');

  await dispatchSessionSnapshot(
    page,
    '\x1b[0m\x1b[?25l\x1b[3J\x1b[2J\x1b[Hlate live snapshot after suppressed reset'
      + '\x1b[24;1H[ci] 0:bash* "host" 16:34 27-May-26',
  );
  await expect(page.locator('.xterm')).toContainText('lower history after suppressed downward scroll');
  await expect(page.locator('.xterm')).not.toContainText('late live snapshot after suppressed reset');

  await page.mouse.wheel(0, -120);
  await dispatchSessionView(page, {
    size: { cols: 80, rows: 24 },
    panes: [{
      id: 7,
      x: 0,
      y: 0,
      cols: 80,
      rows: 23,
      active: true,
      history_size: 120,
      scroll_offset: Math.min(120, offsetAfterSuppressedDown + 10),
      alternate_on: false,
    }],
  });
  await expect(page.locator('.xterm')).toContainText('lower history after suppressed downward scroll');
  await expect(page.locator('.xterm')).not.toContainText('late live snapshot after suppressed reset');

  await page.mouse.wheel(0, 4000);
  await dispatchSessionSnapshot(
    page,
    '\x1b[0m\x1b[?25l\x1b[3J\x1b[2J\x1b[Hlive bottom after explicit return'
      + '\x1b[24;1H[ci] 0:bash* "host" 16:34 27-May-26',
  );
  await dispatchSessionView(page, {
    size: { cols: 80, rows: 24 },
    panes: [{
      id: 7,
      x: 0,
      y: 0,
      cols: 80,
      rows: 23,
      active: true,
      history_size: 120,
      scroll_offset: 0,
      alternate_on: false,
    }],
  });
  await expect(page.locator('.xterm')).toContainText('live bottom after explicit return');
});

test('toolbar remains visible by default across reloads', async ({ page }) => {
  const url = `/#t=${spectatorToken}`;
  await page.goto(url);
  await expect(page.locator('[data-share-status]')).toHaveText('Connected');
  await page.reload();
  await expect(page.locator('.share-app')).toHaveAttribute('data-chrome', 'visible');
});

test('URL options can remove chrome and disclaimer', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.includes('mobile'), 'mobile keeps the toolbar available for navigation.');

  const url = `/#t=${spectatorToken}&navbar=off&disclaimer=off&theme=dark`;
  await page.goto(url);

  await expect(page.locator('.share-app')).toHaveAttribute('data-navbar', 'off');
  await expect(page.locator('.share-app')).toHaveAttribute('data-chrome', 'hidden');
  await expect(page.locator('.share-app')).toHaveAttribute('data-terminal-theme', 'dark');
  await expect(page.locator('[data-share-terminal-theme]')).toHaveValue('dark');
  await expect(page.locator('[data-share-toast]')).toHaveCount(0);
  await expect(page.locator('[data-share-status]')).toHaveText('Connected');
  const screen = await page.locator('.xterm-screen').boundingBox();
  expect(screen).not.toBeNull();
  await page.mouse.click(screen!.x + 32, screen!.y + 32, { button: 'right' });
  await expect(page.locator('[data-share-terminal-show-toolbar]')).toBeVisible();
  await expect(page.locator('[data-share-terminal-toolbar-label]')).toHaveText('Show toolbar');
  await page.locator('[data-share-terminal-show-toolbar]').click();
  await expect(page.locator('.share-app')).toHaveAttribute('data-navbar', 'visible');
  await expect(page.locator('.share-app')).toHaveAttribute('data-chrome', 'visible');
});

test('pin-protected shares ask for the out-of-band pairing code after auth challenge', async ({ page }) => {
  await page.addInitScript(() => {
    window.__rmuxShareRequirePin = true;
  });
  await page.goto(`/#t=${spectatorToken}`);

  await expect(page.locator('[data-share-pin]')).toBeVisible();
  await expect(page.locator('[data-share-pin]')).toBeFocused();
  await expect(page.locator('[data-share-confirm-title]')).toHaveText('Pairing code required');
  await expect(page.locator('[data-share-confirm-logo]')).toHaveAttribute('src', /\/crabs\/orange-light\.svg$/);
  await page.locator('[data-share-confirm]').evaluate((dialog) => (dialog as HTMLDialogElement).close());
  await expect(page.locator('.share-placeholder-action')).toHaveText('Pairing code required');
  await page.locator('.share-placeholder-action').click();
  await expect(page.locator('[data-share-pin]')).toBeVisible();
  await expect(page.locator('[data-share-pin-warning]')).toHaveCount(0);
  await expect(page.locator('[data-share-confirm-connect]')).toBeHidden();
  await expect(page.locator('[data-share-confirm-cancel]')).toBeHidden();

  await page.locator('[data-share-pin]').fill('1');
  await expect(page.locator('[data-share-pin-boxes] i').first()).toHaveText('1');
  await expect(page.locator('[data-share-pin-boxes] i').first()).toHaveText('*', { timeout: 700 });

  await page.locator('[data-share-pin]').fill('123456');

  await expect.poll(() => sentFrames(page)).toContainEqual(
    JSON.stringify({
      type: 'auth',
      protocol_version: 1,
      capabilities: ['e2ee-token-auth', 'terminal-palette-v1'],
      pin: '123456',
    }),
  );
  await expect(page.locator('[data-share-status]')).toHaveText('Connected');

  await page.locator('[data-share-session-menu]').click();
  await page.locator('.home-menu-button').click();
  await page.locator('.home-menu-popover button', { hasText: 'Show PIN' }).click();
  await expect(page.locator('[data-home-pin-dialog]')).toBeVisible();
  await expect(page.locator('.home-menu-popover')).toBeHidden();
  await expect(page.locator('[data-home-pin-logo]')).toHaveAttribute('src', /\/crabs\/orange-light\.svg$/);
});

test('pin prompt escape returns to the recent links dashboard', async ({ page }) => {
  await page.addInitScript(() => {
    window.__rmuxShareRequirePin = true;
  });
  await page.goto(`/#t=${spectatorToken}`);

  await expect(page.locator('[data-share-pin]')).toBeVisible();
  await page.keyboard.press('Escape');

  await expect(page.locator('.home-connect-card')).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.sessionStorage.getItem('rmux.share.activeParams.v1')))
    .toBeNull();
});

test('pin-protected minimal links stay readable in a light user theme', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.addInitScript(() => {
    window.__rmuxShareRequirePin = true;
  });
  const url = `/#t=${spectatorToken}&navbar=off&disclaimer=off`;
  await page.goto(url);

  await expect(page.locator('[data-share-confirm]')).toBeVisible();
  await expect(page.locator('[data-share-confirm-title]')).toHaveText('Pairing code required');
  await expect(page.locator('.share-app')).toHaveAttribute('data-terminal-mode', 'light');
  await expect(page.locator('.share-confirm')).toHaveCSS('background-color', 'rgb(255, 250, 240)');
  await expect(page.locator('.share-confirm h1')).toHaveCSS('color', 'rgb(16, 33, 26)');
  await expect(page.locator('[data-share-pin]')).toBeVisible();
  // The input text is intentionally transparent; the digit boxes carry the colour.
  await expect(page.locator('[data-share-pin-boxes] i').first()).toHaveCSS('color', 'rgb(16, 33, 26)');

  await page.locator('[data-share-pin]').fill('123456');

  await expect(page.locator('[data-share-status]')).toHaveText('Connected');
  await expect(page.locator('[data-share-toast]')).toHaveCount(0);
  await expect(page.locator('.xterm')).toBeVisible();
  await expect(page.locator('.xterm')).toContainText('hello from rmux');
});

test('host terminal theme applies the palette from the ready message', async ({ page }) => {
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

  await page.goto(`/#t=${spectatorToken}`);

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

  await page.goto(`/#t=${spectatorToken}`);

  await expect(page.locator('.share-app')).toHaveAttribute('data-terminal-theme', 'user');
  await expect(page.locator('.share-app')).toHaveAttribute('data-terminal-mode', 'light');
  await expect(page.locator('.share-app')).toHaveAttribute('data-client-palette', 'present');
  await expect.poll(() => customProperty(page, '--share-client-bg')).toBe('#fdf6e3');
  await expect.poll(() => customProperty(page, '--share-client-fg')).toBe('#002b36');
});

test('invalid terminal theme in the URL is rejected', async ({ page }) => {
  await page.goto(`/#t=${spectatorToken}&theme=solarized`);

  await expect(page.locator('[data-share-status]')).toHaveText('Disconnected');
  await expect(page.locator('[data-share-terminal]')).toContainText('invalid terminal theme');
  await expect.poll(() => socketCount(page)).toBe(0);
});

test('WebCrypto X25519 rejects an all-zero/low-order server public key (RFC 7748 §6.1)', async ({ page }) => {
  // The browser-side handshake (e2ee.ts createEncryptedTransport) relies on
  // WebCrypto's mandated Secure-Curves step-6 rejection: a degenerate/low-order
  // server public key yields the all-zero shared secret and must fail closed
  // before the WASM session is built. Lock that in so a browser regression
  // cannot silently weaken the handshake. (Known-vector interop is asserted on
  // the Rust side; WebCrypto cannot import a raw private scalar.)
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const ephemeral = () =>
      crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits']) as Promise<CryptoKeyPair>;
    const self = await ephemeral();

    // u = 0 -> X25519 produces the all-zero shared secret -> must be rejected.
    const zeroPeer = await crypto.subtle.importKey('raw', new Uint8Array(32), { name: 'X25519' }, false, []);
    let allZeroRejected = false;
    try {
      await crypto.subtle.deriveBits({ name: 'X25519', public: zeroPeer }, self.privateKey, 256);
    } catch {
      allZeroRejected = true;
    }

    // A fresh ephemeral peer key must still derive a 32-byte secret (control).
    const peer = await ephemeral();
    let validBytes = -1;
    try {
      validBytes = (
        await crypto.subtle.deriveBits({ name: 'X25519', public: peer.publicKey }, self.privateKey, 256)
      ).byteLength;
    } catch {
      validBytes = -1;
    }
    return { allZeroRejected, validBytes };
  });

  expect(result.allZeroRejected).toBe(true);
  expect(result.validBytes).toBe(32);
});

async function dispatchSessionView(page: import('@playwright/test').Page, view: unknown): Promise<void> {
  await page.evaluate(async (sessionView) => {
    const bytes = new TextEncoder().encode(JSON.stringify(sessionView));
    await window.__rmuxShareSockets?.at(-1)?.serverBinary([0x11, ...Array.from(bytes)]);
  }, view);
}

async function dispatchSessionSnapshot(page: import('@playwright/test').Page, snapshot: string): Promise<void> {
  await page.evaluate(async (text) => {
    const bytes = new TextEncoder().encode(text);
    await window.__rmuxShareSockets?.at(-1)?.serverBinary([0x10, ...Array.from(bytes)]);
  }, snapshot);
}

async function sentFrames(page: import('@playwright/test').Page) {
  return page.evaluate(() => window.__rmuxShareSockets?.flatMap((socket) => socket.sent) ?? []);
}

async function jsonFrames(page: import('@playwright/test').Page): Promise<Array<Record<string, unknown>>> {
  const frames = await sentFrames(page);
  return frames.flatMap((frame) => {
    if (typeof frame !== 'string') {
      return [];
    }
    try {
      return [JSON.parse(frame) as Record<string, unknown>];
    } catch {
      return [];
    }
  });
}

async function paneScrollFrames(page: import('@playwright/test').Page): Promise<Array<{
  type: 'pane_scroll';
  pane_id: number;
  delta: number;
}>> {
  const frames = await sentFrames(page);
  return frames.flatMap((frame) => {
    if (typeof frame !== 'string') {
      return [];
    }
    try {
      const parsed = JSON.parse(frame);
      return parsed?.type === 'pane_scroll' ? [parsed] : [];
    } catch {
      return [];
    }
  });
}

async function selectedPaneFrames(page: import('@playwright/test').Page): Promise<Array<{
  type: 'select_pane';
  pane_id: number;
}>> {
  const frames = await sentFrames(page);
  return frames.flatMap((frame) => {
    if (typeof frame !== 'string') {
      return [];
    }
    try {
      const parsed = JSON.parse(frame);
      return parsed?.type === 'select_pane' ? [parsed] : [];
    } catch {
      return [];
    }
  });
}

async function paneResizeFrames(page: import('@playwright/test').Page): Promise<Array<{
  pane_id: number;
  direction: number;
  cells: number;
}>> {
  const frames = await sentFrames(page);
  return frames.flatMap((frame) => {
    if (!Array.isArray(frame) || frame[0] !== 0x84 || frame.length !== 8) {
      return [];
    }
    return [{
      pane_id: ((frame[1] << 24) >>> 0) | (frame[2] << 16) | (frame[3] << 8) | frame[4],
      direction: frame[5],
      cells: (frame[6] << 8) | frame[7],
    }];
  });
}

async function sentInputFrameCount(page: import('@playwright/test').Page): Promise<number> {
  const frames = await sentFrames(page);
  return frames.filter((frame) => Array.isArray(frame) && (frame[0] === 0x80 || frame[0] === 0x83)).length;
}

async function sentInputPayloads(page: import('@playwright/test').Page): Promise<string[]> {
  const frames = await sentFrames(page);
  return frames.flatMap((frame) => {
    if (!Array.isArray(frame) || (frame[0] !== 0x80 && frame[0] !== 0x83)) {
      return [];
    }
    return [new TextDecoder().decode(new Uint8Array(frame.slice(1)))];
  });
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

function isResizeFrame(frame: unknown): frame is number[] {
  return Array.isArray(frame) && frame[0] === 0x82 && frame.length === 5;
}

function decodeResizeFrame(frame: number[]): { cols: number; rows: number } {
  return {
    cols: (frame[1] << 8) | frame[2],
    rows: (frame[3] << 8) | frame[4],
  };
}

async function terminalProjection(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const terminal = document.querySelector<HTMLElement>('[data-share-terminal]');
    const stage = document.querySelector<HTMLElement>('.share-terminal-stage');
    const topbar = document.querySelector<HTMLElement>('.share-topbar');
    const rows = Array.from(document.querySelectorAll<HTMLElement>('.xterm-rows > div'))
      .map((row) => row.textContent ?? '');
    if (!terminal || !stage) {
      return {
        fitsViewport: false,
        noTransform: false,
        noScrollbars: false,
        promptAtTop: false,
        rowCount: 0,
        scaledDown: false,
        singleStatusRow: false,
        statusAtBottom: false,
        statusGreen: false,
        statusInsideVisualViewport: false,
        topbarInsideVisualViewport: false,
        terminalInsideVisualViewport: false,
      };
    }
    const transform = getComputedStyle(stage).transform;
    const terminalStyle = getComputedStyle(terminal);
    const terminalRect = terminal.getBoundingClientRect();
    const screenRect = document.querySelector<HTMLElement>('.xterm-screen')?.getBoundingClientRect();
    const statusRows = rows.filter((row) => row.includes('[ci] 0:bash*'));
    const statusRow = Array.from(document.querySelectorAll<HTMLElement>('.xterm-rows > div'))
      .find((row) => (row.textContent ?? '').includes('[ci] 0:bash*'));
    const visualViewportBottom = window.visualViewport
      ? window.visualViewport.offsetTop + window.visualViewport.height
      : window.innerHeight;
    const visualViewportTop = window.visualViewport ? window.visualViewport.offsetTop : 0;
    const statusRect = statusRow?.getBoundingClientRect();
    const topbarRect = topbar?.getBoundingClientRect();
    return {
      fitsViewport: screenRect
        ? screenRect.left >= terminalRect.left - 2
          && screenRect.top >= terminalRect.top - 2
          && screenRect.right <= terminalRect.right + 2
          && screenRect.bottom <= terminalRect.bottom + 2
        : false,
      noTransform: transform === 'none',
      noScrollbars: terminalStyle.overflowX === 'hidden' && terminalStyle.overflowY === 'hidden',
      promptAtTop: rows[0]?.includes('prompt') ?? false,
      rowCount: rows.length,
      scaledDown: transform !== 'none',
      singleStatusRow: statusRows.length === 1,
      statusAtBottom: rows.at(-1)?.includes('[ci] 0:bash*') ?? false,
      statusGreen: statusRow
        ? Array.from(statusRow.querySelectorAll<HTMLElement>('span')).some((span) => {
          const match = getComputedStyle(span).backgroundColor.match(/\d+/g)?.map(Number);
          return match ? match[1] > match[0] + 20 && match[1] > match[2] + 20 : false;
        })
        : false,
      statusInsideVisualViewport: statusRect ? statusRect.bottom <= visualViewportBottom + 2 : false,
      topbarInsideVisualViewport: topbarRect
        ? topbarRect.top >= visualViewportTop - 2 && topbarRect.bottom <= visualViewportBottom + 2
        : false,
      terminalInsideVisualViewport:
        terminalRect.top >= visualViewportTop - 2 && terminalRect.bottom <= visualViewportBottom + 2,
    };
  });
}
