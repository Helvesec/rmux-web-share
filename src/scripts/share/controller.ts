import {
  clearActiveShareParams,
  endpointHost,
  parseShareFragment,
  readActiveShareParams,
  rememberActiveShareParams,
  shareAssetUrl,
  shareBasePath,
  shareUrl,
} from './fragment';
import {
  checkBrowserCryptoSupport,
  createClientHello,
  createEncryptedTransport,
  parseChallenge,
  type ClientHandshakeState,
  type EncryptedShareTransport,
} from './e2ee';
import { browserCryptoUnavailableCopy } from './browser-support';
import {
  connectionErrorMessage,
  localAccessBlockedCopy,
  localAccessPromptCopy,
  pinPromptCopy,
  rememberLocalAccess,
  safariLocalAccessCopy,
  shouldShowLocalAccessBlockedHelp,
  shouldShowLocalAccessPrompt,
  shouldShowSafariLocalAccessPrompt,
  type ConfirmationCopy,
} from './local-access';
import {
  markRecentShareDisconnected,
  markRecentShareUnavailable,
  recentShareCrab,
  recentSharePin,
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
  SessionPaneView,
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
import { SessionHistoryGate } from './session-history';
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
const RECONNECT_BASE_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 10_000;
// Ignore sub-threshold resize churn (e.g. the on-screen keyboard nudging the
// viewport by a row) so it does not trigger a remote redraw on every keystroke.
const RESIZE_HYSTERESIS_CELLS = 2;
// A real keyboard close is sustained; a per-keystroke viewport transient recovers
// within a frame or two. Defer shrinking the keyboard inset by this long so the
// transient cannot drop it mid-typing (which collapsed the remote grid on iOS).
const KEYBOARD_INSET_CLOSE_DELAY_MS = 300;
interface TerminalMenuState {
  canCopy: boolean;
  canPaste: boolean;
  canControlSession: boolean;
  canKillPane: boolean;
  toolbarHidden: boolean;
  mobile: boolean;
}

interface MobileControlHandlers {
  splitHorizontal: () => void;
  splitVertical: () => void;
  newWindow: () => void;
  killPane: () => void;
  stopProcess: () => void;
  clearScreen: () => void;
  reverseSearch: () => void;
  copyPane: () => void;
  copy: () => void;
  paste: () => void;
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
      () => showPrompt(host, localAccessBlockedCopy(params.endpoint), false),
      leaveShare,
    );
    connection.connect();
  };
  const copyShareLink = () => {
    const link = shareUrl(params);
    void navigator.clipboard.writeText(link)
      .then(() => view.setStatus({ connected: false, detail: 'link copied', tone: 'idle' }))
      .catch(() => view.showError(`Copy this link manually: ${link}`, 'copy failed'));
  };
  const showPrompt = (promptHost: string, copy: ConfirmationCopy, requiresPin: boolean) => {
    view.confirm(promptHost, copy, requiresPin, {
      cancel: leaveShare,
      connect: copy.action === 'copy-link' ? copyShareLink : connect,
    });
  };
  // Auto-fill the pairing code when this browser already knows it for this share
  // (the operator's own recent link), so a known PIN never re-prompts. If it is
  // absent or the daemon rejects it, the requirePin callback shows the prompt.
  const rememberedPin = recentSharePin(params);
  const connectWithCryptoCheck = (pin?: string) => {
    void checkBrowserCryptoSupport().then(
      (support) => {
        if (!support.supported) {
          showPrompt(host, browserCryptoUnavailableCopy(), false);
          return;
        }
        connect(pin);
      },
      () => showPrompt(host, browserCryptoUnavailableCopy(), false),
    );
  };
  if (shouldShowLocalAccessPrompt(params.endpoint)) {
    view.confirm(host, localAccessPromptCopy(params.endpoint), false, {
      cancel: leaveShare,
      connect: () => connectWithCryptoCheck(rememberedPin),
    });
    return;
  }
  if (shouldShowSafariLocalAccessPrompt(params.endpoint)) {
    view.confirm(host, safariLocalAccessCopy(params.endpoint), false, {
      cancel: leaveShare,
      connect: copyShareLink,
    });
    return;
  }
  connectWithCryptoCheck(rememberedPin);
}

