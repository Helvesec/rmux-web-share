import { createClientHello, createEncryptedTransport, deriveSpectatorToken, parseChallenge } from './e2ee';
import { parseShareInput, shareAssetUrl, shareUrl } from './fragment';
import {
  forgetRecentShare,
  loadRecentShares,
  recentShareExpiresLabel,
  recentShareProgress,
  recentShareStatus,
  subscribeRecentShares,
  type RecentShare,
} from './home-storage';
import type { ServerMessage, ShareParams } from './types';
import { ProvenanceDialog, provenanceDialogTemplate } from './provenance';
import { shareWindowFeatures, shouldOpenShareInCurrentTab } from './window-bounds';
import { authPayload, logoutSession } from './wire';

const HOME_THEME_STORAGE_KEY = 'rmux.share.homeTheme';
const GITHUB_URL = 'https://github.com/Helvesec/rmux-web-share';

type HomeTheme = 'light' | 'dark';

export function startShareHome(root: HTMLElement): void {
  const home = new ShareHome(root);
  home.mount();
}

class ShareHome {
  private readonly root: HTMLElement;
  private selectedForget?: RecentShare;
  private selectedPin?: RecentShare;
  private installPrompt?: BeforeInstallPromptEvent;
  private unsubscribeRecentShares?: () => void;
  private provenance?: ProvenanceDialog;
  private pinRevealTimer?: number;
  private toastTimer?: number;

  constructor(root: HTMLElement) {
    this.root = root;
  }

