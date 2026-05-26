import { endpointHost, parseShareFragment, shareBasePath, shareBaseUrl, shareUrl } from './fragment';
import {
  confirmationCopy,
  connectionErrorMessage,
  rememberLocalAccess,
  type ConfirmationCopy,
} from './local-access';
import {
  DEFAULT_TERMINAL_THEME,
  terminalChromePalette,
  isTerminalThemeName,
  openShareTerminal,
  terminalThemeMode,
  type ShareTerminal,
  type TerminalThemeName,
} from './terminal';
import type {
  ReadyMessage,
  ServerMessage,
  ShareParams,
  ShareRole,
  ShareScope,
  ShareStatus,
  ViewerCountMessage,
} from './types';
import type { TerminalThemePalette } from './types';
import { privacyToastContent, shareViewTemplate, titleCase } from './view-content';
import {
  authPayload,
  closeMessage,
  logoutSession,
  sendAttachInputText,
  sendInputText,
  sendResizeRequest,
  WEB_SHARE_PROTOCOL_VERSION,
} from './wire';

const OUTPUT_RAW = 0x01;
const RESIZE_NOTIFY = 0x02;
const SNAPSHOT_FULL = 0x10;
const TERMINAL_THEME_STORAGE_KEY = 'rmux.share.terminalTheme';
const CHROME_HIDDEN_STORAGE_KEY = 'rmux.share.chromeHidden';
const PRIVACY_TOAST_MS = 20_000;
const PIN_RE = /^\d{6}$/;
const PIN_REQUIRED_CLOSE_CODE = 4008;
const PROVENANCE_PATH = '.well-known/rmux-web-share.json';

export function startShareApp(root: HTMLElement): void {
  const view = ShareView.render(root);
  let terminalTheme = readTerminalTheme();
  let connection: ShareConnection | undefined;
  let params: ShareParams;
  let currentPin: string | undefined;
  const applyTerminalTheme = (theme: TerminalThemeName) => {
    view.setTerminalTheme(theme, connection?.terminalPalette());
    connection?.setTerminalTheme(theme);
  };

  applyTerminalTheme(terminalTheme);
  view.bindTerminalTheme((theme) => {
    terminalTheme = theme;
    writeTerminalTheme(theme);
    applyTerminalTheme(theme);
  });
  view.setChromeHidden(readChromeHidden());
  view.bindChromeToggle((hidden) => {
    writeChromeHidden(hidden);
    view.setChromeHidden(hidden);
  });
  bindUserThemeChanges(() => {
    if (terminalTheme !== 'user') {
      return;
    }
    applyTerminalTheme(terminalTheme);
  });

  try {
    params = parseShareFragment(window.location.hash);
  } catch (error) {
    view.showError(error instanceof Error ? error.message : 'invalid share URL');
    return;
  }
  removeShareSecretFromAddressBar();
  if (params.theme) {
    terminalTheme = params.theme;
    applyTerminalTheme(terminalTheme);
  }
  view.setNavbarMode(params.navbar);
  if (params.navbar === 'off') {
    view.setChromeHidden(true);
  }

  const host = endpointHost(params.endpoint);
  const copy = confirmationCopy(params.endpoint);
  const connect = (pin = currentPin) => {
    currentPin = pin;
    connection?.dispose();
    connection = new ShareConnection(params, view, () => terminalTheme, pin, () => showConnectPrompt(true));
    connection.connect();
  };
  const showConnectPrompt = (requiresPin: boolean) => {
    view.confirm(host, copy, requiresPin, {
      cancel: () => view.setStatus({ connected: false, detail: 'connection canceled', tone: 'idle' }),
      connect,
    });
  };
  view.bindReconnectActions({
    reconnect: () => connect(),
    copyLink: () => copyCurrentShareUrl(params, view),
  });
  showConnectPrompt(false);
}

class ShareConnection {
  private role: ShareRole;
  private socket?: WebSocket;
  private socketError = false;
  private terminal?: ShareTerminal;
  private userTerminalTheme?: TerminalThemePalette;
  private scope: ShareScope = 'pane';
  private controls = false;
  private passControlsToPty = false;
  private remoteResize = false;
  private resizeHandler?: () => void;
  private disposed = false;