class ShareConnection {
  private role: ShareRole;
  private socket?: WebSocket;
  private transport?: EncryptedShareTransport;
  private handshake?: ClientHandshakeState;
  private socketError = false;
  private connectionId = 0;
  private reconnectAttempt = 0;
  private reconnectTimer?: number;
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
  private shareEnded = false;
  private everReady = false;
  private sessionPaneCount = 0;
  private mobileFocusPaneId?: number;
  private mobileFocusFraction?: { w: number; h: number };
  private lastSessionView?: SessionView;
  private pendingSessionSnapshot?: Uint8Array;
  private readonly sessionHistoryGate = new SessionHistoryGate();

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
    this.clearReconnectTimer();
    this.openSocket(false);
  }

  private openSocket(reconnecting: boolean): void {
    if (this.disposed || this.shareEnded) {
      return;
    }
    this.view.setStatus({ connected: false, detail: 'connecting', tone: 'idle' });
    if (reconnecting) {
      this.view.setStatus({ connected: false, detail: DISCONNECTED_RECONNECTING, tone: 'warn' });
    }
    this.socketError = false;
    this.handshake = undefined;
    this.transport = undefined;
    const connectionId = this.connectionId + 1;
    this.connectionId = connectionId;
    const socket = new WebSocket(this.params.endpoint);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;

    socket.addEventListener('open', () => {
      if (!this.isCurrentSocket(socket, connectionId)) {
        return;
      }
      rememberLocalAccess(this.params.endpoint);
      this.view.setStatus({ connected: false, detail: 'authenticating', tone: 'idle' });
      void this.sendHello(socket);
    });
    socket.addEventListener('message', (event) => {
      if (!this.isCurrentSocket(socket, connectionId)) {
        return;
      }
      void this.handleMessage(event);
    });
    socket.addEventListener('error', () => {
      if (!this.isCurrentSocket(socket, connectionId)) {
        return;
      }
      this.socketError = true;
      if (!this.everReady && shouldShowLocalAccessBlockedHelp(this.params.endpoint)) {
        this.view.showError(connectionErrorMessage(this.params.endpoint));
        this.requestLocalAccessHelp?.();
      }
    });
    socket.addEventListener('close', (event) => {
      if (this.isCurrentSocket(socket, connectionId)) {
        this.handleClose(event);
      }
    });
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
        if (this.scope === 'pane' || this.sessionPaneCount <= 1) {
          this.endShare('Session ended', 'warn');
        }
        break;
      case 'share_revoked':
        this.terminal?.notice(`share revoked: ${message.reason}`);
        this.endShare(revokedMessage(message.reason), 'warn');
        break;
    }
  }

  private handleClose(event: CloseEvent): void {
    if (this.disposed) {
      return;
    }
    if (this.shareEnded) {
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
    if (this.shouldReconnect(event.code)) {
      this.scheduleReconnect(recovery);
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
    this.sessionPaneCount = 0;
    this.lastSessionView = undefined;
    this.pendingSessionSnapshot = undefined;
    this.sessionHistoryGate.reset();
    this.everReady = true;
    this.reconnectAttempt = 0;
    this.clearReconnectTimer();
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
        canKillPane: this.canKillActivePane(),
        toolbarHidden: this.view.toolbarHidden(),
        mobile: isMobileShareViewport(),
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
    this.view.bindMobilePaneSelect((paneId) => this.chooseMobilePane(paneId));
    this.view.onKeyboardInset((px) => this.terminal?.setKeyboardInset(px));
    this.view.bindMobileControls({
      splitHorizontal: () => this.splitPane('horizontal'),
      splitVertical: () => this.splitPane('vertical'),
      newWindow: () => this.newWindow(),
      killPane: () => this.killPane(),
      stopProcess: () => this.sendOperatorData('\u0003'),
      clearScreen: () => this.sendOperatorData('\u000c'),
      reverseSearch: () => this.sendOperatorData('\u0012'),
      copyPane: () => void this.copyFocusedPaneText(),
      copy: () => void this.copyTerminalSelection(),
      paste: () => void this.pasteIntoTerminal(),
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
      if (this.scope === 'session' && this.lastSessionView) {
        if (this.sessionHistoryGate.shouldQueueSnapshot()) {
          this.pendingSessionSnapshot = payload.slice();
        } else {
          this.pendingSessionSnapshot = undefined;
        }
        return;
      }
      this.terminal.replace(payload);
      this.scheduleTerminalViewportSync();
    } else if (opcode === SESSION_VIEW) {
      const view = parseSessionView(payload);
      if (!this.shouldApplySessionView(view)) {
        this.pendingSessionSnapshot = undefined;
        return;
      }
      const snapshot = this.pendingSessionSnapshot;
      this.pendingSessionSnapshot = undefined;
      if (snapshot) {
        this.terminal.replace(snapshot);
      }
      this.applySessionView(view);
    } else if (opcode === OUTPUT_RAW) {
      if (this.shouldSuppressSessionOutput()) {
        return;
      }
      this.terminal.write(payload);
      if (this.scope !== 'session') {
        this.scheduleTerminalViewportSync();
      }
    } else if (opcode === RESIZE_NOTIFY && payload.length === 4) {
      this.terminal.resize((payload[0] << 8) | payload[1], (payload[2] << 8) | payload[3]);
      this.scheduleTerminalViewportSync();
    }
  }

  private applySessionView(view: SessionView): void {
    if (!this.terminal) {
      return;
    }
    this.sessionPaneCount = view.panes.length;
    this.lastSessionView = view;
    if (this.mobileFocusPaneId !== undefined && !view.panes.some((pane) => pane.id === this.mobileFocusPaneId)) {
      this.mobileFocusPaneId = undefined;
      this.mobileFocusFraction = undefined;
    }
    this.terminal.setSessionView(view);
    this.view.setSessionView(view);
    this.view.setCanKillPane(this.canKillActivePane());
    rememberRecentWindowName(this.params, view);
    this.scheduleTerminalViewportSync();
    this.sessionHistoryGate.noteAppliedView(view);
  }

  private shouldApplySessionView(view: SessionView): boolean {
    if (this.scope !== 'session') {
      return true;
    }
    return this.sessionHistoryGate.shouldApplyView(view);
  }

  private shouldSuppressSessionOutput(): boolean {
    if (this.scope !== 'session') {
      return false;
    }
    return this.sessionHistoryGate.shouldSuppressOutput();
  }

  setTerminalTheme(theme: TerminalThemeName): void {
    this.terminal?.setTheme(theme, this.userTerminalTheme);
  }

  terminalPalette(): TerminalThemePalette | undefined {
    return this.userTerminalTheme;
  }

  dispose(reason = 'replaced'): void {
    this.disposed = true;
    this.clearReconnectTimer();
    if (this.logoutFallbackTimer !== undefined) {
      window.clearTimeout(this.logoutFallbackTimer);
      this.logoutFallbackTimer = undefined;
    }
    this.socket?.close(1000, reason);
    this.socket = undefined;
    this.transport = undefined;
    this.pendingSessionSnapshot = undefined;
    this.sessionHistoryGate.reset();
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
    if (this.sessionHistoryGate.noteOperatorData(data)) {
      this.terminal?.followLiveOutput();
    }
  }

  private sendPaneScroll(paneId: number, delta: number): void {
    if (this.socket?.readyState !== WebSocket.OPEN || !this.transport || this.scope !== 'session') {
      return;
    }
    const wireDelta = this.sessionHistoryGate.notePaneScroll(paneId, delta, this.lastSessionView);
    scrollSessionPane(this.transport, paneId, wireDelta);
  }

  private selectPane(paneId: number): void {
    if (this.socket?.readyState !== WebSocket.OPEN || !this.transport || this.scope !== 'session' || this.role !== 'operator') {
      return;
    }
    selectSessionPane(this.transport, paneId);
  }

  private chooseMobilePane(paneId?: number): void {
    if (this.scope !== 'session') {
      return;
    }
    // Mask the terminal across the focus-fill resize round-trip so the resizing,
    // half-rendered intermediate frame never shows; only mask on a real change.
    const changed = paneId !== this.mobileFocusPaneId;
    if (changed && isMobileShareViewport()) {
      this.terminal?.beginPaneReflow();
    }
    this.view.selectMobilePane(paneId);
    this.mobileFocusPaneId = paneId;
    // Capture the pane's size fraction once, here, so the fill resize tracks the
    // viewport but not the small per-frame jitter in the reported pane geometry
    // (which otherwise re-resized the remote on every keystroke and briefly
    // flashed the neighbouring pane).
    this.mobileFocusFraction = this.captureFocusFraction(paneId);
    if (paneId === undefined) {
      this.terminal?.showAllPanes();
    } else {
      this.terminal?.focusPane(paneId);
      this.selectPane(paneId);
    }
    // Re-drive the remote size so the focused pane fills the screen (or restore
    // the whole session on "All panes"). Only on a real change: re-tapping the
    // focused pane just raises the keyboard, and re-sending the same size would
    // round-trip a redundant resize.
    if (changed) {
      this.lastResizeRequest = undefined;
      this.syncOperatorBrowserSize();
    }
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
    if (!this.canKillActivePane()) {
      return;
    }
    const socket = this.openSessionOperatorSocket();
    if (socket) {
      killSessionPane(socket);
    }
  }

  private canKillActivePane(): boolean {
    return this.scope === 'session' && this.sessionPaneCount > 1;
  }

  private endShare(detail: string, tone: ShareStatus['tone']): void {
    this.shareEnded = true;
    this.clearReconnectTimer();
    markRecentShareUnavailable(this.params);
    // The session is over (revoked / expired / gone): drop the refresh-resilience
    // copy of the token so a reload does not re-attempt a dead credential.
    clearActiveShareParams();
    this.view.setCanKillPane(false);
    this.view.setStatus({ connected: false, detail, tone });
    this.transport = undefined;
    this.socket?.close(1000, 'share_ended');
    this.socket = undefined;
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
    // Prefer a native long-press selection (mobile) over xterm's mouse selection.
    const native = window.getSelection()?.toString() ?? '';
    const selected = native || this.terminal?.selection() || '';
    if (selected) {
      try {
        await copyText(selected);
      } catch {
        // Clipboard failures are browser-policy dependent; keep the terminal session intact.
      }
    }
  }

  private async copyFocusedPaneText(): Promise<void> {
    // One-tap copy of the focused pane's on-screen text, for when native
    // long-press selection is awkward over the zoomed terminal on mobile.
    const text = this.terminal?.focusedPaneText() ?? '';
    if (!text) {
      return;
    }
    try {
      await copyText(text);
      this.terminal?.notice('Pane copied');
    } catch {
      // Clipboard failures are browser-policy dependent; keep the session intact.
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
    const fit = this.terminal.fitSize();
    if (!fit) {
      return;
    }
    const size = this.focusFillSize(fit) ?? fit;
    const last = this.lastResizeRequest;
    if (
      last
      && Math.abs(last.cols - size.cols) <= RESIZE_HYSTERESIS_CELLS
      && Math.abs(last.rows - size.rows) <= RESIZE_HYSTERESIS_CELLS
    ) {
      return;
    }
    this.lastResizeRequest = size;
    sendResizeRequest(this.transport, size.cols, size.rows);
  }

  // When a single pane is focused on mobile, the browser can only show the rows
  // it actually receives, so it cannot fill the empty space locally. Instead,
  // ask rmux to grow the session so the focused pane occupies the whole viewport
  // at its natural character size; "All panes" restores the normal fit.
  private focusFillSize(fit: { cols: number; rows: number }): { cols: number; rows: number } | undefined {
    const fraction = this.mobileFocusFraction;
    if (this.mobileFocusPaneId === undefined || !isMobileShareViewport() || !fraction) {
      return undefined;
    }
    return {
      cols: clampFocusFill(Math.round(fit.cols / fraction.w), fit.cols),
      rows: clampFocusFill(Math.round(fit.rows / fraction.h), fit.rows),
    };
  }

  private captureFocusFraction(paneId?: number): { w: number; h: number } | undefined {
    if (paneId === undefined || !this.lastSessionView) {
      return undefined;
    }
    const pane = this.lastSessionView.panes.find((candidate) => candidate.id === paneId);
    if (!pane) {
      return undefined;
    }
    const w = pane.cols / Math.max(1, this.lastSessionView.size.cols);
    const h = pane.rows / Math.max(1, this.lastSessionView.size.rows);
    return w > 0 && h > 0 ? { w, h } : undefined;
  }

  private isCurrentSocket(socket: WebSocket, connectionId: number): boolean {
    return this.socket === socket && this.connectionId === connectionId;
  }

  private shouldReconnect(code: number): boolean {
    if (!this.everReady && this.socketError && shouldShowLocalAccessBlockedHelp(this.params.endpoint)) {
      return false;
    }
    return code === 1001 || code === 1006 || code === 1011 || code === 4001;
  }

  private scheduleReconnect(message: string): void {
    if (this.disposed || this.shareEnded || this.reconnectTimer !== undefined) {
      return;
    }
    markRecentShareDisconnected(this.params);
    this.view.setCanKillPane(false);
    this.view.setStatus({ connected: false, detail: DISCONNECTED_RECONNECTING, tone: 'warn' });
    this.terminal?.notice(message);
    const delay = Math.min(
      RECONNECT_MAX_DELAY_MS,
      RECONNECT_BASE_DELAY_MS * (2 ** Math.min(this.reconnectAttempt, 5)),
    );
    this.reconnectAttempt += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined;
      this.openSocket(true);
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== undefined) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
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
  private readonly mobileActions: HTMLButtonElement;
  private readonly mobilePaneSelectRow: HTMLElement;
  private readonly mobilePaneSelect: HTMLButtonElement;
  private readonly mobilePaneCurrent: HTMLElement;
  private readonly mobileControlMenu: HTMLElement;
  private readonly mobileSplitHorizontal: HTMLButtonElement;
  private readonly mobileSplitVertical: HTMLButtonElement;
  private readonly mobileNewWindow: HTMLButtonElement;
  private readonly mobileKillPane: HTMLButtonElement;
  private readonly mobileStopProcess: HTMLButtonElement;
  private readonly mobileClearScreen: HTMLButtonElement;
  private readonly mobileReverseSearch: HTMLButtonElement;
  private readonly mobileCopyPane: HTMLButtonElement;
  private readonly mobileCopy: HTMLButtonElement;
  private readonly mobilePaste: HTMLButtonElement;
  private readonly viewers: HTMLElement;
  private readonly viewersCount: HTMLElement;
  private readonly sessionMenuButton: HTMLButtonElement;
  private readonly windowMenu: HTMLElement;
  private readonly windowNew: HTMLButtonElement;
  private readonly windowEdit: HTMLButtonElement;
  private readonly windowKill: HTMLButtonElement;
  private readonly mobilePaneMenu: HTMLElement;
  private readonly mobilePaneTitle: HTMLElement;
  private readonly mobilePaneList: HTMLElement;
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
  private keyboardInsetHandler?: (px: number) => void;
  private dialogKeyboardCleanup?: () => void;
  private readonly pinMaskTimers: Array<number | undefined> = [];
  private readonly pinBoxDigits: Array<string | undefined> = [];
  private pinSubmitted = false;
  private connected = false;
  private canLogout = false;
  private viewerCountVisible = false;
  private sessionControlVisible = false;
  private canKillPane = false;
  private windows: SessionWindowView[] = [];
  private panes: SessionPaneView[] = [];
  private selectedWindowIndex?: number;
  private selectedPaneId?: number;
  private mobileShowAllPanes = true;
  private detachHandler?: () => void;
  private logoutHandler?: () => void;
  private copyTerminalHandler?: () => void | Promise<void>;
  private pasteTerminalHandler?: () => void | Promise<void>;
  private toggleToolbarHandler?: () => void;
  private mobilePaneSelectHandler?: (paneId?: number) => void;
  private mobileControlHandlers?: MobileControlHandlers;
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
    // On mobile the "SHARE" link is hidden, so the RMUX brand itself returns to
    // the share dashboard (share.rmux.io) rather than the marketing site.
    const brandHome = query<HTMLAnchorElement>(root, '.share-brand-home');
    if (isMobileShareViewport()) {
      brandHome.href = shareBasePath();
      brandHome.addEventListener('click', () => clearActiveShareParams());
    }
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
    this.mobileActions = query(root, '[data-share-mobile-actions]');
    this.mobilePaneSelectRow = query(root, '[data-share-mobile-pane-select-row]');
    this.mobilePaneSelect = query(root, '[data-share-mobile-pane-select]');
    this.mobilePaneCurrent = query(root, '[data-share-mobile-pane-current]');
    this.mobileControlMenu = query(root, '[data-share-mobile-control-menu]');
    this.mobileSplitHorizontal = query(root, '[data-share-mobile-split-horizontal]');
    this.mobileSplitVertical = query(root, '[data-share-mobile-split-vertical]');
    this.mobileNewWindow = query(root, '[data-share-mobile-new-window]');
    this.mobileKillPane = query(root, '[data-share-mobile-kill-pane]');
    this.mobileStopProcess = query(root, '[data-share-mobile-stop-process]');
    this.mobileClearScreen = query(root, '[data-share-mobile-clear-screen]');
    this.mobileReverseSearch = query(root, '[data-share-mobile-reverse-search]');
    this.mobileCopyPane = query(root, '[data-share-mobile-copy-pane]');
    this.mobileCopy = query(root, '[data-share-mobile-copy]');
    this.mobilePaste = query(root, '[data-share-mobile-paste]');
    this.viewers = query(root, '[data-share-viewers]');
    this.viewersCount = query(root, '[data-share-viewers-count]');
    this.sessionMenuButton = query(root, '[data-share-session-menu]');
    this.windowMenu = query(root, '[data-share-window-menu]');
    this.windowNew = query(root, '[data-share-window-new]');
    this.windowEdit = query(root, '[data-share-window-edit]');
    this.windowKill = query(root, '[data-share-window-kill]');
    this.mobilePaneMenu = query(root, '[data-share-mobile-pane-menu]');
    this.mobilePaneTitle = query(root, '[data-share-mobile-pane-title]');
    this.mobilePaneList = query(root, '[data-share-mobile-pane-list]');
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
    this.mobileActions.addEventListener('click', () => {
      const rect = this.mobileActions.getBoundingClientRect();
      this.openMobileControlMenu(rect.left, rect.bottom + 8);
    });
    this.mobilePaneSelect.addEventListener('click', () => {
      const rect = this.mobilePaneSelect.getBoundingClientRect();
      this.openMobilePaneMenu(rect.left, rect.bottom + 8);
    });
    this.mobileSplitHorizontal.addEventListener('click', () => this.runMobileControl('splitHorizontal'));
    this.mobileSplitVertical.addEventListener('click', () => this.runMobileControl('splitVertical'));
    this.mobileNewWindow.addEventListener('click', () => this.runMobileControl('newWindow'));
    this.mobileKillPane.addEventListener('click', () => this.runMobileControl('killPane'));
    this.mobileStopProcess.addEventListener('click', () => this.runMobileControl('stopProcess'));
    this.mobileClearScreen.addEventListener('click', () => this.runMobileControl('clearScreen'));
    this.mobileReverseSearch.addEventListener('click', () => this.runMobileControl('reverseSearch'));
    this.mobileCopyPane.addEventListener('click', () => this.runMobileControl('copyPane'));
    this.mobileCopy.addEventListener('click', () => this.runMobileControl('copy'));
    this.mobilePaste.addEventListener('click', () => this.runMobileControl('paste'));
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
      if (
        target
        && !this.mobilePaneMenu.hidden
        && !this.mobilePaneMenu.contains(target)
        && !this.mobilePaneSelect.contains(target)
      ) {
        this.closeMobilePaneMenu();
      }
      if (
        target
        && !this.mobileControlMenu.hidden
        && !this.mobileControlMenu.contains(target)
        && !this.mobileActions.contains(target)
      ) {
        this.closeMobileControlMenu();
      }
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        this.closeWindowMenu();
        this.closeTerminalMenu();
        this.closeMobilePaneMenu();
        this.closeMobileControlMenu();
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
    this.confirmDialog.addEventListener('close', () => this.unbindDialogKeyboard());
    this.pinInput.addEventListener('input', () => this.syncPinEntry());
    this.pinInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') {
        return;
      }
      event.preventDefault();
      this.tryAutoSubmitPin();
    });
    this.bindKeyboardInsets();
  }

  // While the on-screen keyboard is open, lift the terminal above it (via a
  // bottom inset the stylesheet consumes) so the pane being typed in stays
  // visible. The app keeps its full height so the top bar never scrolls off.
  private bindKeyboardInsets(): void {
    const viewport = window.visualViewport;
    if (!viewport) {
      return;
    }
    let currentInset = 0;
    let closeTimer: number | undefined;
    const commit = (inset: number) => {
      if (closeTimer !== undefined) {
        window.clearTimeout(closeTimer);
        closeTimer = undefined;
      }
      currentInset = inset;
      this.app.style.setProperty('--keyboard-inset', `${inset}px`);
      // Keep the remote grid keyboard-independent so opening the keyboard does not
      // resize the session and jump the focused pane. (this.terminal here is the
      // DOM container; the xterm controller lives on ShareConnection.)
      this.keyboardInsetHandler?.(inset);
    };
    // Keyboard height = layout viewport minus the visible viewport. Do NOT subtract
    // visualViewport.offsetTop: iOS scrolls the layout viewport under the keyboard on
    // every keystroke, spiking offsetTop, which made the keyboard look briefly closed
    // and zeroed the inset mid-typing — collapsing the remote grid (and the whole
    // terminal) on each key, then snapping back ~1s later. A pinch-zoom (scale > 1)
    // also shrinks the visible viewport with no keyboard, so ignore it.
    const keyboardHeight = () =>
      viewport.scale > 1.01 ? 0 : Math.max(0, Math.round(window.innerHeight - viewport.height));
    const apply = () => {
      const onMobile = this.connected && !this.confirmDialog.open && isMobileShareViewport();
      const keyboard = keyboardHeight();
      const target = onMobile && keyboard > 90 ? keyboard : 0;
      if (target >= currentInset || !onMobile) {
        // Opening/growing, or a hard close (disconnected, dialog open, desktop):
        // apply immediately so the lift tracks the keyboard with no lag.
        commit(target);
        return;
      }
      // Shrinking or closing while the keyboard is up: defer a single re-measure.
      // A genuine close is sustained and still lands; a transient recovers (a grow
      // event commits immediately and cancels this, or the re-measure finds the
      // keyboard still open and holds the inset), so it never shrinks the grid
      // mid-typing. Re-measuring at fire time keeps it both non-stale and non-stuck.
      if (closeTimer === undefined) {
        closeTimer = window.setTimeout(() => {
          closeTimer = undefined;
          const settledMobile = this.connected && !this.confirmDialog.open && isMobileShareViewport();
          const settledKeyboard = keyboardHeight();
          commit(settledMobile && settledKeyboard > 90 ? settledKeyboard : 0);
        }, KEYBOARD_INSET_CLOSE_DELAY_MS);
      }
    };
    apply();
    viewport.addEventListener('resize', apply);
    viewport.addEventListener('scroll', apply);
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
      this.bindDialogKeyboard();
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

  bindMobilePaneSelect(handler: (paneId?: number) => void): void {
    this.mobilePaneSelectHandler = handler;
  }

  bindMobileControls(handlers: MobileControlHandlers): void {
    this.mobileControlHandlers = handlers;
  }

  onKeyboardInset(handler: (px: number) => void): void {
    this.keyboardInsetHandler = handler;
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
    this.setCanKillPane(false);
    this.panes = [];
    this.selectedPaneId = undefined;
    this.mobileShowAllPanes = true;
    this.mobileActions.hidden = true;
    this.mobilePaneSelectRow.hidden = true;
    this.closeMobilePaneMenu();
    this.closeMobileControlMenu();
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

  setCanKillPane(visible: boolean): void {
    this.canKillPane = visible;
    this.updateSessionControlsVisibility();
  }

  setSessionView(view: SessionView): void {
    this.windows = normalizeWindows(view.windows);
    if (this.selectedWindowIndex === undefined || !this.windows.some((window) => window.index === this.selectedWindowIndex)) {
      this.selectedWindowIndex = this.activeWindow()?.index;
    }
    this.panes = normalizePanes(view.panes);
    this.ensureMobilePaneSelection();
    this.renderMobilePaneMenu();
    this.updateMobilePaneSelect();
    this.updateSessionControlsVisibility();
  }

  // A pane is "focused" only when more than one pane exists and a still-present
  // pane is selected; every other case (single pane, fresh split, focused pane
  // closed) falls back to showing all panes so the picker label matches the
  // grid the operator actually sees.
  private ensureMobilePaneSelection(): void {
    const hasSelection = this.panes.length > 1
      && this.selectedPaneId !== undefined
      && this.panes.some((pane) => pane.id === this.selectedPaneId);
    this.mobileShowAllPanes = !hasSelection;
    if (!hasSelection) {
      this.selectedPaneId = undefined;
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

  selectMobilePane(paneId?: number): void {
    if (paneId === undefined) {
      this.mobileShowAllPanes = true;
      this.selectedPaneId = undefined;
      this.renderMobilePaneMenu();
      this.updateMobilePaneSelect();
      return;
    }
    if (!this.panes.some((pane) => pane.id === paneId)) {
      return;
    }
    this.mobileShowAllPanes = false;
    this.selectedPaneId = paneId;
    this.renderMobilePaneMenu();
    this.updateMobilePaneSelect();
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

  openMobilePaneMenu(x: number, y: number): void {
    this.closeTerminalMenu();
    this.closeWindowMenu();
    this.closeMobileControlMenu();
    if (!this.connected || this.panes.length === 0) {
      this.closeMobilePaneMenu();
      return;
    }
    this.renderMobilePaneMenu();
    this.mobilePaneMenu.hidden = false;
    const rect = this.mobilePaneMenu.getBoundingClientRect();
    const left = Math.min(Math.max(8, x), window.innerWidth - rect.width - 8);
    const top = Math.min(Math.max(8, y), window.innerHeight - rect.height - 8);
    this.mobilePaneMenu.style.left = `${left}px`;
    this.mobilePaneMenu.style.top = `${top}px`;
  }

  openTerminalMenu(x: number, y: number, state: TerminalMenuState): void {
    this.closeWindowMenu();
    this.closeMobileControlMenu();
    this.closeMobilePaneMenu();
    if (!this.connected) {
      this.closeTerminalMenu();
      return;
    }
    const canControlSession = this.connected && state.canControlSession && !state.mobile;
    const canKillPane = canControlSession && state.canKillPane;
    this.terminalCopy.disabled = !state.canCopy;
    this.terminalPaste.disabled = !this.connected || !state.canPaste;
    this.terminalShowToolbar.hidden = state.mobile;
    this.terminalToolbarLabel.textContent = state.toolbarHidden ? 'Show toolbar' : 'Hide toolbar';
    this.terminalControlsSeparator.hidden = !canControlSession;
    this.terminalControls.hidden = !canControlSession;
    this.terminalKillPane.hidden = !canKillPane;
    this.terminalKillPane.disabled = !canKillPane;
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
    if (!state.mobile) {
      first?.focus();
    }
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

  private closeMobilePaneMenu(): void {
    this.mobilePaneMenu.hidden = true;
  }

  private openMobileControlMenu(x: number, y: number): void {
    this.closeTerminalMenu();
    this.closeWindowMenu();
    this.closeMobilePaneMenu();
    if (!this.connected || !this.sessionControlVisible) {
      this.closeMobileControlMenu();
      return;
    }
    this.mobileKillPane.hidden = !this.canKillPane;
    this.mobileControlMenu.hidden = false;
    const rect = this.mobileControlMenu.getBoundingClientRect();
    const left = Math.min(Math.max(8, x), window.innerWidth - rect.width - 8);
    const top = Math.min(Math.max(8, y), window.innerHeight - rect.height - 8);
    this.mobileControlMenu.style.left = `${left}px`;
    this.mobileControlMenu.style.top = `${top}px`;
  }

  private closeMobileControlMenu(): void {
    this.mobileControlMenu.hidden = true;
  }

  private runTerminalSessionControl(handler?: () => void): void {
    this.closeTerminalMenu();
    if (this.connected) {
      handler?.();
    }
  }

  private runMobileControl(action: keyof MobileControlHandlers): void {
    this.closeMobileControlMenu();
    if (!this.connected || !this.sessionControlVisible) {
      return;
    }
    this.mobileControlHandlers?.[action]();
  }

  private setTerminalShortcuts(): void {
    const primary = primaryShortcutLabel();
    this.terminalCopyShortcut.textContent = `${primary}C`;
    this.terminalPasteShortcut.textContent = `${primary}V`;
  }

  private activeWindow(): SessionWindowView | undefined {
    return this.windows.find((window) => window.active);
  }

  private activePane(): SessionPaneView | undefined {
    return this.panes.find((pane) => pane.active) ?? (this.panes.length === 1 ? this.panes[0] : undefined);
  }

  private renderMobilePaneMenu(): void {
    this.mobilePaneTitle.textContent = this.activeWindow()
      ? `Window ${this.activeWindow()?.index}:${this.activeWindow()?.name}`
      : 'Session panes';
    const items: HTMLElement[] = this.panes.map((pane) => this.renderMobilePaneButton(pane));
    if (this.panes.length > 1) {
      items.unshift(this.renderShowAllPanesButton());
    }
    // The session view only carries the active window's panes, so list every
    // other window with a "switch" entry — picking it jumps there (and lands in
    // all-panes), at which point its own panes appear in this menu.
    for (const window of this.windows) {
      if (window.active) {
        continue;
      }
      items.push(this.renderWindowHeader(window), this.renderWindowSwitchButton(window));
    }
    this.mobilePaneList.replaceChildren(...items);
  }

  private renderWindowHeader(window: SessionWindowView): HTMLElement {
    const header = document.createElement('div');
    header.className = 'share-mobile-pane-menu-title share-mobile-pane-window-header';
    header.textContent = `Window ${window.index}:${window.name}`;
    return header;
  }

  private renderWindowSwitchButton(window: SessionWindowView): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.role = 'menuitem';
    const label = document.createElement('span');
    label.className = 'share-mobile-pane-label';
    label.textContent = 'All panes';
    const meta = document.createElement('span');
    meta.className = 'share-mobile-pane-meta';
    meta.textContent = 'Switch';
    button.append(label, meta);
    button.addEventListener('click', () => {
      this.closeMobilePaneMenu();
      this.selectWindow(window.index);
    });
    return button;
  }

  private renderShowAllPanesButton(): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.role = 'menuitem';
    button.dataset.selected = String(this.mobileShowAllPanes);
    const label = document.createElement('span');
    label.className = 'share-mobile-pane-label';
    label.textContent = 'All panes';
    const meta = document.createElement('span');
    meta.className = 'share-mobile-pane-meta';
    meta.textContent = `${this.panes.length} panes`;
    button.append(label, meta);
    button.addEventListener('click', () => {
      this.closeMobilePaneMenu();
      this.selectMobilePane(undefined);
      this.mobilePaneSelectHandler?.(undefined);
    });
    return button;
  }

  private renderMobilePaneButton(pane: SessionPaneView): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.role = 'menuitem';
    button.dataset.paneId = String(pane.id);
    button.dataset.active = String(pane.active === true);
    button.dataset.selected = String(!this.mobileShowAllPanes && pane.id === this.selectedPaneId);
    const label = document.createElement('span');
    label.className = 'share-mobile-pane-label';
    label.textContent = `Pane %${pane.id}`;
    const meta = document.createElement('span');
    meta.className = 'share-mobile-pane-meta';
    meta.textContent = pane.active ? 'active' : `${pane.cols}x${pane.rows}`;
    button.append(label, meta);
    button.addEventListener('click', () => {
      this.closeMobilePaneMenu();
      this.selectMobilePane(pane.id);
      this.mobilePaneSelectHandler?.(pane.id);
    });
    return button;
  }

  private updateSessionControlsVisibility(): void {
    const visible = this.connected && this.sessionControlVisible;
    this.sessionControls.hidden = !visible;
    this.killPane.hidden = !visible || !this.canKillPane;
    this.killPane.disabled = !visible || !this.canKillPane;
    if (!this.connected) {
      this.closeMobilePaneMenu();
      this.closeMobileControlMenu();
    }
    this.mobileActions.hidden = !visible;
    // Show the picker when there is something to pick: more than one pane, or
    // more than one window (so you can switch windows from it).
    this.mobilePaneSelectRow.hidden = !this.connected || (this.panes.length <= 1 && this.windows.length <= 1);
    this.updateMobilePaneSelect();
  }

  private updateMobilePaneSelect(): void {
    if (!this.panes.length) {
      this.mobilePaneCurrent.textContent = 'No panes';
      return;
    }
    if (this.mobileShowAllPanes && this.panes.length > 1) {
      this.mobilePaneCurrent.textContent = 'All panes';
      return;
    }
    const pane = this.panes.find((candidate) => candidate.id === this.selectedPaneId)
      ?? this.activePane()
      ?? this.panes[0];
    this.mobilePaneCurrent.textContent = `Pane %${pane.id}`;
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
      // Mark the next empty box so a blinking caret can show where input is expected.
      box.dataset.caret = String(index === normalized.length);
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

  // On mobile the on-screen keyboard slides up over the bottom of a centered
  // dialog and hides the pairing-code boxes. Anchor the dialog to the top of
  // the (keyboard-shrunk) visual viewport and reveal the boxes so the operator
  // can always see what they type.
  private bindDialogKeyboard(): void {
    this.unbindDialogKeyboard();
    const viewport = window.visualViewport;
    if (!viewport) {
      return;
    }
    const margin = 8;
    const apply = () => {
      if (!this.confirmDialog.open || this.confirmDialog.dataset.pin !== 'true') {
        return;
      }
      if (viewport.height >= window.innerHeight - 80) {
        this.clearDialogKeyboardOffset();
        return;
      }
      const style = this.confirmDialog.style;
      style.position = 'fixed';
      style.margin = '0';
      style.left = '50%';
      style.transform = 'translateX(-50%)';
      style.top = `${viewport.offsetTop + margin}px`;
      style.bottom = 'auto';
      style.maxHeight = `${Math.max(200, viewport.height - margin * 2)}px`;
    };
    const reveal = () => {
      apply();
      if (this.confirmDialog.open && this.confirmDialog.dataset.pin === 'true') {
        this.pinBoxes.scrollIntoView({ block: 'nearest' });
      }
    };
    // The keyboard animates the viewport height over several frames and can
    // settle after the timed reveals below. 'resize' (keyboard show/hide/rotate)
    // re-reveals the boxes; 'scroll' (viewport pan) only repositions so it does
    // not fight the user.
    viewport.addEventListener('resize', reveal);
    viewport.addEventListener('scroll', apply);
    this.dialogKeyboardCleanup = () => {
      viewport.removeEventListener('resize', reveal);
      viewport.removeEventListener('scroll', apply);
    };
    window.setTimeout(reveal, 60);
    window.setTimeout(reveal, 240);
  }

  private unbindDialogKeyboard(): void {
    this.dialogKeyboardCleanup?.();
    this.dialogKeyboardCleanup = undefined;
    this.clearDialogKeyboardOffset();
  }

  private clearDialogKeyboardOffset(): void {
    const style = this.confirmDialog.style;
    style.removeProperty('position');
    style.removeProperty('margin');
    style.removeProperty('left');
    style.removeProperty('transform');
    style.removeProperty('top');
    style.removeProperty('bottom');
    style.removeProperty('max-height');
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

function revokedMessage(reason: string): string {
  switch (reason) {
    case 'pane_gone':
    case 'session_gone':
      return 'Session ended';
    case 'ttl_expired':
      return 'Share expired';
    case 'stopped_by_owner':
      return 'Share stopped by owner';
    default:
      return 'Share ended';
  }
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

function normalizePanes(panes: SessionPaneView[]): SessionPaneView[] {
  return panes
    .filter((pane) => Number.isInteger(pane.id) && pane.id >= 0)
    .map((pane) => ({
      ...pane,
      active: Boolean(pane.active),
      cols: Math.max(1, Math.floor(pane.cols)),
      rows: Math.max(1, Math.floor(pane.rows)),
      x: Math.max(0, Math.floor(pane.x)),
      y: Math.max(0, Math.floor(pane.y)),
    }))
    .sort((left, right) => (left.y - right.y) || (left.x - right.x) || (left.id - right.id));
}

function finiteCount(value: number | undefined): number | undefined {
  return value === undefined || !Number.isFinite(value)
    ? undefined
    : Math.max(0, Math.floor(value));
}

function isMobileShareViewport(): boolean {
  return window.matchMedia('(max-width: 760px) and (pointer: coarse)').matches;
}

// Never shrink below the viewport fit, and cap growth so a tiny pane cannot blow
// the session up without bound (a half-split needs 2x, a quarter needs 4x).
function clampFocusFill(value: number, base: number): number {
  return Math.max(base, Math.min(value, base * 4));
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

// Address-bar hygiene only: strips the token from the visible URL and history so
// it is not shoulder-surfed, screenshotted, or copied from the bar. NOT a security
// boundary — the token is already known to this origin's JS and is kept in
// sessionStorage for reconnects.
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