  mount(): void {
    this.root.innerHTML = homeTemplate();
    this.provenance = new ProvenanceDialog(this.root);
    this.setTheme(readTheme());
    this.bindChrome();
    this.renderRecentLinks();
    this.unsubscribeRecentShares = subscribeRecentShares(() => this.renderRecentLinks());
    window.addEventListener('pagehide', () => this.unsubscribeRecentShares?.(), { once: true });
    window.addEventListener('storage', (event) => {
      if (event.key?.startsWith('rmux.share.')) {
        this.renderRecentLinks();
      }
    });
    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault();
      this.installPrompt = event as BeforeInstallPromptEvent;
      query<HTMLButtonElement>(this.root, '[data-home-install]').hidden = false;
    });
  }

  private bindChrome(): void {
    query<HTMLFormElement>(this.root, '[data-home-connect-form]').addEventListener('submit', (event) => {
      event.preventDefault();
      this.connectFromInput();
    });
    query<HTMLButtonElement>(this.root, '[data-home-theme]').addEventListener('click', () => {
      const next = this.root.dataset.theme === 'dark' ? 'light' : 'dark';
      writeTheme(next);
      this.setTheme(next);
      this.renderRecentLinks();
    });
    query<HTMLAnchorElement>(this.root, '[data-home-github]').href = GITHUB_URL;
    query<HTMLButtonElement>(this.root, '[data-home-install]').addEventListener('click', () => {
      void this.installPrompt?.prompt();
    });
    query<HTMLButtonElement>(this.root, '[data-home-forget-close]').addEventListener('click', () => this.closeForgetDialog());
    query<HTMLButtonElement>(this.root, '[data-home-forget-local]').addEventListener('click', () => this.forgetSelected(false));
    query<HTMLButtonElement>(this.root, '[data-home-forget-session]').addEventListener('click', () => this.forgetSelected(true));
    query<HTMLButtonElement>(this.root, '[data-home-pin-close]').addEventListener('click', () => this.closePinDialog());
    query<HTMLButtonElement>(this.root, '[data-home-pin-copy]').addEventListener('click', () => this.copySelectedPin());
    query<HTMLElement>(this.root, '[data-home-pin-code]').addEventListener('pointerdown', () => this.revealPinCode());
    this.provenance?.bind(query<HTMLElement>(this.root, '[data-home-provenance-open]'));
    document.addEventListener('pointerdown', (event) => this.closeOpenMenus(event.target as Node | null));
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        this.closeOpenMenus(null);
      }
    });
  }

  private connectFromInput(): void {
    const input = query<HTMLInputElement>(this.root, '[data-home-share-input]');
    const error = query<HTMLElement>(this.root, '[data-home-error]');
    try {
      error.textContent = '';
      openShareWindow(parseShareInput(input.value));
    } catch (reason) {
      error.textContent = reason instanceof Error ? reason.message : 'Invalid share link.';
      input.focus();
    }
  }

  private renderRecentLinks(): void {
    const shares = loadRecentShares();
    const list = query<HTMLElement>(this.root, '[data-home-recent-list]');
    const empty = query<HTMLElement>(this.root, '[data-home-empty]');
    list.replaceChildren();
    empty.hidden = shares.length > 0;
    for (const share of shares) {
      list.append(this.renderShareRow(share));
    }
  }

  private renderShareRow(share: RecentShare): HTMLElement {
    const currentStatus = recentShareStatus(share);
    const row = document.createElement('article');
    row.className = 'home-recent-row';
    row.dataset.status = currentStatus;

    const crab = document.createElement('img');
    crab.className = 'home-recent-crab';
    crab.alt = '';
    crab.src = shareAssetUrl(`crabs/${share.crab}-${this.root.dataset.theme === 'dark' ? 'dark' : 'light'}.svg`);

    const title = document.createElement('div');
    title.className = 'home-recent-title';
    const name = document.createElement('strong');
    name.textContent = share.name;
    const role = document.createElement('span');
    role.className = 'home-role-pill';
    role.textContent = share.role === 'operator' ? 'Operator' : 'Spectator';
    title.append(name, role);
    if (share.pin) {
      const pin = document.createElement('span');
      pin.className = 'home-pin-pill';
      pin.title = 'PIN protected';
      pin.setAttribute('aria-label', 'PIN protected');
      pin.innerHTML = lockIcon();
      title.append(pin);
    }

    const endpoint = document.createElement('span');
    endpoint.className = 'home-recent-endpoint';
    endpoint.textContent = share.endpointLabel;

    const status = document.createElement('span');
    status.className = 'home-status';
    status.textContent = statusLabel(currentStatus);

    const viewers = document.createElement('span');
    viewers.className = 'home-viewers';
    const viewerCount = currentStatus === 'unavailable' ? 0 : share.viewers;
    viewers.title = viewerCount === undefined
      ? 'Connected browser count unavailable'
      : `${viewerCount} connected browser${viewerCount === 1 ? '' : 's'}`;
    viewers.setAttribute('aria-label', viewers.title);
    viewers.innerHTML = eyeIcon();
    viewers.append(document.createTextNode(viewerCount === undefined ? '—' : String(viewerCount)));

    const expires = document.createElement('div');
    expires.className = 'home-expiry';
    if (currentStatus !== 'unavailable') {
      const expiryLabel = document.createElement('span');
      expiryLabel.textContent = recentShareExpiresLabel(share);
      const progress = document.createElement('i');
      const progressValue = recentShareProgress(share);
      if (progressValue !== undefined) {
        progress.style.setProperty('--progress', `${progressValue}%`);
      }
      expires.append(expiryLabel, progress);
    } else {
      expires.setAttribute('aria-label', 'Unavailable share');
    }

    const connect = document.createElement('button');
    connect.className = 'home-row-connect';
    connect.type = 'button';
    connect.textContent = 'Connect';
    connect.append(iconArrowRight());
    connect.addEventListener('click', () => openShareWindow(share.params, { pairing: Boolean(share.pin) }));

    const unavailable = currentStatus === 'unavailable';
    const action = unavailable ? this.renderForgetButton(share) : connect;
    const menu = unavailable ? this.renderActionPlaceholder() : this.renderShareMenu(share);
    row.append(crab, wrap(title, endpoint), status, viewers, expires, action, menu);
    return row;
  }

  private renderForgetButton(share: RecentShare): HTMLButtonElement {
    const button = document.createElement('button');
    button.className = 'home-row-forget';
    button.type = 'button';
    button.innerHTML = `${trashIcon()}<span>Forget</span>`;
    button.addEventListener('click', () => {
      forgetRecentShare(share.id);
      this.renderRecentLinks();
      this.showToast('Share forgotten');
    });
    return button;
  }

  private renderActionPlaceholder(): HTMLElement {
    const placeholder = document.createElement('span');
    placeholder.className = 'home-row-menu-placeholder';
    return placeholder;
  }

  private renderShareMenu(share: RecentShare): HTMLElement {
    const container = document.createElement('div');
    container.className = 'home-row-menu';
    const button = document.createElement('button');
    button.className = 'home-menu-button';
    button.type = 'button';
    button.setAttribute('aria-label', 'Share actions');
    button.innerHTML = dotsIcon();
    const menu = document.createElement('div');
    menu.className = 'home-menu-popover';
    menu.hidden = true;

    if (share.pin) {
      menu.append(menuButton('Show PIN', lockIcon(), () => this.openPinDialog(share)));
      menu.append(separator());
    }
    if (share.role === 'operator' && share.operatorAccess) {
      menu.append(menuButton('Share Operator', downloadIcon(), () => this.copyShareUrl(share.url, button)));
    }
    if (share.spectatorAccess) {
      menu.append(menuButton('Share Spectator', linkIcon(), () => this.copySpectatorUrl(share, button)));
    }
    menu.append(separator(), menuButton('Forget', trashIcon(), () => this.forgetFromMenu(share), true));
    menu.addEventListener('click', (event) => {
      if ((event.target as Element | null)?.closest('button')) {
        menu.hidden = true;
      }
    });
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const opening = menu.hidden;
      this.closeOpenMenus(menu);
      menu.hidden = !opening;
      if (opening) {
        this.placeShareMenu(menu, button);
      }
    });
    container.append(button, menu);
    return container;
  }

  private placeShareMenu(menu: HTMLElement, button: HTMLButtonElement): void {
    menu.dataset.placement = 'bottom';
    menu.style.maxHeight = '';
    const gap = 8;
    const buttonRect = button.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const roomBelow = window.innerHeight - buttonRect.bottom - gap;
    const roomAbove = buttonRect.top - gap;
    const placement = menuRect.height > roomBelow && roomAbove > roomBelow ? 'top' : 'bottom';
    const available = Math.max(132, (placement === 'top' ? roomAbove : roomBelow) - gap);
    menu.dataset.placement = placement;
    menu.style.maxHeight = `${Math.floor(available)}px`;
  }

  private setTheme(theme: HomeTheme): void {
    this.root.dataset.theme = theme;
    document.documentElement.dataset.homeTheme = theme;
  }

  private async copySpectatorUrl(share: RecentShare, button: HTMLButtonElement): Promise<void> {
    if (share.role === 'spectator') {
      await this.copyShareUrl(share.url, button);
      return;
    }
    try {
      const spectatorToken = await deriveSpectatorToken(share.params.token);
      await this.copyShareUrl(shareUrl({ ...share.params, token: spectatorToken }), button);
    } catch {
      button.title = 'Could not derive spectator link';
    }
  }

  private async copyShareUrl(url: string, button: HTMLButtonElement): Promise<void> {
    const copied = await tryCopyText(url);
    this.showToast(copied ? 'Link copied' : 'Copy failed', copied ? 'success' : 'error');
    button.title = copied ? 'Copied' : 'Copy failed';
    window.setTimeout(() => {
      button.title = 'Share actions';
    }, 1200);
  }

  private openForgetDialog(share: RecentShare): void {
    this.selectedForget = share;
    const sessionButton = query<HTMLButtonElement>(this.root, '[data-home-forget-session]');
    sessionButton.hidden = !(share.role === 'operator' && share.scope === 'session');
    sessionButton.disabled = sessionButton.hidden;
    query<HTMLElement>(this.root, '[data-home-forget-name]').textContent = share.name;
    query<HTMLDialogElement>(this.root, '[data-home-forget-dialog]').showModal();
  }

  private forgetFromMenu(share: RecentShare): void {
    if (share.role === 'spectator') {
      forgetRecentShare(share.id);
      this.renderRecentLinks();
      this.showToast('Share forgotten');
      return;
    }
    this.openForgetDialog(share);
  }

  private openPinDialog(share: RecentShare): void {
    if (!share.pin) {
      return;
    }
    this.selectedPin = share;
    query<HTMLElement>(this.root, '[data-home-pin-name]').textContent = share.name;
    query<HTMLImageElement>(this.root, '[data-home-pin-logo]').src = shareAssetUrl(`crabs/${share.crab}-light.svg`);
    const code = query<HTMLElement>(this.root, '[data-home-pin-code]');
    code.dataset.revealed = 'false';
    code.replaceChildren(...pinCells(share.pin));
    query<HTMLDialogElement>(this.root, '[data-home-pin-dialog]').showModal();
  }

  private closePinDialog(): void {
    query<HTMLDialogElement>(this.root, '[data-home-pin-dialog]').close();
    this.selectedPin = undefined;
    window.clearTimeout(this.pinRevealTimer);
  }

  private async copySelectedPin(): Promise<void> {
    const pin = this.selectedPin?.pin;
    if (!pin) {
      return;
    }
    const copied = await tryCopyText(pin);
    this.showToast(copied ? 'PIN copied' : 'Copy failed', copied ? 'success' : 'error');
  }

  private revealPinCode(): void {
    const code = query<HTMLElement>(this.root, '[data-home-pin-code]');
    code.dataset.revealed = 'true';
    window.clearTimeout(this.pinRevealTimer);
    this.pinRevealTimer = window.setTimeout(() => {
      code.dataset.revealed = 'false';
    }, 2200);
  }

  private showToast(message: string, kind: 'success' | 'error' = 'success'): void {
    const toast = query<HTMLElement>(this.root, '[data-home-toast]');
    toast.textContent = message;
    toast.dataset.kind = kind;
    toast.hidden = false;
    window.requestAnimationFrame(() => {
      toast.dataset.visible = 'true';
    });
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      toast.dataset.visible = 'false';
      window.setTimeout(() => {
        if (toast.dataset.visible === 'false') {
          toast.hidden = true;
        }
      }, 180);
    }, 1800);
  }

  private closeForgetDialog(): void {
    query<HTMLDialogElement>(this.root, '[data-home-forget-dialog]').close();
    this.selectedForget = undefined;
  }

  private async forgetSelected(closeSession: boolean): Promise<void> {
    const share = this.selectedForget;
    if (!share) {
      return;
    }
    if (closeSession) {
      await closeRemoteSession(share).catch(() => undefined);
    }
    forgetRecentShare(share.id);
    this.closeForgetDialog();
    this.renderRecentLinks();
  }

  private closeOpenMenus(keep: Node | null): void {
    this.root.querySelectorAll<HTMLElement>('.home-menu-popover').forEach((menu) => {
      if (menu !== keep && !menu.contains(keep)) {
        menu.hidden = true;
      }
    });
  }
}

