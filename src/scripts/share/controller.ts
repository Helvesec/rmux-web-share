import { endpointHost, parseShareFragment, shareBasePath, shareBaseUrl, shareUrl } from './fragment';
import {
  createClientHello,
  createEncryptedTransport,
  parseChallenge,
  type ClientHandshakeState,
  type EncryptedShareTransport,
} from './e2ee';
import {
  chromeLocalAccessCopy,
  connectionErrorMessage,
  pinPromptCopy,
  rememberLocalAccess,
  shouldShowChromeLocalAccessHelp,
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
  PaneResizeDirection,
  ServerMessage,
  SessionView,
  SessionWindowView,
  SessionSplitDirection,
  ShareParams,
  ShareRole,
  ShareScope,
  ShareStatus,
  ViewerCountMessage,
} from './types';
import type { TerminalThemePalette } from './types';
import { shareViewTemplate, titleCase } from './view-content';
import {
  authPayload,
  closeMessage,
  killSessionPane,
  killSessionWindow,
  logoutSession,
  newSessionWindow,
  scrollSessionPane,
  selectSessionPane,
  selectSessionWindow,
  resizeSessionPane,
  sendAttachInputText,
  sendInputText,
  sendResizeRequest,
  splitSessionPane,
  WEB_SHARE_PROTOCOL_VERSION,
} from './wire';

const OUTPUT_RAW = 0x01;
const RESIZE_NOTIFY = 0x02;
const SNAPSHOT_FULL = 0x10;
const SESSION_VIEW = 0x11;
const TERMINAL_THEME_STORAGE_KEY = 'rmux.share.terminalTheme';
const PIN_RE = /^\d{6}$/;
const PIN_REQUIRED_CLOSE_CODE = 4008;
const PROVENANCE_PATH = '.well-known/rmux-web-share.json';
interface TerminalMenuState {
  canCopy: boolean;
  canPaste: boolean;
  canShowToolbar: boolean;
}

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
  view.setChromeHidden(false);
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
  const connect = (pin = currentPin) => {
    currentPin = pin;
    connection?.dispose();
    connection = new ShareConnection(
      params,
      view,
      () => terminalTheme,
      pin,
      () => showPrompt(host, pinPromptCopy(), true),
      () => showPrompt(host, chromeLocalAccessCopy(params.endpoint), false),
    );
    connection.connect();
  };
  const showPrompt = (promptHost: string, copy: ConfirmationCopy, requiresPin: boolean) => {
    view.confirm(promptHost, copy, requiresPin, {
      cancel: () => view.setStatus({ connected: false, detail: 'disconnected', tone: 'idle' }),
      connect,
    });
  };
  view.bindReconnectActions({
    reconnect: () => connect(),
    copyLink: () => copyCurrentShareUrl(params, view),
  });
  connect();
}

class ShareConnection {
  private role: ShareRole;
  private socket?: WebSocket;
  private transport?: EncryptedShareTransport;
  private handshake?: ClientHandshakeState;
  private socketError = false;
  private terminal?: ShareTerminal;
  private userTerminalTheme?: TerminalThemePalette;
  private scope: ShareScope = 'pane';
  private sessionControls = false;
  private viewportHandler?: () => void;
  private viewportObserver?: ResizeObserver;
  private viewportRaf?: number;
  private viewportTimers: number[] = [];
  private lastResizeRequest?: { cols: number; rows: number };
  private disposed = false;