  constructor(
    private readonly params: ShareParams,
    private readonly view: ShareView,
    private readonly terminalTheme: () => TerminalThemeName,
    private readonly pin?: string,
    private readonly requestPin?: () => void,
  ) {
    this.role = 'read';
  }

  connect(): void {
    this.view.hideReconnect();
    this.view.setStatus({ connected: false, detail: 'connecting', tone: 'idle' });
    const socket = new WebSocket(this.params.endpoint);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;

    socket.addEventListener('open', () => {
      rememberLocalAccess(this.params.endpoint);
      this.view.setStatus({ connected: false, detail: 'authenticating', tone: 'idle' });
      socket.send(authPayload(this.params, this.pin));
    });
    socket.addEventListener('message', (event) => this.handleMessage(event));
    socket.addEventListener('error', () => {
      this.socketError = true;
      this.view.showError(connectionErrorMessage(this.params.endpoint));
    });
    socket.addEventListener('close', (event) => this.handleClose(event));
  }

  private handleMessage(event: MessageEvent<string | ArrayBuffer>): void {
    if (typeof event.data === 'string') {
      this.handleControl(JSON.parse(event.data) as ServerMessage);
      return;
    }
    this.handleBinary(new Uint8Array(event.data));
  }

  private handleControl(message: ServerMessage): void {
    switch (message.type) {
      case 'ready':
        this.handleReady(message);
        break;
      case 'error':
        this.view.showError(message.code);
        this.socket?.close();
        break;
      case 'operator_changed':
        this.view.setOperatorConnected(message.connected);
        break;
      case 'viewer_count':
        this.view.setViewerCount(message);
        break;
      case 'ttl_warn':
        this.terminal?.notice(`share expires in ${message.seconds_remaining}s`);
        this.view.setStatus({ connected: true, detail: `expires in ${message.seconds_remaining}s`, tone: 'warn' });
        break;
      case 'pane_process_exit':
        this.terminal?.notice(`process exited${message.exit_code === null ? '' : ` (${message.exit_code})`}`);
        break;
      case 'share_revoked':
        this.terminal?.notice(`share revoked: ${message.reason}`);
        this.view.setStatus({ connected: true, detail: `revoked: ${message.reason}`, tone: 'warn' });
        break;
    }
  }

  private handleClose(event: CloseEvent): void {
    if (this.disposed) {
      return;
    }
    if (this.socketError && event.code === 1006) {
      return;
    }

    if (event.code === PIN_REQUIRED_CLOSE_CODE) {
      this.view.setStatus({ connected: false, detail: 'pairing code required', tone: 'warn' });
      this.requestPin?.();
      return;
    }

    const message = closeMessage(event.code);
    if (event.code === 1000) {
      this.view.setStatus({ connected: false, detail: message, tone: 'idle' });
      return;
    }

    this.view.setStatus({ connected: false, detail: 'disconnected', tone: 'error' });
    const recovery = `${message}. Lost connection? Try refreshing.`;
    if (this.terminal) {
      this.terminal.notice(recovery);
      return;
    }
    this.view.showError(recovery, 'disconnected');
  }

  private handleReady(message: ReadyMessage): void {
    if (message.protocol_version !== WEB_SHARE_PROTOCOL_VERSION) {
      this.view.showError('unsupported rmux web-share protocol');
      this.socket?.close(4006, 'protocol_version_mismatch');
      return;
    }
    this.view.hideReconnect();
    this.role = message.role;
    this.scope = message.scope;
    this.controls = message.controls && message.scope === 'session' && message.role === 'operator';
    this.passControlsToPty = false;
    this.userTerminalTheme = message.terminal_palette;
    this.view.setViewerCountMode(message.show_viewers);
    this.view.setTerminalTheme(this.terminalTheme(), this.userTerminalTheme);
    this.disposeTerminal();
    this.terminal = openShareTerminal(
      this.view.terminalElement(),
      this.role,
      message.pane_size.cols,
      message.pane_size.rows,
      this.terminalTheme(),
      this.userTerminalTheme,
    );
    this.terminal.onData((data) => this.sendOperatorData(data));
    this.terminal.onResize(({ cols, rows }) => this.sendOperatorResize(cols, rows));
    this.view.bindControlsPassthrough((enabled) => {
      this.passControlsToPty = enabled;
      this.view.setControlsPassthrough(enabled);
      this.terminal?.term.focus();
    });
    this.view.bindSessionActions({
      detach: () => this.detach(),
      logout: () => this.logout(),
    });
    this.view.setReady(message);
    this.view.setViewerCount(message);
    this.view.setControlsInline(this.controls, this.passControlsToPty);
    if (this.params.disclaimer !== 'off') {
      this.view.showPrivacyToast(this.params.endpoint);
    }
    if (message.scope === 'session') {
      this.terminal.fit();
    }
    this.resizeHandler = () => this.terminal?.fit();
    window.addEventListener('resize', this.resizeHandler);
  }