function homeTemplate(): string {
  return `
    <main class="home-shell">
      <header class="home-topbar">
        <a class="home-brand" href="https://rmux.io/" aria-label="RMUX">
          <span class="home-brand-mark" aria-hidden="true">
            <img class="home-brand-logo home-brand-logo-dark" src="${shareAssetUrl('rmux-logo-dark.svg')}" alt="" />
            <img class="home-brand-logo home-brand-logo-light" src="${shareAssetUrl('rmux-logo-light.svg')}" alt="" />
          </span>
          <strong>RMUX</strong>
        </a>
        <span class="home-divider" aria-hidden="true"></span>
        <a class="home-section" href="https://share.rmux.io/">SHARE</a>
        <nav class="home-actions" aria-label="Page actions">
          <button class="home-action" data-home-install type="button" hidden>${downloadIcon()}<span>Install app</span></button>
          <button class="home-icon-action" data-home-theme type="button" aria-label="Toggle theme">${sunIcon()}</button>
          <a class="home-icon-action" data-home-github aria-label="GitHub" rel="noreferrer">${githubIcon()}</a>
        </nav>
      </header>
      <section class="home-connect-card">
        <div class="home-connect-icon">${linkIcon()}</div>
        <div class="home-connect-content">
          <h1>Connect to a shared terminal</h1>
          <p>Paste a share link or a token to connect instantly.</p>
          <form class="home-connect-form" data-home-connect-form>
            <label class="home-input-wrap">
              ${linkIcon()}
              <input data-home-share-input type="text" autocomplete="off" spellcheck="false" placeholder="https://share.rmux.io/#t=..." />
            </label>
            <button class="home-connect-button" type="submit">Connect ${arrowRightIcon()}</button>
          </form>
          <p class="home-input-error" data-home-error aria-live="polite"></p>
          <div class="home-security-note">
            ${shieldIcon()}
            <span>Your browser connects directly to the endpoint in the share link. RMUX does not relay terminal traffic.</span>
            <button data-home-provenance-open type="button">Learn more ${externalIcon()}</button>
          </div>
        </div>
      </section>
      <section class="home-recent-card" aria-labelledby="recent-links-title">
        <header class="home-recent-header">
          <span class="home-recent-header-icon">${clockIcon()}</span>
          <h2 id="recent-links-title">Recent links</h2>
        </header>
        <div class="home-recent-list" data-home-recent-list></div>
        <p class="home-empty" data-home-empty>No recent links on this browser yet.</p>
      </section>
      <dialog class="home-forget-dialog" data-home-forget-dialog>
        <form method="dialog" class="home-dialog-panel">
          <button class="home-dialog-close" data-home-forget-close type="button" aria-label="Close">${xIcon()}</button>
          <h2>Forget share</h2>
          <p>Remove <strong data-home-forget-name></strong> from recent links on this browser.</p>
          <div class="home-dialog-actions">
            <button class="home-secondary-button" data-home-forget-local type="button">Forget</button>
            <button class="home-danger-button" data-home-forget-session type="button">Close Session and Forget</button>
          </div>
        </form>
      </dialog>
      <dialog class="home-pin-dialog" data-home-pin-dialog>
        <form method="dialog" class="home-dialog-panel home-pin-panel">
          <button class="home-dialog-close" data-home-pin-close type="button" aria-label="Close">${xIcon()}</button>
          <div class="home-pin-mark" aria-hidden="true">
            <img data-home-pin-logo src="${shareAssetUrl('rmux-logo-light.svg')}" alt="" />
          </div>
          <h2>Pairing code</h2>
          <p>Use this 6-digit code to connect to <strong data-home-pin-name></strong>.</p>
          <output class="home-pin-code" data-home-pin-code tabindex="0" title="Hold or tap to reveal PIN"></output>
          <div class="home-pin-warning">
            ${warningIcon()}
            <div>
              <strong>Security warning</strong>
              <p>Never share this pairing code with third parties. Anyone with the share link and this code can access the terminal.</p>
            </div>
          </div>
          <div class="home-dialog-actions">
            <button class="home-secondary-button" data-home-pin-copy type="button">Copy PIN</button>
          </div>
        </form>
      </dialog>
      ${provenanceDialogTemplate()}
      <div class="home-toast" data-home-toast role="status" aria-live="polite" hidden></div>
    </main>
  `;
}

