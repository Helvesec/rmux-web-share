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
  await expect(page.locator('.share-brand-context')).toHaveText('Web Multiplex');
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
      protocol_version: 3,
      capabilities: ['e2ee-token-auth', 'terminal-palette-v1'],
    }),
  );
  expect(JSON.stringify(await sentFrames(page))).not.toContain(spectatorToken);
});

test('Firefox local links do not show a Chrome permission prompt', async ({ page }) => {
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
  await expect(page.locator('[data-share-terminal]')).not.toContainText('Chrome');
  await expect(page.locator('[data-share-status]')).toHaveText('Connected');
});

test('local access success is remembered without prompting', async ({ page }) => {
  await page.goto(`/#t=${spectatorToken}`);
  await expect(page.locator('[data-share-status]')).toHaveText('Connected');
  await expect.poll(() => page.evaluate(() => window.localStorage.getItem('rmux.share.localAccessConfirmed'))).toBe('1');

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
      protocol_version: 3,
      capabilities: ['e2ee-token-auth', 'terminal-palette-v1'],
    }),
  );
});

test('server viewer-count option shows the live connected browser count', async ({ page }) => {
  await page.addInitScript(() => {
    window.__rmuxShareShowViewers = true;
  });
  await page.goto(`/#t=${spectatorToken}`);

  await expect(page.locator('[data-share-viewers]')).toBeVisible();
  await expect(page.locator('[data-share-viewers-count]')).toHaveText('3');
  await expect(page.locator('[data-share-viewers] svg')).toBeVisible();
});

test('URL cannot force the live viewer count when the server disabled it', async ({ page }) => {
  await page.goto(`/#t=${spectatorToken}&viewers=on`);

  await expect(page.locator('[data-share-status]')).toHaveText('Connected');
  await expect(page.locator('[data-share-viewers]')).toBeHidden();
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

test('session operator click selects the clicked pane without shell input', async ({ page }) => {
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
      security_statement: 'share.rmux.io serves only the static frontend and does not relay terminal data. Terminal frames are end-to-end encrypted, the token stays in the URL fragment, the source is public, builds are verifiable, deployments are traceable, and the frontend can be self-hosted.',
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
  await expect(page.locator('[data-share-provenance-statement]')).toContainText('builds are verifiable');
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
  await expect(page.locator('[data-share-session-actions] h1')).toHaveText('Disconnect');
  await expect(page.locator('[data-share-session-detach]')).toBeVisible();
  await expect(page.locator('[data-share-session-detach]')).toHaveText('Disconnect');
  await expect(page.locator('[data-share-session-release]')).toHaveCount(0);
  await expect(page.locator('[data-share-session-cancel]')).toHaveCount(0);
  await expect(page.locator('[data-share-session-provenance]')).toHaveCount(0);
  await expect(page.locator('[data-share-session-logout]')).toBeHidden();
  await page.locator('[data-share-session-close]').click();
  await expect(page.locator('[data-share-session-actions]')).toBeHidden();
});

test('terminal context menu exposes terminal actions without opening window actions', async ({ page }) => {
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

  await page.locator('[data-share-terminal-paste]').click();
  await expect.poll(() => sentFrames(page)).toContainEqual([0x80, 112, 119, 100]);

  await page.mouse.click(screen!.x + 32, screen!.y + 32, { button: 'right' });
  await page.locator('[data-share-terminal-show-toolbar]').click();
  await expect(page.locator('.share-app')).toHaveAttribute('data-chrome', 'hidden');
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
  await expect.poll(() => socketCount(page)).toBe(1);
  await expect.poll(() => new URL(page.url()).hash).toBe('');

  await page.locator('[data-share-session-menu]').click();
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
  await expect(page.locator('[data-share-status]')).toHaveText('Disconnected');
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

test('toolbar remains visible by default across reloads', async ({ page }) => {
  const url = `/#t=${spectatorToken}`;
  await page.goto(url);
  await expect(page.locator('[data-share-status]')).toHaveText('Connected');
  await page.reload();
  await expect(page.locator('.share-app')).toHaveAttribute('data-chrome', 'visible');
});

test('URL options can remove chrome and disclaimer', async ({ page }) => {
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
  await page.locator('[data-share-confirm-connect]').click();
  await expect(page.locator('[data-share-pin-error]')).toContainText('6-digit');

  await page.locator('[data-share-pin]').fill('123456');
  await page.locator('[data-share-confirm-connect]').click();

  await expect.poll(() => sentFrames(page)).toContainEqual(
    JSON.stringify({
      type: 'auth',
      protocol_version: 3,
      capabilities: ['e2ee-token-auth', 'terminal-palette-v1'],
      pin: '123456',
    }),
  );
  await expect(page.locator('[data-share-status]')).toHaveText('Connected');
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
  await expect(page.locator('[data-share-pin]')).toHaveCSS('color', 'rgb(16, 33, 26)');

  await page.locator('[data-share-pin]').fill('123456');
  await page.locator('[data-share-confirm-connect]').click();

  await expect(page.locator('[data-share-status]')).toHaveText('Connected');
  await expect(page.locator('[data-share-toast]')).toHaveCount(0);
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
      };
    }
    const transform = getComputedStyle(stage).transform;
    const terminalStyle = getComputedStyle(terminal);
    const terminalRect = terminal.getBoundingClientRect();
    const screenRect = document.querySelector<HTMLElement>('.xterm-screen')?.getBoundingClientRect();
    const statusRows = rows.filter((row) => row.includes('[ci] 0:bash*'));
    const statusRow = Array.from(document.querySelectorAll<HTMLElement>('.xterm-rows > div'))
      .find((row) => (row.textContent ?? '').includes('[ci] 0:bash*'));
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
      statusAtBottom: rows.at(-1)?.includes('[ci] 0:bash* "very-long-hostname" 16:34 27-May-26') ?? false,
      statusGreen: statusRow
        ? Array.from(statusRow.querySelectorAll<HTMLElement>('span')).some((span) => {
          const match = getComputedStyle(span).backgroundColor.match(/\d+/g)?.map(Number);
          return match ? match[1] > match[0] + 20 && match[1] > match[2] + 20 : false;
        })
        : false,
    };
  });
}