  constructor(
    private readonly params: ShareParams,
    private readonly view: ShareView,
    private readonly terminalTheme: () => TerminalThemeName,
    private readonly pin?: string,
    private readonly requestPin?: () => void,
    private readonly requestLocalAccessHelp?: () => void,
  ) {
    this.role = 'spectator';
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
      void this.sendHello(socket);
    });
    socket.addEventListener('message', (event) => {
      void this.handleMessage(event);
    });
    socket.addEventListener('error', () => {
      this.socketError = true;
      this.view.showError(connectionErrorMessage(this.params.endpoint));
      if (shouldShowChromeLocalAccessHelp(this.params.endpoint)) {
        this.requestLocalAccessHelp?.();
      }
    });
    socket.addEventListener('close', (event) => this.handleClose(event));
  }

  private async sendHello(socket: WebSocket): Promise<void> {
    try {
      const hello = await createClientHello(this.params);
      this.handshake = hello.state;
      socket.send(hello.text);
    } catch {
      this.view.showError('browser crypto is unavailable');
      socket.close(4006, 'e2ee_unavailable');
    }
  }

  private async handleMessage(event: MessageEvent<string | ArrayBuffer>): Promise<void> {
    if (!this.transport) {
      if (typeof event.data !== 'string' || !this.handshake || !this.socket) {
        this.socket?.close(4006, 'invalid_e2ee_handshake');
        return;
      }
      try {
        this.transport = await createEncryptedTransport(
          this.socket,
          this.handshake,
          parseChallenge(event.data),
        );
        this.transport.sendText(authPayload(this.pin));
      } catch {
        this.view.showError('encrypted handshake failed');
        this.socket?.close(4006, 'e2ee_handshake_failed');
      }
      return;
    }

    if (typeof event.data === 'string') {
      this.socket?.close(4006, 'plaintext_after_e2ee');
      return;
    }
    try {
      const message = await this.transport.open(event.data);
      if (message.type === 'text') {
        this.handleControl(JSON.parse(message.text) as ServerMessage);
      } else {
        this.handleBinary(message.bytes);
      }
    } catch {
      this.view.showError('encrypted frame failed authentication');
      this.socket?.close(4006, 'e2ee_decrypt_failed');
    }
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
    this.sessionControls = message.controls && message.scope === 'session' && message.role === 'operator';
    this.userTerminalTheme = message.terminal_palette;
    this.view.setViewerCountMode(message.show_viewers);
    this.view.setTerminalTheme(this.terminalTheme(), this.userTerminalTheme);
    this.disposeTerminal();
    this.terminal = openShareTerminal(
      this.view.terminalElement(),
      message.scope,
      this.role,
      message.pane_size.cols,
      message.pane_size.rows,
      this.terminalTheme(),
      this.userTerminalTheme,
    );
    this.terminal.onData((data) => this.sendOperatorData(data));
    this.terminal.onPaneSelect((paneId) => this.selectPane(paneId));
    this.terminal.onPaneResize((paneId, direction, cells) => this.resizePane(paneId, direction, cells));
    this.terminal.onPaneScroll((paneId, delta) => this.sendPaneScroll(paneId, delta));
    this.terminal.onWindowSelect((windowIndex) => this.view.selectWindow(windowIndex));
    this.terminal.onWindowMenu((windowIndex, x, y) => this.view.openWindowActions(windowIndex, x, y));
    this.terminal.onTerminalMenu((x, y) => {
      this.view.openTerminalMenu(x, y, {
        canCopy: Boolean(this.terminal?.selection()),
        canPaste: this.role === 'operator' && typeof navigator.clipboard?.readText === 'function',
        canShowToolbar: this.view.toolbarHidden(),
      });
    });
    this.view.bindSessionActions({
      detach: () => this.detach(),
      logout: () => this.logout(),
    });
    this.view.bindTerminalActions({
      copy: () => this.copyTerminalSelection(),
      paste: () => this.pasteIntoTerminal(),
      showToolbar: () => this.showToolbar(),
    });
    this.view.bindSessionControls({
      splitHorizontal: () => this.splitPane('horizontal'),
      splitVertical: () => this.splitPane('vertical'),
      newWindow: () => this.newWindow(),
      killPane: () => this.killPane(),
      selectWindow: (windowIndex) => this.selectWindow(windowIndex),
      editWindow: (windowIndex) => this.editWindow(windowIndex),
      killWindow: (windowIndex) => this.killWindow(windowIndex),
    });
    this.view.setReady(message);
    this.view.setViewerCount(message);
    this.bindTerminalViewport();
  }

  private handleBinary(frame: Uint8Array): void {
    if (!frame.length || !this.terminal) {
      return;
    }
    const opcode = frame[0];
    const payload = frame.subarray(1);
    if (opcode === SNAPSHOT_FULL) {
      this.terminal.replace(payload);
      this.scheduleTerminalViewportSync();
    } else if (opcode === SESSION_VIEW) {
      const view = parseSessionView(payload);
      this.terminal.setSessionView(view);
      this.view.setSessionView(view);
      this.scheduleTerminalViewportSync();
    } else if (opcode === OUTPUT_RAW) {
      this.terminal.write(payload);
      if (this.scope !== 'session') {
        this.scheduleTerminalViewportSync();
      }
    } else if (opcode === RESIZE_NOTIFY && payload.length === 4) {
      this.terminal.resize((payload[0] << 8) | payload[1], (payload[2] << 8) | payload[3]);
      this.scheduleTerminalViewportSync();
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
    this.transport = undefined;
    this.disposeTerminal();
  }

  private sendOperatorData(data: string): void {
    const socket = this.openOperatorSocket();
    if (!socket) {
      return;
    }
    const send = this.sessionControls ? sendAttachInputText : sendInputText;
    if (!send(socket, data)) {
      this.view.setStatus({ connected: true, detail: 'input too large', tone: 'error' });
      return;
    }
    this.terminal?.followLiveOutput();
  }

  private sendPaneScroll(paneId: number, delta: number): void {
    if (this.socket?.readyState !== WebSocket.OPEN || !this.transport || this.scope !== 'session') {
      return;
    }
    scrollSessionPane(this.transport, paneId, delta);
  }

  private selectPane(paneId: number): void {
    if (this.socket?.readyState !== WebSocket.OPEN || !this.transport || this.scope !== 'session' || this.role !== 'operator') {
      return;
    }
    selectSessionPane(this.transport, paneId);
  }

  private resizePane(paneId: number, direction: PaneResizeDirection, cells: number): void {
    if (this.socket?.readyState !== WebSocket.OPEN || !this.transport || this.scope !== 'session' || this.role !== 'operator') {
      return;
    }
    resizeSessionPane(this.transport, paneId, direction, cells);
  }

  private splitPane(direction: SessionSplitDirection): void {
    const socket = this.openSessionOperatorSocket();
    if (socket) {
      splitSessionPane(socket, direction);
    }
  }

  private newWindow(): void {
    const socket = this.openSessionOperatorSocket();
    if (socket) {
      newSessionWindow(socket);
    }
  }

  private killPane(): void {
    const socket = this.openSessionOperatorSocket();
    if (socket) {
      killSessionPane(socket);
    }
  }

  private selectWindow(windowIndex: number): void {
    const socket = this.openSessionOperatorSocket();
    if (socket) {
      selectSessionWindow(socket, windowIndex);
    }
  }

  private killWindow(windowIndex: number): void {
    const socket = this.openSessionOperatorSocket();
    if (socket) {
      killSessionWindow(socket, windowIndex);
    }
  }

  private editWindow(windowIndex: number): void {
    const socket = this.openSessionOperatorSocket();
    if (!socket) {
      return;
    }
    selectSessionWindow(socket, windowIndex);
    sendAttachInputText(socket, '\u0002,');
    this.terminal?.followLiveOutput();
  }

  private async copyTerminalSelection(): Promise<void> {
    const selected = this.terminal?.selection() ?? '';
    if (selected) {
      try {
        await copyText(selected);
      } catch {
        // Clipboard failures are browser-policy dependent; keep the terminal session intact.
      }
    }
  }

  private async pasteIntoTerminal(): Promise<void> {
    if (this.role !== 'operator' || !navigator.clipboard?.readText) {
      return;
    }
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        this.sendOperatorData(text);
      }
    } catch {
      // Clipboard reads may be denied outside trusted browser gestures.
    }
  }

  private showToolbar(): void {
    this.view.showToolbar();
    this.terminal?.syncViewport();
  }

  private detach(): void {
    this.socket?.close(1000, 'detached');
    this.socket = undefined;
    this.transport = undefined;
    this.view.setStatus({ connected: false, detail: 'disconnected', tone: 'idle' });
    this.view.showReconnect();
  }

  private logout(): void {
    const socket = this.openOperatorSocket();
    if (!socket || this.scope !== 'session' || !this.sessionControls) {
      return;
    }
    this.view.setStatus({ connected: true, detail: 'closing session', tone: 'warn' });
    logoutSession(socket);
  }

  private openOperatorSocket(): EncryptedShareTransport | undefined {
    if (
      this.role !== 'operator'
      || this.socket?.readyState !== WebSocket.OPEN
      || !this.transport
    ) {
      return undefined;
    }
    return this.transport;
  }

  private openSessionOperatorSocket(): EncryptedShareTransport | undefined {
    if (this.scope !== 'session') {
      return undefined;
    }
    return this.openOperatorSocket();
  }

  private bindTerminalViewport(): void {
    this.viewportHandler = () => this.scheduleTerminalViewportSync();
    window.addEventListener('resize', this.viewportHandler, { passive: true });
    if (typeof ResizeObserver !== 'undefined') {
      this.viewportObserver = new ResizeObserver(() => this.scheduleTerminalViewportSync());
      this.viewportObserver.observe(this.view.terminalElement());
    }
    this.terminal?.syncViewport();
    this.syncOperatorBrowserSize();
    this.scheduleTerminalViewportSync();
    for (const delay of [16, 64, 250, 1000]) {
      this.viewportTimers.push(window.setTimeout(() => this.scheduleTerminalViewportSync(), delay));
    }
  }

  private scheduleTerminalViewportSync(): void {
    if (!this.terminal || this.viewportRaf !== undefined) {
      return;
    }
    this.viewportRaf = window.requestAnimationFrame(() => {
      this.viewportRaf = undefined;
      this.terminal?.syncViewport();
      this.syncOperatorBrowserSize();
    });
  }

  private disposeTerminal(): void {
    if (this.viewportHandler) {
      window.removeEventListener('resize', this.viewportHandler);
      this.viewportHandler = undefined;
    }
    this.viewportObserver?.disconnect();
    this.viewportObserver = undefined;
    if (this.viewportRaf !== undefined) {
      window.cancelAnimationFrame(this.viewportRaf);
      this.viewportRaf = undefined;
    }
    for (const timer of this.viewportTimers) {
      window.clearTimeout(timer);
    }
    this.viewportTimers = [];
    this.terminal?.dispose();
    this.terminal = undefined;
    this.lastResizeRequest = undefined;
  }

  private syncOperatorBrowserSize(): void {
    if (
      this.scope !== 'session'
      || this.role !== 'operator'
      || this.socket?.readyState !== WebSocket.OPEN
      || !this.transport
      || !this.terminal
    ) {
      return;
    }
    const size = this.terminal.fitSize();
    if (!size || (
      this.lastResizeRequest?.cols === size.cols
      && this.lastResizeRequest?.rows === size.rows
    )) {
      return;
    }
    this.lastResizeRequest = size;
    sendResizeRequest(this.transport, size.cols, size.rows);
  }
}