  private handleBinary(frame: Uint8Array): void {
    if (!frame.length || !this.terminal) {
      return;
    }
    const opcode = frame[0];
    const payload = frame.subarray(1);
    if (opcode === OUTPUT_RAW || opcode === SNAPSHOT_FULL) {
      this.terminal.write(payload);
    } else if (opcode === RESIZE_NOTIFY && payload.length === 4) {
      this.remoteResize = true;
      this.terminal.resize((payload[0] << 8) | payload[1], (payload[2] << 8) | payload[3]);
      this.remoteResize = false;
    }
  }

  setTerminalTheme(theme: TerminalThemeName): void {
    this.terminal?.setTheme(theme, this.userTerminalTheme);
  }

  terminalPalette(): TerminalThemePalette | undefined {
    return this.userTerminalTheme;
  }

  dispose(): void {
    this.disposed = true;
    this.socket?.close(1000, 'replaced');
    this.socket = undefined;
    this.disposeTerminal();
  }

  private sendOperatorData(data: string): void {
    const socket = this.openOperatorSocket();
    if (!socket) {
      return;
    }
    const send = this.controls && !this.passControlsToPty ? sendAttachInputText : sendInputText;
    if (!send(socket, data)) {
      this.view.setStatus({ connected: true, detail: 'input too large', tone: 'error' });
    }
  }

  private sendOperatorResize(cols: number, rows: number): void {
    const socket = this.openOperatorSocket();
    if (!socket || this.remoteResize) {
      return;
    }
    sendResizeRequest(socket, cols, rows);
  }

  private detach(): void {
    this.socket?.close(1000, 'detached');
    this.socket = undefined;
    this.view.setStatus({ connected: false, detail: 'disconnected', tone: 'idle' });
    this.view.showReconnect();
  }

  private logout(): void {
    const socket = this.openOperatorSocket();
    if (!socket || this.scope !== 'session' || !this.controls) {
      return;
    }
    this.view.setStatus({ connected: true, detail: 'closing session', tone: 'warn' });
    logoutSession(socket);
  }

  private openOperatorSocket(): WebSocket | undefined {
    if (this.role !== 'operator' || this.socket?.readyState !== WebSocket.OPEN) {
      return undefined;
    }
    return this.socket;
  }

  private disposeTerminal(): void {
    if (this.resizeHandler) {
      window.removeEventListener('resize', this.resizeHandler);
      this.resizeHandler = undefined;
    }
    this.terminal?.dispose();
    this.terminal = undefined;
  }
}

