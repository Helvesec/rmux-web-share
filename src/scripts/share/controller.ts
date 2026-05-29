import {
  clearActiveShareParams,
  endpointHost,
  parseShareFragment,
  readActiveShareParams,
  rememberActiveShareParams,
  shareAssetUrl,
  shareBasePath,
} from './fragment';
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
  markRecentShareDisconnected,
  markRecentShareUnavailable,
  recentShareCrab,
  rememberRecentShare,
  rememberRecentWindowName,
  updateRecentShareViewers,
} from './home-storage';
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
import { ProvenanceDialog } from './provenance';
import { shareViewTemplate, titleCase } from './view-content';
import { enableShareWindowBoundsTracking, resizeShareWindowForPairingPrompt, resizeShareWindowForTerminal } from './window-bounds';
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
const PIN_MASK_DELAY_MS = 330;
const DISCONNECTED_RECONNECTING = 'Disconnected. Reconnecting...';
interface TerminalMenuState {
  canCopy: boolean;
  canPaste: boolean;
  canControlSession: boolean;
  toolbarHidden: boolean;
}

type ShareExitState = 'disconnected' | 'unavailable';

export function startShareApp(root: HTMLElement): void {
  const view = ShareView.render(root);
  let terminalTheme = readTerminalTheme();
  let connection: ShareConnection | undefined;
  let params: ShareParams;
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
    params = window.location.hash ? parseShareFragment(window.location.hash) : readActiveShareParams();
    if (!params) {
      throw new Error('missing share token');
    }
  } catch (error) {
    view.showError(error instanceof Error ? error.message : 'invalid share URL');
    return;
  }
  rememberActiveShareParams(params);
  removeShareSecretFromAddressBar();
  if (params.theme) {
    terminalTheme = params.theme;
    applyTerminalTheme(terminalTheme);
  }
  view.setNavbarMode(params.navbar);
  if (params.navbar === 'off') {
    view.setChromeHidden(true);
  }
  view.setBrandCrab(recentShareCrab(params));

  const leaveShare = (state: ShareExitState = 'disconnected') => {
    connection?.dispose('left_share');
    connection = undefined;
    if (state === 'unavailable') {
      markRecentShareUnavailable(params);
    } else {
      markRecentShareDisconnected(params);
    }
    clearActiveShareParams();
    window.location.replace(shareBasePath());
  };
  const host = endpointHost(params.endpoint);
  const connect = (pin?: string) => {
    connection?.dispose();
    connection = new ShareConnection(
      params,
      view,
      () => terminalTheme,
      pin,
      () => showPrompt(host, pinPromptCopy(), true),
      () => showPrompt(host, chromeLocalAccessCopy(params.endpoint), false),
      leaveShare,
    );
    connection.connect();
  };
  const showPrompt = (promptHost: string, copy: ConfirmationCopy, requiresPin: boolean) => {
    view.confirm(promptHost, copy, requiresPin, {
      cancel: leaveShare,
      connect,
    });
  };
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
  private logoutPending = false;
  private logoutFallbackTimer?: number;
  private disposed = false;

  constructor(
    private readonly params: ShareParams,
    private readonly view: ShareView,
    private readonly terminalTheme: () => TerminalThemeName,
    private readonly pin?: string,
    private readonly requestPin?: () => void,
    private readonly requestLocalAccessHelp?: () => void,
    private readonly leaveShare?: (state?: ShareExitState) => void,
  ) {
    this.role = 'spectator';
  }

  connect(): void {
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
        updateRecentShareViewers(this.params, connectedViewers(message));
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
      this.view.setStatus({
        connected: false,
        detail: 'Pairing code required',
        tone: 'warn',
        action: () => this.requestPin?.(),
      });
      this.requestPin?.();
      return;
    }

    if (event.code === 1000 && (event.reason === 'session_closed' || this.logoutPending)) {
      this.leaveShare?.('unavailable');
      return;
    }

    const message = closeMessage(event.code);
    if (event.code === 1000) {
      this.view.setStatus({ connected: false, detail: message, tone: 'idle' });
      return;
    }

    const recovery = `${message}. Lost connection? Try refreshing.`;
    if (event.code === 1006) {
      this.view.setStatus({ connected: false, detail: DISCONNECTED_RECONNECTING, tone: 'warn' });
      this.terminal?.notice(recovery);
      return;
    }

    this.view.setStatus({ connected: false, detail: 'disconnected', tone: 'error' });
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
      const connected = this.view.isConnected();
      this.view.openTerminalMenu(x, y, {
        canCopy: Boolean(this.terminal?.selection()),
        canPaste: connected && this.role === 'operator' && typeof navigator.clipboard?.readText === 'function',
        canControlSession: connected && this.sessionControls,
        toolbarHidden: this.view.toolbarHidden(),
      });
    });
    this.view.bindSessionActions({
      detach: () => this.detach(),
      logout: () => this.logout(),
    });
    this.view.bindTerminalActions({
      copy: () => this.copyTerminalSelection(),
      paste: () => this.pasteIntoTerminal(),
      toggleToolbar: () => this.toggleToolbar(),
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
    resizeShareWindowForTerminal();
    enableShareWindowBoundsTracking();
    const recent = rememberRecentShare(this.params, message, undefined, this.pin);
    this.view.setBrandCrab(recent.crab);
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
      rememberRecentWindowName(this.params, view);
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

  dispose(reason = 'replaced'): void {
    this.disposed = true;
    if (this.logoutFallbackTimer !== undefined) {
      window.clearTimeout(this.logoutFallbackTimer);
      this.logoutFallbackTimer = undefined;
    }
    this.socket?.close(1000, reason);
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
    this.terminal?.focus();
    window.setTimeout(() => this.terminal?.focus(), 30);
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

  private toggleToolbar(): void {
    this.view.toggleToolbar();
    this.terminal?.syncViewport();
  }

  private detach(): void {
    this.leaveShare?.();
  }

  private logout(): void {
    const socket = this.openOperatorSocket();
    if (!socket || this.scope !== 'session' || !this.sessionControls) {
      return;
    }
    this.view.setStatus({ connected: true, detail: 'closing session', tone: 'warn' });
    this.logoutPending = true;
    logoutSession(socket);
    this.logoutFallbackTimer = window.setTimeout(() => this.leaveShare?.('unavailable'), 1000);
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
  private readonly brandLogoDark: HTMLImageElement;
  private readonly brandLogoLight: HTMLImageElement;
  private readonly endpointHost: HTMLElement;
  private readonly role: HTMLElement;
  private readonly status: HTMLElement;
  private readonly terminalShell: HTMLElement;
  private readonly terminal: HTMLElement;
  private readonly terminalPlaceholder: HTMLElement;
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
  private readonly terminalCopyShortcut: HTMLElement;
  private readonly terminalPaste: HTMLButtonElement;
  private readonly terminalPasteShortcut: HTMLElement;
  private readonly terminalShowToolbar: HTMLButtonElement;
  private readonly terminalToolbarLabel: HTMLElement;
  private readonly terminalControlsSeparator: HTMLElement;
  private readonly terminalControls: HTMLElement;
  private readonly terminalSplitHorizontal: HTMLButtonElement;
  private readonly terminalSplitVertical: HTMLButtonElement;
  private readonly terminalNewWindow: HTMLButtonElement;
  private readonly terminalKillPane: HTMLButtonElement;
  private readonly terminalProvenance: HTMLButtonElement;
  private readonly provenance: ProvenanceDialog;
  private readonly confirmDialog: HTMLDialogElement;
  private readonly confirmLogo: HTMLImageElement;
  private readonly confirmTitle: HTMLElement;
  private readonly confirmDetail: HTMLElement;
  private readonly confirmConnect: HTMLButtonElement;
  private readonly confirmCancel: HTMLButtonElement;
  private readonly sessionActionsDialog: HTMLDialogElement;
  private readonly sessionActionsClose: HTMLButtonElement;
  private readonly sessionActionsDetach: HTMLButtonElement;
  private readonly sessionActionsLogout: HTMLButtonElement;
  private readonly provenanceOpen: HTMLButtonElement;
  private readonly pinGroup: HTMLElement;
  private readonly pinInput: HTMLInputElement;
  private readonly pinBoxes: HTMLElement;
  private readonly pinError: HTMLElement;
  private readonly meta: HTMLElement;
  private pinSubmitHandler?: (pin?: string) => void;
  private confirmCancelHandler?: () => void;
  private readonly pinMaskTimers: Array<number | undefined> = [];
  private readonly pinBoxDigits: Array<string | undefined> = [];
  private pinSubmitted = false;
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
  private toggleToolbarHandler?: () => void;
  private splitHorizontalHandler?: () => void;
  private splitVerticalHandler?: () => void;
  private newWindowHandler?: () => void;
  private killPaneHandler?: () => void;
  private selectWindowHandler?: (windowIndex: number) => void;
  private editWindowHandler?: (windowIndex: number) => void;
  private killWindowHandler?: (windowIndex: number) => void;

  private constructor(root: HTMLElement) {
    root.innerHTML = shareViewTemplate();
    this.app = query(root, '.share-app');
    query<HTMLAnchorElement>(root, '[data-share-home-link]').addEventListener('click', () => {
      clearActiveShareParams();
    });
    this.brandLogoDark = query(root, '.share-brand-logo-dark');
    this.brandLogoLight = query(root, '.share-brand-logo-light');
    this.endpointHost = query(root, '[data-share-endpoint]');
    this.role = query(root, '[data-share-role]');
    this.status = query(root, '[data-share-status]');
    this.terminalShell = query(root, '[data-share-terminal-shell]');
    this.terminal = query(root, '[data-share-terminal]');
    this.terminalPlaceholder = query(root, '[data-share-terminal-placeholder]');
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
    this.terminalCopyShortcut = query(root, '[data-share-terminal-copy-shortcut]');
    this.terminalPaste = query(root, '[data-share-terminal-paste]');
    this.terminalPasteShortcut = query(root, '[data-share-terminal-paste-shortcut]');
    this.terminalShowToolbar = query(root, '[data-share-terminal-show-toolbar]');
    this.terminalToolbarLabel = query(root, '[data-share-terminal-toolbar-label]');
    this.terminalControlsSeparator = query(root, '[data-share-terminal-controls-separator]');
    this.terminalControls = query(root, '[data-share-terminal-controls]');
    this.terminalSplitHorizontal = query(root, '[data-share-terminal-split-horizontal]');
    this.terminalSplitVertical = query(root, '[data-share-terminal-split-vertical]');
    this.terminalNewWindow = query(root, '[data-share-terminal-new-window]');
    this.terminalKillPane = query(root, '[data-share-terminal-kill-pane]');
    this.terminalProvenance = query(root, '[data-share-terminal-provenance]');
    this.provenance = new ProvenanceDialog(root);
    this.confirmDialog = query(root, '[data-share-confirm]');
    this.confirmLogo = query(root, '[data-share-confirm-logo]');
    this.confirmTitle = query(root, '[data-share-confirm-title]');
    this.confirmDetail = query(root, '[data-share-confirm-detail]');
    this.confirmConnect = query(root, '[data-share-confirm-connect]');
    this.confirmCancel = query(root, '[data-share-confirm-cancel]');
    this.sessionActionsDialog = query(root, '[data-share-session-actions]');
    this.sessionActionsClose = query(root, '[data-share-session-close]');
    this.sessionActionsDetach = query(root, '[data-share-session-detach]');
    this.sessionActionsLogout = query(root, '[data-share-session-logout]');
    this.provenanceOpen = query(root, '[data-share-provenance-open]');
    this.pinGroup = query(root, '[data-share-pin-group]');
    this.pinInput = query(root, '[data-share-pin]');
    this.pinBoxes = query(root, '[data-share-pin-boxes]');
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
      this.toggleToolbarHandler?.();
    });
    this.terminalSplitHorizontal.addEventListener('click', () => {
      this.runTerminalSessionControl(this.splitHorizontalHandler);
    });
    this.terminalSplitVertical.addEventListener('click', () => {
      this.runTerminalSessionControl(this.splitVerticalHandler);
    });
    this.terminalNewWindow.addEventListener('click', () => {
      this.runTerminalSessionControl(this.newWindowHandler);
    });
    this.terminalKillPane.addEventListener('click', () => {
      this.runTerminalSessionControl(this.killPaneHandler);
    });
    this.terminalProvenance.addEventListener('click', () => {
      this.closeTerminalMenu();
      void this.provenance.open();
    });
    this.sessionActionsClose.addEventListener('click', () => this.sessionActionsDialog.close());
    this.sessionActionsDetach.addEventListener('click', () => {
      this.sessionActionsDialog.close();
      this.detachHandler?.();
    });
    this.sessionActionsLogout.addEventListener('click', () => {
      this.sessionActionsDialog.close();
      this.logoutHandler?.();
    });
    this.provenance.bind(this.provenanceOpen);
    this.setTerminalShortcuts();
    this.confirmDialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      this.confirmDialog.close();
      this.confirmCancelHandler?.();
    });
    this.pinInput.addEventListener('input', () => this.syncPinEntry());
    this.pinInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') {
        return;
      }
      event.preventDefault();
      this.tryAutoSubmitPin();
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
    this.confirmDialog.dataset.pin = String(requiresPin);
    this.pinSubmitHandler = actions.connect;
    this.confirmCancelHandler = actions.cancel;
    this.pinSubmitted = false;
    this.pinGroup.hidden = !requiresPin;
    this.pinInput.required = requiresPin;
    this.pinInput.value = '';
    this.pinError.textContent = '';
    this.syncPinEntry();
    this.confirmConnect.disabled = requiresPin;
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
      this.confirmCancelHandler?.();
    };
    if (requiresPin) {
      resizeShareWindowForPairingPrompt();
    }
    this.confirmDialog.showModal();
    if (requiresPin) {
      this.focusPinInput();
    }
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

  bindTerminalActions(handlers: {
    copy: () => void | Promise<void>;
    paste: () => void | Promise<void>;
    toggleToolbar: () => void;
  }): void {
    this.copyTerminalHandler = handlers.copy;
    this.pasteTerminalHandler = handlers.paste;
    this.toggleToolbarHandler = handlers.toggleToolbar;
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

  setBrandCrab(color: string): void {
    this.brandLogoDark.src = shareAssetUrl(`crabs/${color}-dark.svg`);
    this.brandLogoLight.src = shareAssetUrl(`crabs/${color}-light.svg`);
    this.confirmLogo.src = shareAssetUrl(`crabs/${color}-light.svg`);
  }

  setSessionActions(canLogout: boolean): void {
    this.canLogout = canLogout;
  }

  setSessionControls(visible: boolean): void {
    this.sessionControlVisible = visible;
    this.updateSessionControlsVisibility();
  }

  setSessionView(view: SessionView): void {
    this.windows = normalizeWindows(view.windows);
    if (this.selectedWindowIndex === undefined || !this.windows.some((window) => window.index === this.selectedWindowIndex)) {
      this.selectedWindowIndex = this.activeWindow()?.index;
    }
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

  toggleToolbar(): void {
    if (this.toolbarHidden()) {
      this.showToolbar();
    } else {
      this.setChromeHidden(true);
    }
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
    this.updateSessionControlsVisibility();
    this.setTerminalPlaceholder(status);
  }

  isConnected(): boolean {
    return this.connected;
  }

  selectWindow(windowIndex: number): void {
    if (!this.connected || !this.sessionControlVisible) {
      return;
    }
    this.selectedWindowIndex = windowIndex;
    this.selectWindowHandler?.(windowIndex);
  }

  openWindowActions(windowIndex: number, x: number, y: number): void {
    if (!this.connected || !this.sessionControlVisible) {
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
    if (!this.connected) {
      this.closeTerminalMenu();
      return;
    }
    const canControlSession = this.connected && state.canControlSession;
    this.terminalCopy.disabled = !state.canCopy;
    this.terminalPaste.disabled = !this.connected || !state.canPaste;
    this.terminalShowToolbar.hidden = false;
    this.terminalToolbarLabel.textContent = state.toolbarHidden ? 'Show toolbar' : 'Hide toolbar';
    this.terminalControlsSeparator.hidden = !canControlSession;
    this.terminalControls.hidden = !canControlSession;
    this.terminalMenu.hidden = false;
    const rect = this.terminalMenu.getBoundingClientRect();
    const left = Math.min(Math.max(8, x), window.innerWidth - rect.width - 8);
    const top = Math.min(Math.max(8, y), window.innerHeight - rect.height - 8);
    this.terminalMenu.style.left = `${left}px`;
    this.terminalMenu.style.top = `${top}px`;
    const first = [
      this.terminalCopy,
      this.terminalPaste,
      this.terminalShowToolbar,
      this.terminalSplitHorizontal,
      this.terminalSplitVertical,
      this.terminalNewWindow,
      this.terminalKillPane,
      this.terminalProvenance,
    ]
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
    if (!this.connected) {
      return;
    }
    if (!this.canLogout && this.app.dataset.role === 'spectator') {
      this.detachHandler?.();
      return;
    }
    this.sessionActionsDetach.hidden = false;
    this.sessionActionsDetach.disabled = false;
    this.sessionActionsLogout.hidden = !this.canLogout;
    this.sessionActionsLogout.disabled = !this.canLogout;
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

  private runTerminalSessionControl(handler?: () => void): void {
    this.closeTerminalMenu();
    if (this.connected) {
      handler?.();
    }
  }

  private setTerminalShortcuts(): void {
    const primary = primaryShortcutLabel();
    this.terminalCopyShortcut.textContent = `${primary}C`;
    this.terminalPasteShortcut.textContent = `${primary}V`;
  }

  private activeWindow(): SessionWindowView | undefined {
    return this.windows.find((window) => window.active);
  }

  private updateSessionControlsVisibility(): void {
    this.sessionControls.hidden = !(this.connected && this.sessionControlVisible);
  }

  private setTerminalPlaceholder(status: ShareStatus): void {
    if (!this.terminalPlaceholder.isConnected) {
      if (this.connected) {
        return;
      }
      this.terminal.append(this.terminalPlaceholder);
    }
    this.terminalPlaceholder.replaceChildren();
    if (status.action) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'share-placeholder-action';
      button.textContent = status.detail;
      button.addEventListener('click', status.action);
      this.terminalPlaceholder.append(button);
    } else if (!this.connected && status.detail === DISCONNECTED_RECONNECTING) {
      const state = document.createElement('span');
      state.className = 'share-placeholder-state';
      const spinner = document.createElement('span');
      spinner.className = 'share-placeholder-spinner';
      spinner.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.textContent = DISCONNECTED_RECONNECTING;
      state.append(spinner, label);
      this.terminalPlaceholder.append(state);
    } else {
      this.terminalPlaceholder.textContent = status.detail;
    }
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

  private syncPinEntry(): void {
    const normalized = this.pinInput.value.replace(/\D/g, '').slice(0, 6);
    if (this.pinInput.value !== normalized) {
      this.pinInput.value = normalized;
    }
    const boxes = Array.from(this.pinBoxes.querySelectorAll<HTMLElement>('i'));
    boxes.forEach((box, index) => {
      const digit = normalized[index];
      if (!digit) {
        box.textContent = '';
        this.pinBoxDigits[index] = undefined;
        window.clearTimeout(this.pinMaskTimers[index]);
        this.pinMaskTimers[index] = undefined;
      } else if (this.pinBoxDigits[index] !== digit) {
        this.pinBoxDigits[index] = digit;
        box.textContent = digit;
        window.clearTimeout(this.pinMaskTimers[index]);
        this.pinMaskTimers[index] = window.setTimeout(() => {
          if (this.pinBoxDigits[index] === digit) {
            box.textContent = '*';
          }
        }, PIN_MASK_DELAY_MS);
      }
      box.dataset.filled = String(index < normalized.length);
    });
    this.confirmConnect.disabled = requiresPinVisible(this.confirmDialog) && normalized.length !== 6;
    if (normalized.length === 6) {
      window.setTimeout(() => this.tryAutoSubmitPin(), 0);
    }
  }

  private tryAutoSubmitPin(): void {
    if (this.pinSubmitted || !requiresPinVisible(this.confirmDialog)) {
      return;
    }
    const pin = this.confirmPin(true);
    if (pin === false) {
      return;
    }
    this.pinSubmitted = true;
    this.confirmDialog.close();
    this.pinSubmitHandler?.(pin);
  }

  private focusPinInput(): void {
    const focus = () => {
      this.pinInput.focus({ preventScroll: true });
    };
    focus();
    window.requestAnimationFrame(focus);
    window.setTimeout(focus, 0);
    window.setTimeout(focus, 80);
  }
}

function requiresPinVisible(dialog: HTMLElement): boolean {
  return dialog.dataset.pin === 'true';
}

function query<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) {
    throw new Error(`missing share element ${selector}`);
  }
  return element;
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

function primaryShortcutLabel(): string {
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform) ? '⌘' : 'Ctrl+';
}

function bindUserThemeChanges(callback: () => void): void {
  const media = window.matchMedia('(prefers-color-scheme: light)');
  media.addEventListener('change', callback);
}

function readTerminalTheme(): TerminalThemeName {
  try {
    const stored = window.sessionStorage.getItem(TERMINAL_THEME_STORAGE_KEY);
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
    window.sessionStorage.setItem(TERMINAL_THEME_STORAGE_KEY, theme);
  } catch {
    // Theme selection is cosmetic; private browsing storage failures are harmless.
  }
}