class ShareView {
  private readonly app: HTMLElement;
  private readonly endpointHost: HTMLElement;
  private readonly role: HTMLElement;
  private readonly status: HTMLElement;
  private readonly terminalShell: HTMLElement;
  private readonly terminal: HTMLElement;
  private readonly terminalPlaceholder: HTMLElement;
  private readonly reconnectPanel: HTMLElement;
  private readonly reconnectConnect: HTMLButtonElement;
  private readonly reconnectCopy: HTMLButtonElement;
  private readonly themeSelect: HTMLSelectElement;
  private readonly sessionControls: HTMLElement;
  private readonly splitHorizontal: HTMLButtonElement;
  private readonly splitVertical: HTMLButtonElement;
  private readonly newWindow: HTMLButtonElement;
  private readonly killPane: HTMLButtonElement;
  private readonly viewers: HTMLElement;
  private readonly viewersCount: HTMLElement;
  private readonly sessionMenuButton: HTMLButtonElement;
  private readonly windowMenu: HTMLElement;
  private readonly windowNew: HTMLButtonElement;
  private readonly windowEdit: HTMLButtonElement;
  private readonly windowKill: HTMLButtonElement;
  private readonly terminalMenu: HTMLElement;
  private readonly terminalCopy: HTMLButtonElement;
  private readonly terminalPaste: HTMLButtonElement;
  private readonly terminalShowToolbar: HTMLButtonElement;
  private readonly terminalProvenance: HTMLButtonElement;
  private readonly confirmDialog: HTMLDialogElement;
  private readonly confirmTitle: HTMLElement;
  private readonly confirmDetail: HTMLElement;
  private readonly confirmConnect: HTMLButtonElement;
  private readonly confirmCancel: HTMLButtonElement;
  private readonly sessionActionsDialog: HTMLDialogElement;
  private readonly sessionActionsCancel: HTMLButtonElement;
  private readonly sessionActionsClose: HTMLButtonElement;
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
  private connected = false;
  private canLogout = false;
  private viewerCountVisible = false;
  private sessionControlVisible = false;
  private windows: SessionWindowView[] = [];
  private selectedWindowIndex?: number;
  private detachHandler?: () => void;
  private logoutHandler?: () => void;
  private copyTerminalHandler?: () => void | Promise<void>;
  private pasteTerminalHandler?: () => void | Promise<void>;
  private showToolbarHandler?: () => void;
  private splitHorizontalHandler?: () => void;
  private splitVerticalHandler?: () => void;
  private newWindowHandler?: () => void;
  private killPaneHandler?: () => void;
  private selectWindowHandler?: (windowIndex: number) => void;
  private editWindowHandler?: (windowIndex: number) => void;
  private killWindowHandler?: (windowIndex: number) => void;
  private reconnectHandler?: () => void;
  private copyLinkHandler?: () => void;