class ShareView {
  private readonly app: HTMLElement;
  private readonly endpointHost: HTMLElement;
  private readonly role: HTMLElement;
  private readonly status: HTMLElement;
  private readonly terminal: HTMLElement;
  private readonly terminalPlaceholder: HTMLElement;
  private readonly reconnectPanel: HTMLElement;
  private readonly reconnectConnect: HTMLButtonElement;
  private readonly reconnectCopy: HTMLButtonElement;
  private readonly themeSelect: HTMLSelectElement;
  private readonly chromeHide: HTMLButtonElement;
  private readonly chromeShow: HTMLButtonElement;
  private readonly viewers: HTMLElement;
  private readonly viewersCount: HTMLElement;
  private readonly controlsInline: HTMLElement;
  private readonly controlsPassthroughButton: HTMLButtonElement;
  private readonly statusButton: HTMLButtonElement;
  private readonly confirmDialog: HTMLDialogElement;
  private readonly confirmDetail: HTMLElement;
  private readonly confirmConnect: HTMLButtonElement;
  private readonly confirmCancel: HTMLButtonElement;
  private readonly sessionActionsDialog: HTMLDialogElement;
  private readonly sessionActionsDetach: HTMLButtonElement;
  private readonly sessionActionsLogout: HTMLButtonElement;
  private readonly provenanceDialog: HTMLDialogElement;
  private readonly provenanceOpen: HTMLButtonElement;
  private readonly provenanceCommit: HTMLAnchorElement;
  private readonly provenanceRun: HTMLAnchorElement;
  private readonly provenanceCloudflare: HTMLAnchorElement;
  private readonly provenanceStatement: HTMLElement;
  private readonly pinGroup: HTMLElement;
  private readonly pinInput: HTMLInputElement;
  private readonly pinError: HTMLElement;
  private readonly meta: HTMLElement;
  private readonly toast: HTMLElement;
  private connected = false;
  private canLogout = false;
  private viewerCountVisible = false;
  private detachHandler?: () => void;
  private logoutHandler?: () => void;
  private reconnectHandler?: () => void;
  private copyLinkHandler?: () => void;
  private controlsPassthroughHandler?: (enabled: boolean) => void;
  private controlsPassthrough = false;
  private toastTimer?: number;

  private constructor(root: HTMLElement) {
    root.innerHTML = shareViewTemplate();
    this.app = query(root, '.share-app');
    this.endpointHost = query(root, '[data-share-endpoint]');
    this.role = query(root, '[data-share-role]');
    this.status = query(root, '[data-share-status]');
    this.terminal = query(root, '[data-share-terminal]');
    this.terminalPlaceholder = query(root, '[data-share-terminal-placeholder]');
    this.reconnectPanel = query(root, '[data-share-reconnect]');
    this.reconnectConnect = query(root, '[data-share-reconnect-connect]');
    this.reconnectCopy = query(root, '[data-share-reconnect-copy]');
    this.themeSelect = query(root, '[data-share-terminal-theme]');
    this.chromeHide = query(root, '[data-share-chrome-hide]');
    this.chromeShow = query(root, '[data-share-chrome-show]');
    this.viewers = query(root, '[data-share-viewers]');
    this.viewersCount = query(root, '[data-share-viewers-count]');
    this.controlsInline = query(root, '[data-share-controls]');
    this.controlsPassthroughButton = query(root, '[data-share-controls-passthrough]');
    this.statusButton = query(root, '[data-share-status-menu]');
    this.confirmDialog = query(root, '[data-share-confirm]');
    this.confirmDetail = query(root, '[data-share-confirm-detail]');
    this.confirmConnect = query(root, '[data-share-confirm-connect]');
    this.confirmCancel = query(root, '[data-share-confirm-cancel]');
    this.sessionActionsDialog = query(root, '[data-share-session-actions]');
    this.sessionActionsDetach = query(root, '[data-share-session-detach]');
    this.sessionActionsLogout = query(root, '[data-share-session-logout]');
    this.provenanceDialog = query(root, '[data-share-provenance]');
    this.provenanceOpen = query(root, '[data-share-provenance-open]');
    this.provenanceCommit = query(root, '[data-share-provenance-commit]');
    this.provenanceRun = query(root, '[data-share-provenance-run]');
    this.provenanceCloudflare = query(root, '[data-share-provenance-cloudflare]');
    this.provenanceStatement = query(root, '[data-share-provenance-statement]');
    this.pinGroup = query(root, '[data-share-pin-group]');
    this.pinInput = query(root, '[data-share-pin]');
    this.pinError = query(root, '[data-share-pin-error]');
    this.meta = query(root, '[data-share-meta]');
    this.toast = query(root, '[data-share-toast]');
    this.statusButton.addEventListener('click', () => this.openSessionActions());
    this.sessionActionsDetach.addEventListener('click', () => {
      this.sessionActionsDialog.close();
      this.detachHandler?.();
    });
    this.sessionActionsLogout.addEventListener('click', () => {
      this.sessionActionsDialog.close();
      this.logoutHandler?.();
    });
    this.reconnectConnect.addEventListener('click', () => this.reconnectHandler?.());
    this.reconnectCopy.addEventListener('click', () => this.copyLinkHandler?.());
    this.provenanceOpen.addEventListener('click', () => {
      void this.openProvenance();
    });
  }