function openShareWindow(params: ShareParams, options: { pairing?: boolean } = {}): void {
  const url = shareUrl(params);
  if (shouldOpenShareInCurrentTab()) {
    window.location.href = url;
    return;
  }
  const opened = window.open(
    url,
    `rmux-share-${Date.now()}`,
    shareWindowFeatures(options.pairing ? 'pairing' : 'terminal'),
  );
  if (!opened) {
    window.location.href = url;
  }
}

async function closeRemoteSession(share: RecentShare): Promise<void> {
  const { params } = share;
  const socket = new WebSocket(params.endpoint);
  socket.binaryType = 'arraybuffer';
  await waitForOpen(socket);
  const hello = await createClientHello(params);
  socket.send(hello.text);
  const challenge = parseChallenge(await readTextMessage(socket));
  const transport = await createEncryptedTransport(socket, hello.state, challenge);
  transport.sendText(authPayload(share.pin));
  const opened = await transport.open(await readBinaryMessage(socket));
  if (opened.type !== 'text') {
    throw new Error('expected ready message');
  }
  const ready = JSON.parse(opened.text) as ServerMessage;
  if (ready.type === 'ready' && ready.role === 'operator' && ready.scope === 'session') {
    logoutSession(transport);
  }
  window.setTimeout(() => socket.close(1000, 'forget'), 100);
}