  private constructor(root: HTMLElement) {
    root.innerHTML = shareViewTemplate();
    this.app = query(root, '.share-app');
    this.endpointHost = query(root, '[data-share-endpoint]');
    this.role = query(root, '[data-share-role]');
    this.status = query(root, '[data-share-status]');
    this.terminalShell = query(root, '[data-share-terminal-shell]');
    this.terminal = query(root, '[data-share-terminal]');
    this.terminalPlaceholder = query(root, '[data-share-terminal-placeholder]');
    this.reconnectPanel = query(root, '[data-share-reconnect]');
    this.reconnectConnect = query(root, '[data-share-reconnect-connect]');
    this.reconnectCopy = query(root, '[data-share-reconnect-copy]');
    this.themeSelect = query(root, '[data-share-terminal-theme]');
    this.sessionControls = query(root, '[data-share-session-controls]');
    this.splitHorizontal = query(root, '[data-share-split-horizontal]');
    this.splitVertical = query(root, '[data-share-split-vertical]');
    this.newWindow = query(root, '[data-share-new-window]');
    this.killPane = query(root, '[data-share-kill-pane]');
    this.viewers = query(root, '[data-share-viewers]');
    this.viewersCount = query(root, '[data-share-viewers-count]');
    this.sessionMenuButton = query(root, '[data-share-session-menu]');
    this.windowMenu = query(root, '[data-share-window-menu]');
    this.windowNew = query(root, '[data-share-window-new]');
    this.windowEdit = query(root, '[data-share-window-edit]');
    this.windowKill = query(root, '[data-share-window-kill]');
    this.terminalMenu = query(root, '[data-share-terminal-menu]');
    this.terminalCopy = query(root, '[data-share-terminal-copy]');
    this.terminalPaste = query(root, '[data-share-terminal-paste]');
    this.terminalShowToolbar = query(root, '[data-share-terminal-show-toolbar]');
    this.terminalProvenance = query(root, '[data-share-terminal-provenance]');
    this.confirmDialog = query(root, '[data-share-confirm]');
    this.confirmTitle = query(root, '[data-share-confirm-title]');
    this.confirmDetail = query(root, '[data-share-confirm-detail]');
    this.confirmConnect = query(root, '[data-share-confirm-connect]');
    this.confirmCancel = query(root, '[data-share-confirm-cancel]');
    this.sessionActionsDialog = query(root, '[data-share-session-actions]');
    this.sessionActionsCancel = query(root, '[data-share-session-cancel]');
    this.sessionActionsClose = query(root, '[data-share-session-close]');
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
    this.sessionMenuButton.addEventListener('click', () => this.openSessionActions());
    this.splitHorizontal.addEventListener('click', () => this.splitHorizontalHandler?.());
    this.splitVertical.addEventListener('click', () => this.splitVerticalHandler?.());
    this.newWindow.addEventListener('click', () => this.newWindowHandler?.());
    this.killPane.addEventListener('click', () => this.killPaneHandler?.());
    this.windowNew.addEventListener('click', () => {
      this.closeWindowMenu();
      this.newWindowHandler?.();
    });
    this.windowEdit.addEventListener('click', () => this.editSelectedWindow());
    this.windowKill.addEventListener('click', () => this.killSelectedWindow());
    document.addEventListener('pointerdown', (event) => {
      const target = event.target as Node | null;
      if (!this.windowMenu.hidden && !this.windowMenu.contains(target)) {
        this.closeWindowMenu();
      }
      if (!this.terminalMenu.hidden && !this.terminalMenu.contains(target)) {
        this.closeTerminalMenu();
      }
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        this.closeWindowMenu();
        this.closeTerminalMenu();
      }
    });
    this.terminalCopy.addEventListener('click', () => {
      this.closeTerminalMenu();
      void this.copyTerminalHandler?.();
    });
    this.terminalPaste.addEventListener('click', () => {
      this.closeTerminalMenu();
      void this.pasteTerminalHandler?.();
    });
    this.terminalShowToolbar.addEventListener('click', () => {
      this.closeTerminalMenu();
      this.showToolbarHandler?.();
    });
    this.terminalProvenance.addEventListener('click', () => {
      this.closeTerminalMenu();
      void this.openProvenance();
    });
    this.sessionActionsCancel.addEventListener('click', () => this.sessionActionsDialog.close());
    this.sessionActionsClose.addEventListener('click', () => this.sessionActionsDialog.close());
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
    this.confirmTitle.textContent = copy.title;
    this.endpointHost.textContent = host;
    this.endpointHost.hidden = !copy.local;
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