  static render(root: HTMLElement): ShareView {
    return new ShareView(root);
  }

  confirm(
    host: string,
    copy: ConfirmationCopy,
    requiresPin: boolean,
    actions: { cancel: () => void; connect: (pin?: string) => void },
  ): void {
    this.endpointHost.textContent = host;
    this.confirmDetail.textContent = copy.detail;
    this.confirmConnect.textContent = copy.button;
    this.confirmDialog.dataset.local = String(copy.local);
    this.pinGroup.hidden = !requiresPin;
    this.pinInput.required = requiresPin;
    this.pinInput.value = '';
    this.pinError.textContent = '';
    this.confirmConnect.onclick = () => {
      const pin = this.confirmPin(requiresPin);
      if (pin === false) {
        return;
      }
      this.confirmDialog.close();
      actions.connect(pin);
    };
    this.confirmCancel.onclick = () => {
      this.confirmDialog.close();
      actions.cancel();
    };
    this.confirmDialog.showModal();
  }

  bindSessionActions(handlers: { detach: () => void; logout: () => void }): void {
    this.detachHandler = handlers.detach;
    this.logoutHandler = handlers.logout;
  }

  bindReconnectActions(handlers: { reconnect: () => void; copyLink: () => void }): void {
    this.reconnectHandler = handlers.reconnect;
    this.copyLinkHandler = handlers.copyLink;
  }

  bindControlsPassthrough(handler: (enabled: boolean) => void): void {
    this.controlsPassthroughHandler = handler;
    this.controlsPassthroughButton.onclick = () => {
      const next = !this.controlsPassthrough;
      this.controlsPassthroughHandler?.(next);
    };
  }

  bindTerminalTheme(handler: (theme: TerminalThemeName) => void): void {
    this.themeSelect.addEventListener('change', () => {
      if (isTerminalThemeName(this.themeSelect.value)) {
        handler(this.themeSelect.value);
      }
    });
  }

  bindChromeToggle(handler: (hidden: boolean) => void): void {
    this.chromeHide.addEventListener('click', () => handler(true));
    this.chromeShow.addEventListener('click', () => handler(false));
  }

  terminalElement(): HTMLElement {
    return this.terminal;
  }

  setReady(message: ReadyMessage): void {
    this.setRole(message.role);
    this.setControlsInline(message.controls && message.scope === 'session' && message.role === 'operator', false);
    this.setSessionActions(message.controls && message.scope === 'session' && message.role === 'operator');
    this.setOperatorConnected(Boolean(message.operator_connected));
    const label = [message.session_name, message.pane_label].filter(Boolean).join(' ');
    this.meta.textContent = label || message.share_id || 'rmux share';
    this.setStatus({ connected: true, detail: 'connected', tone: 'ok' });
  }

  setRole(role: ShareRole): void {
    this.role.textContent = titleCase(role);
    this.terminal.dataset.role = role;
    this.rootDataset('role', role);
  }

  setControlsInline(visible: boolean, passthrough: boolean): void {
    this.controlsPassthrough = passthrough;
    this.controlsInline.hidden = !visible;
    this.rootDataset('controls', visible ? 'enabled' : 'disabled');
    this.setControlsPassthrough(passthrough);
  }

  setControlsPassthrough(enabled: boolean): void {
    this.controlsPassthrough = enabled;
    this.controlsInline.dataset.passthrough = enabled ? 'pty' : 'rmux';
    this.controlsPassthroughButton.textContent = enabled ? 'PTY keys' : 'rmux keys';
    this.controlsPassthroughButton.setAttribute('aria-pressed', String(enabled));
  }

  setSessionActions(canLogout: boolean): void {
    this.canLogout = canLogout;
  }

  showReconnect(): void {
    this.reconnectCopy.textContent = 'Copy link';
    this.reconnectPanel.hidden = false;
  }

  hideReconnect(): void {
    this.reconnectPanel.hidden = true;
  }

  setCopyLinkStatus(copied: boolean): void {
    this.reconnectCopy.textContent = copied ? 'Copied' : 'Copy failed';
  }