function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error('connection failed')), { once: true });
  });
}

function readTextMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    socket.addEventListener('message', (event) => {
      typeof event.data === 'string' ? resolve(event.data) : reject(new Error('expected text frame'));
    }, { once: true });
    socket.addEventListener('error', () => reject(new Error('connection failed')), { once: true });
  });
}

function readBinaryMessage(socket: WebSocket): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    socket.addEventListener('message', (event) => {
      event.data instanceof ArrayBuffer ? resolve(event.data) : reject(new Error('expected binary frame'));
    }, { once: true });
    socket.addEventListener('error', () => reject(new Error('connection failed')), { once: true });
  });
}

function wrap(...children: Node[]): HTMLElement {
  const element = document.createElement('div');
  element.className = 'home-recent-main';
  element.append(...children);
  return element;
}

function menuButton(label: string, icon: string, action: () => void | Promise<void>, danger = false): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = danger ? 'danger' : '';
  button.innerHTML = `${icon}<span>${label}</span>`;
  button.addEventListener('click', () => {
    void action();
  });
  return button;
}

function separator(): HTMLElement {
  const element = document.createElement('i');
  element.className = 'home-menu-separator';
  return element;
}

function pinCells(pin: string): HTMLElement[] {
  return Array.from(pin, (digit) => {
    const cell = document.createElement('span');
    cell.dataset.digit = digit;
    return cell;
  });
}