  bindSessionControls(handlers: {
    splitHorizontal: () => void;
    splitVertical: () => void;
    newWindow: () => void;
    killPane: () => void;
    selectWindow: (windowIndex: number) => void;
    editWindow: (windowIndex: number) => void;
    killWindow: (windowIndex: number) => void;
  }): void {
    this.splitHorizontalHandler = handlers.splitHorizontal;
    this.splitVerticalHandler = handlers.splitVertical;
    this.newWindowHandler = handlers.newWindow;
    this.killPaneHandler = handlers.killPane;
    this.selectWindowHandler = handlers.selectWindow;
    this.editWindowHandler = handlers.editWindow;
    this.killWindowHandler = handlers.killWindow;
  }

  bindReconnectActions(handlers: { reconnect: () => void; copyLink: () => void }): void {
    this.reconnectHandler = handlers.reconnect;
    this.copyLinkHandler = handlers.copyLink;
  }

  bindTerminalActions(handlers: {
    copy: () => void | Promise<void>;
    paste: () => void | Promise<void>;
    showToolbar: () => void;
  }): void {
    this.copyTerminalHandler = handlers.copy;
    this.pasteTerminalHandler = handlers.paste;
    this.showToolbarHandler = handlers.showToolbar;
  }

  bindTerminalTheme(handler: (theme: TerminalThemeName) => void): void {
    this.themeSelect.addEventListener('change', () => {
      if (isTerminalThemeName(this.themeSelect.value)) {
        handler(this.themeSelect.value);
      }
    });
  }