  setTerminalTheme(theme: TerminalThemeName, userTheme?: TerminalThemePalette): void {
    const chromePalette = terminalChromePalette(theme, userTheme);
    this.themeSelect.value = theme;
    this.terminal.dataset.theme = theme;
    this.terminal.dataset.themeMode = terminalThemeMode(theme, userTheme);
    this.rootDataset('terminalTheme', theme);
    this.rootDataset('terminalMode', terminalThemeMode(theme, userTheme));
    this.rootDataset('clientPalette', chromePalette ? 'present' : 'absent');
    this.setClientChromePalette(chromePalette);
  }

  setChromeHidden(hidden: boolean): void {
    this.app.dataset.chrome = hidden ? 'hidden' : 'visible';
    this.chromeHide.setAttribute('aria-expanded', String(!hidden));
    this.chromeShow.setAttribute('aria-expanded', String(!hidden));
  }

  setNavbarMode(navbar: ShareParams['navbar']): void {
    this.app.dataset.navbar = navbar;
  }

  setViewerCountMode(visible: boolean): void {
    this.viewerCountVisible = visible;
    this.viewers.hidden = !this.viewerCountVisible;
  }

  setViewerCount(message: ReadyMessage | ViewerCountMessage): void {
    if (!this.viewerCountVisible) {
      return;
    }
    const viewers = connectedViewers(message);
    this.viewersCount.textContent = String(viewers);
    this.viewers.title = `${viewers} connected browser${viewers === 1 ? '' : 's'}`;
  }

  setOperatorConnected(connected: boolean): void {
    this.rootDataset('operator', connected ? 'connected' : 'free');
  }

  setStatus(status: ShareStatus): void {
    if (status.connected !== undefined) {
      this.connected = status.connected;
    }
    this.status.textContent = this.connected ? 'Connected' : 'Disconnected';
    this.statusButton.dataset.tone = this.connected ? 'ok' : status.tone ?? 'idle';
    this.setTerminalPlaceholder(status);
  }

  showPrivacyToast(endpoint: string): void {
    this.toast.replaceChildren(privacyToastContent(endpoint));
    this.toast.hidden = false;
    this.toast.dataset.visible = 'true';
    if (this.toastTimer !== undefined) {
      window.clearTimeout(this.toastTimer);
    }
    this.toastTimer = window.setTimeout(() => {
      this.toast.hidden = true;
      this.toast.dataset.visible = 'false';
      this.toastTimer = undefined;
    }, PRIVACY_TOAST_MS);
  }

  showError(message: string, status = 'error'): void {
    this.setStatus({ connected: false, detail: status, tone: 'error' });
    this.terminal.replaceChildren();
    const error = document.createElement('div');
    error.className = 'share-error';
    error.textContent = message;
    this.terminal.append(error);
  }

  private rootDataset(key: string, value: string): void {
    this.app.dataset[key] = value;
  }

  private setClientChromePalette(
    palette: ReturnType<typeof terminalChromePalette>,
  ): void {
    if (!palette) {
      this.app.style.removeProperty('--share-client-accent');
      this.app.style.removeProperty('--share-client-bg');
      this.app.style.removeProperty('--share-client-fg');
      return;
    }
    this.app.style.setProperty('--share-client-accent', palette.accent);
    this.app.style.setProperty('--share-client-bg', palette.background);
    this.app.style.setProperty('--share-client-fg', palette.foreground);
  }

  private openSessionActions(): void {
    if (!this.connected) {
      return;
    }
    this.sessionActionsLogout.hidden = !this.canLogout;
    this.sessionActionsLogout.disabled = !this.canLogout;
    this.sessionActionsDialog.showModal();
  }

  private async openProvenance(): Promise<void> {
    this.provenanceDialog.showModal();
    try {
      const provenanceUrl = new URL(PROVENANCE_PATH, shareBaseUrl()).toString();
      const response = await fetch(provenanceUrl, { cache: 'no-store' });
      if (!response.ok) {
        throw new Error(`failed to fetch ${provenanceUrl}`);
      }
      this.setProvenance(await response.json() as BuildProvenance);
    } catch {
      this.provenanceStatement.textContent = 'Build provenance is unavailable for this deployment.';
      setProofLink(this.provenanceCommit, 'Repository', 'https://github.com/Helvesec/rmux-web-share');
      setProofLink(this.provenanceRun, 'Actions', 'https://github.com/Helvesec/rmux-web-share/actions');
      setProofLink(this.provenanceCloudflare, 'Cloudflare proof in Actions', 'https://github.com/Helvesec/rmux-web-share/actions');
    }
  }