function query<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) {
    throw new Error(`missing home element ${selector}`);
  }
  return element;
}

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.top = '-1000px';
  document.body.append(textarea);
  textarea.select();
  try {
    if (!document.execCommand('copy')) {
      throw new Error('copy command failed');
    }
  } finally {
    textarea.remove();
  }
}

async function tryCopyText(text: string): Promise<boolean> {
  try {
    await copyText(text);
    return true;
  } catch {
    return false;
  }
}

function readTheme(): HomeTheme {
  const stored = window.sessionStorage.getItem(HOME_THEME_STORAGE_KEY);
  if (stored === 'light' || stored === 'dark') {
    return stored;
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function writeTheme(theme: HomeTheme): void {
  try {
    window.sessionStorage.setItem(HOME_THEME_STORAGE_KEY, theme);
  } catch {
    // Theme persistence is cosmetic.
  }
}

function statusLabel(status: string): string {
  if (status === 'unavailable') {
    return 'Unavailable';
  }
  if (status === 'checking') {
    return 'Checking';
  }
  return status === 'disconnected' ? 'Disconnected' : 'Active';
}

function iconArrowRight(): SVGSVGElement {
  const template = document.createElement('template');
  template.innerHTML = arrowRightIcon();
  return template.content.firstElementChild as SVGSVGElement;
}

function svg(path: string): string {
  return `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none">${path}</svg>`;
}

function arrowRightIcon(): string {
  return svg('<path d="M5 12h14M13 6l6 6-6 6" />');
}

function clockIcon(): string {
  return svg('<circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />');
}

function dotsIcon(): string {
  return svg('<path d="M12 6h.01M12 12h.01M12 18h.01" />');
}

function downloadIcon(): string {
  return svg('<path d="M12 3v12M7 10l5 5 5-5M5 21h14" />');
}

function externalIcon(): string {
  return svg('<path d="M14 5h5v5M10 14 19 5M19 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h4" />');
}

function eyeIcon(): string {
  return svg('<path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" /><circle cx="12" cy="12" r="2.8" />');
}

function githubIcon(): string {
  return svg('<path d="M15 22v-3.5a3.2 3.2 0 0 0-.9-2.5c3-.3 6.1-1.5 6.1-6.5a5 5 0 0 0-1.3-3.5 4.7 4.7 0 0 0-.1-3.4s-1-.3-3.5 1.3a12 12 0 0 0-6.4 0C6.4 1.8 5.4 2.1 5.4 2.1a4.7 4.7 0 0 0-.1 3.4A5 5 0 0 0 4 9c0 5 3.1 6.1 6.1 6.5a2.8 2.8 0 0 0-.8 1.7c-.7.3-2.5.8-3.6-1a2.6 2.6 0 0 0-1.9-1.3s-1.2 0-.1.8a3.2 3.2 0 0 1 1.4 1.8s.8 2.5 4.1 1.7V22" />');
}

function linkIcon(): string {
  return svg('<path d="M10 13a5 5 0 0 0 7.1 0l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1" /><path d="M14 11a5 5 0 0 0-7.1 0l-2 2A5 5 0 0 0 12 20.1l1.1-1.1" />');
}

function lockIcon(): string {
  return svg('<rect x="5" y="10" width="14" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" />');
}

function shieldIcon(): string {
  return svg('<path d="M12 3 19 6v5c0 5-3.4 8.4-7 10-3.6-1.6-7-5-7-10V6l7-3Z" /><path d="m9 12 2 2 4-5" />');
}

function sunIcon(): string {
  return svg('<circle cx="12" cy="12" r="4" /><path d="M12 2v2.5M12 19.5V22M4.93 4.93 6.7 6.7M17.3 17.3l1.77 1.77M2 12h2.5M19.5 12H22M4.93 19.07 6.7 17.3M17.3 6.7l1.77-1.77" />');
}

function trashIcon(): string {
  return svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />');
}

function warningIcon(): string {
  return svg('<path d="M12 3 2.8 19h18.4L12 3Z" /><path d="M12 8v5M12 17h.01" />');
}

function xIcon(): string {
  return svg('<path d="M6 6l12 12M18 6 6 18" />');
}

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
}