  terminalElement(): HTMLElement {
    return this.terminal;
  }

  setReady(message: ReadyMessage): void {
    this.setRole(message.role);
    this.terminal.dataset.scope = message.scope;
    this.setSessionActions(message.controls && message.scope === 'session' && message.role === 'operator');
    this.setSessionControls(message.scope === 'session' && message.role === 'operator');
    this.setOperatorConnected((finiteCount(message.operators_active) ?? 0) > 0);
    const label = [message.session_name, message.pane_label].filter(Boolean).join(' ');
    this.meta.textContent = label || message.share_id || 'rmux share';
    this.setStatus({ connected: true, detail: 'connected', tone: 'ok' });
  }

  setRole(role: ShareRole): void {
    this.role.textContent = titleCase(role);
    this.terminal.dataset.role = role;
    this.rootDataset('role', role);
  }

  setSessionActions(canLogout: boolean): void {
    this.canLogout = canLogout;
  }

  setSessionControls(visible: boolean): void {
    this.sessionControlVisible = visible;
    this.sessionControls.hidden = !visible;
  }

  setSessionView(view: SessionView): void {
    this.windows = normalizeWindows(view.windows);
    if (this.selectedWindowIndex === undefined || !this.windows.some((window) => window.index === this.selectedWindowIndex)) {
      this.selectedWindowIndex = this.activeWindow()?.index;
    }
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
  }

  setNavbarMode(navbar: ShareParams['navbar']): void {
    this.app.dataset.navbar = navbar;
  }