  private setProvenance(provenance: BuildProvenance): void {
    this.provenanceStatement.textContent = provenance.security_statement;
    setProofLink(
      this.provenanceCommit,
      shortSha(provenance.commit_sha1),
      provenance.commit_url ?? provenance.repository,
    );
    setProofLink(
      this.provenanceRun,
      provenance.github_actions.run_id ? `run ${provenance.github_actions.run_id}` : 'Actions',
      provenance.github_actions.run_url ?? `${provenance.repository}/actions`,
    );
    setProofLink(
      this.provenanceCloudflare,
      provenance.cloudflare_pages.project,
      provenance.cloudflare_pages.deployment_proof,
    );
  }

  private setTerminalPlaceholder(status: ShareStatus): void {
    if (!this.terminalPlaceholder.isConnected) {
      return;
    }
    this.terminalPlaceholder.textContent = status.detail;
    this.terminalPlaceholder.dataset.tone = status.tone ?? 'idle';
  }

  private confirmPin(requiresPin: boolean): string | undefined | false {
    if (!requiresPin) {
      return undefined;
    }
    const pin = this.pinInput.value.trim();
    if (PIN_RE.test(pin)) {
      this.pinError.textContent = '';
      return pin;
    }
    this.pinError.textContent = 'Enter the 6-digit pairing code shown by rmux.';
    this.pinInput.focus();
    this.pinInput.select();
    return false;
  }
}

function query<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) {
    throw new Error(`missing share element ${selector}`);
  }
  return element;
}

interface BuildProvenance {
  repository: string;
  commit_sha1: string | null;
  commit_url: string | null;
  security_statement: string;
  github_actions: {
    run_id: string | null;
    run_url: string | null;
  };
  cloudflare_pages: {
    project: string;
    deployment_proof: string;
  };
}

function setProofLink(link: HTMLAnchorElement, label: string, href: string): void {
  link.textContent = label;
  link.href = href;
}

function shortSha(value: string | null): string {
  return value ? value.slice(0, 12) : 'unavailable';
}

function connectedViewers(message: ReadyMessage | ViewerCountMessage): number {
  const explicit = finiteCount(message.viewers_connected);
  if (explicit !== undefined) {
    return explicit;
  }
  const readers = finiteCount(message.readers_active) ?? 0;
  return readers + (message.operator_connected ? 1 : 0);
}

function finiteCount(value: number | undefined): number | undefined {
  return value === undefined || !Number.isFinite(value)
    ? undefined
    : Math.max(0, Math.floor(value));
}

function bindUserThemeChanges(callback: () => void): void {
  const media = window.matchMedia('(prefers-color-scheme: light)');
  media.addEventListener('change', callback);
}

function readTerminalTheme(): TerminalThemeName {
  try {
    const stored = window.localStorage.getItem(TERMINAL_THEME_STORAGE_KEY);
    return stored && isTerminalThemeName(stored) ? stored : DEFAULT_TERMINAL_THEME;
  } catch {
    return DEFAULT_TERMINAL_THEME;
  }
}

function readChromeHidden(): boolean {
  try {
    return window.sessionStorage.getItem(CHROME_HIDDEN_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function writeChromeHidden(hidden: boolean): void {
  try {
    window.sessionStorage.setItem(CHROME_HIDDEN_STORAGE_KEY, String(hidden));
  } catch {
    // Toolbar visibility is only a session preference.
  }
}

function removeShareSecretFromAddressBar(): void {
  if (!window.location.hash) {
    return;
  }

  window.history.replaceState(null, '', shareBasePath());
}

async function copyCurrentShareUrl(params: ShareParams, view: ShareView): Promise<void> {
  try {
    await copyText(shareUrl(params));
    view.setCopyLinkStatus(true);
  } catch {
    view.setCopyLinkStatus(false);
  }
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

function writeTerminalTheme(theme: TerminalThemeName): void {
  try {
    window.localStorage.setItem(TERMINAL_THEME_STORAGE_KEY, theme);
  } catch {
    // Theme selection is cosmetic; private browsing storage failures are harmless.
  }
}