  showToolbar(): void {
    this.setNavbarMode('visible');
    this.setChromeHidden(false);
  }

  toolbarHidden(): boolean {
    return this.app.dataset.navbar === 'off' || this.app.dataset.chrome === 'hidden';
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
    this.sessionMenuButton.title = this.connected ? 'Disconnect' : 'Disconnected';
    this.rootDataset('connected', String(this.connected));
    this.setTerminalPlaceholder(status);
  }

  selectWindow(windowIndex: number): void {
    if (!this.sessionControlVisible) {
      return;
    }
    this.selectedWindowIndex = windowIndex;
    this.selectWindowHandler?.(windowIndex);
  }

  openWindowActions(windowIndex: number, x: number, y: number): void {
    if (!this.sessionControlVisible) {
      return;
    }
    this.closeTerminalMenu();
    this.selectedWindowIndex = windowIndex;
    this.windowEdit.disabled = false;
    this.windowKill.disabled = false;
    this.windowMenu.hidden = false;
    const rect = this.windowMenu.getBoundingClientRect();
    const left = Math.min(Math.max(8, x), window.innerWidth - rect.width - 8);
    const top = Math.min(Math.max(8, y), window.innerHeight - rect.height - 8);
    this.windowMenu.style.left = `${left}px`;
    this.windowMenu.style.top = `${top}px`;
    this.windowNew.focus();
  }

  openTerminalMenu(x: number, y: number, state: TerminalMenuState): void {
    this.closeWindowMenu();
    this.terminalCopy.disabled = !state.canCopy;
    this.terminalPaste.disabled = !state.canPaste;
    this.terminalShowToolbar.hidden = !state.canShowToolbar;
    this.terminalMenu.hidden = false;
    const rect = this.terminalMenu.getBoundingClientRect();
    const left = Math.min(Math.max(8, x), window.innerWidth - rect.width - 8);
    const top = Math.min(Math.max(8, y), window.innerHeight - rect.height - 8);
    this.terminalMenu.style.left = `${left}px`;
    this.terminalMenu.style.top = `${top}px`;
    const first = [this.terminalCopy, this.terminalPaste, this.terminalShowToolbar, this.terminalProvenance]
      .find((button) => !button.hidden && !button.disabled);
    first?.focus();
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
    this.sessionActionsDetach.hidden = !this.connected;
    this.sessionActionsDetach.disabled = !this.connected;
    this.sessionActionsLogout.hidden = !this.connected || !this.canLogout;
    this.sessionActionsLogout.disabled = !this.connected || !this.canLogout;
    this.sessionActionsDialog.showModal();
  }

  private editSelectedWindow(): void {
    if (this.selectedWindowIndex === undefined) {
      return;
    }
    this.closeWindowMenu();
    this.editWindowHandler?.(this.selectedWindowIndex);
  }

  private killSelectedWindow(): void {
    if (this.selectedWindowIndex === undefined) {
      return;
    }
    this.closeWindowMenu();
    this.killWindowHandler?.(this.selectedWindowIndex);
  }

  private closeWindowMenu(): void {
    this.windowMenu.hidden = true;
  }

  private closeTerminalMenu(): void {
    this.terminalMenu.hidden = true;
  }

  private activeWindow(): SessionWindowView | undefined {
    return this.windows.find((window) => window.active);
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

function parseSessionView(payload: Uint8Array): SessionView {
  const view = JSON.parse(new TextDecoder().decode(payload)) as SessionView;
  if (!view || !Array.isArray(view.panes)) {
    throw new Error('invalid session view');
  }
  return view;
}

function connectedViewers(message: ReadyMessage | ViewerCountMessage): number {
  const explicit = finiteCount(message.viewers_connected);
  if (explicit !== undefined) {
    return explicit;
  }
  const spectators = finiteCount(message.spectators_active) ?? 0;
  return spectators + (finiteCount(message.operators_active) ?? 0);
}

function normalizeWindows(windows: SessionWindowView[] | undefined): SessionWindowView[] {
  return (windows ?? [])
    .filter((window) => Number.isInteger(window.index) && window.index >= 0)
    .map((window) => ({
      index: window.index,
      name: window.name || String(window.index),
      active: Boolean(window.active),
    }))
    .sort((left, right) => left.index - right.index);
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
