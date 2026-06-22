import { ImageAddon } from '@xterm/addon-image';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import type { IDisposable } from '@xterm/xterm';

import type {
  PaneResizeDirection,
  SessionPaneView,
  SessionView,
  SessionWindowView,
  ShareRole,
  ShareScope,
  TerminalThemeName,
  TerminalThemePalette,
} from './types';

export type { TerminalThemeName } from './types';
export type TerminalThemeMode = 'dark' | 'light';

export const DEFAULT_TERMINAL_THEME: TerminalThemeName = 'user';
const SESSION_SCROLLBACK_LINES = 0;
const PANE_SCROLLBACK_LINES = 10_000;
const BOTTOM_STICKY_THRESHOLD_PX = 8;
const WHEEL_PIXEL_LINE = 16;
const IMAGE_PIXEL_LIMIT = 4_194_304;
const IMAGE_SEQUENCE_LIMIT = 8_000_000;
const IMAGE_STORAGE_MB = 48;
const MIN_TERMINAL_COLS = 2;
const MIN_TERMINAL_ROWS = 2;
const MAX_DIVIDER_DRAG_CELLS = 10_000;
const DIVIDER_HIT_SLOP_CELLS = 0.75;
const MOBILE_PANE_QUERY = '(max-width: 760px) and (pointer: coarse)';
// A phone held in landscape: wide but short. The (max-width:760px) mobile query is
// false here, so this is a separate predicate keyed off short height + touch. Used
// to grow the grid + enable the view-pan so a full-screen app's whole UI is reachable.
const SHORT_LANDSCAPE_QUERY = '(pointer: coarse) and (orientation: landscape) and (max-height: 480px)';
// How many extra rows above the natural fit the tall-view grid asks the daemon for,
// so a full-screen app draws more of its UI than the viewport shows and the user can
// pan up to reach the cut-off top. Bounded by a hard cap so a short app can't end up
// with a huge empty pan range. A conversation longer than the cap still can't show
// its very top without the app's own scroll — that's the inherent limit of a window.
const TALL_VIEW_HEADROOM_ROWS = 18;
const TALL_VIEW_MAX_ROWS = 44;
const TOUCH_SCROLL_THRESHOLD_PX = 8;
const PANE_TAP_MOVE_THRESHOLD_PX = 6;
// Focused panes zoom to fill the width, but capped so a very narrow split pane
// stays a comfortable reading size instead of becoming oversized. Panes wider
// than ~1/1.8 of the screen still fill it; narrower ones top out here.
const MOBILE_PANE_FILL_MAX_SCALE = 1.8;

export interface TerminalChromePalette {
  accent: string;
  background: string;
  foreground: string;
  mode: TerminalThemeMode;
}

export interface ShareTerminal {
  role: ShareRole;
  term: Terminal;
  fitSize(): { cols: number; rows: number } | undefined;
  setKeyboardInset(px: number): void;
  syncViewport(): void;
  setRole(role: ShareRole): void;
  setTheme(theme: TerminalThemeName, userTheme?: TerminalThemePalette): void;
  replace(data: Uint8Array): void;
  write(data: Uint8Array): void;
  followLiveOutput(): void;
  resize(cols: number, rows: number): void;
  setSessionView(view: SessionView): void;
  focusPane(paneId?: number): void;
  showAllPanes(): void;
  beginPaneReflow(): void;
  dispose(): void;
  onData(callback: (data: string) => void): void;
  onPaneSelect(callback: (paneId: number) => void): void;
  onPaneResize(callback: (paneId: number, direction: PaneResizeDirection, cells: number) => void): void;
  onPaneScroll(callback: (paneId: number, delta: number) => void): void;
  onTerminalMenu(callback: (x: number, y: number) => void): void;
  onWindowSelect(callback: (windowIndex: number) => void): void;
  onWindowMenu(callback: (windowIndex: number, x: number, y: number) => void): void;
  selection(): string;
  focusedPaneText(): string;
  focus(): void;
  notice(text: string): void;
}

export function openShareTerminal(
  container: HTMLElement,
  scope: ShareScope,
  role: ShareRole,
  cols: number,
  rows: number,
  theme: TerminalThemeName = DEFAULT_TERMINAL_THEME,
  userTheme?: TerminalThemePalette,
): ShareTerminal {
  const controller = new XtermShareTerminal(container, scope, role, theme, userTheme);
  controller.open();
  controller.bindLocalWheelScroll();
  controller.bindViewPanScrollbar();
  controller.resize(cols, rows);
  if (role === 'operator' && !window.matchMedia(MOBILE_PANE_QUERY).matches) {
    controller.term.focus();
  }
  return controller;
}

type DividerAxis = 'vertical' | 'horizontal';

interface PaneDivider {
  axis: DividerAxis;
  paneId: number;
}

interface PaneResizeDrag {
  divider: PaneDivider;
  startX: number;
  startY: number;
  appliedCells: number;
}

interface SessionPoint {
  col: number;
  row: number;
}

// rmux re-renders the whole session screen on every frame and prefixes it with a
// screen clear — the snapshot form is ESC[3J ESC[2J, and the live attach form is
// ESC[H ESC[2J (zoomed/full redraw). xterm processes the write asynchronously and
// can paint the *cleared* screen a frame before the redraw lands, flashing the
// terminal blank on every keystroke. Because each frame is a full cursor-addressed
// redraw, dropping the erase lets the new frame overwrite the old one in place with
// no blank. Match either erase (ESC[2J / ESC[3J) wherever it appears; the harmless
// ESC[H home and ESC[0m reset are kept so the redraw still starts from the top.
const SCREEN_ERASE = /\x1b\[[23]J/g;

function withoutScreenClear(text: string): string {
  return text.replace(SCREEN_ERASE, '');
}

class XtermShareTerminal implements ShareTerminal {
  readonly term: Terminal;
  role: ShareRole;

  private readonly decoder = new TextDecoder();
  private readonly stage: HTMLDivElement;
  private readonly scrollLayer: HTMLDivElement;
  private readonly focusLayer: HTMLDivElement;
  private readonly disposables: IDisposable[] = [];
  private stickToBottom = true;
  private operationQueue = Promise.resolve();
  private disposed = false;
  private lastSnapshotText?: string;
  private remoteCols = 0;
  private remoteRows = 0;
  private snapshotCols = 0;
  private snapshotRows = 0;
  private operatorCols = 0;
  private operatorRows = 0;
  private sessionView?: SessionView;
  private readonly mobilePaneMedia: MediaQueryList;
  private mobilePaneId?: number;
  private mobileShowAllPanes = true;
  private dataHandler?: (data: string) => void;
  private paneScrollHandler?: (paneId: number, delta: number) => void;
  private paneResizeHandler?: (paneId: number, direction: PaneResizeDirection, cells: number) => void;
  private paneResizeDrag?: PaneResizeDrag;
  private touchScroll?: { paneId: number; lastY: number; remainder: number };
  private touchPending?: { paneId: number; startY: number; lastY: number; pointerId: number };
  private lastStageTransform?: string;
  private lastStageClip?: string;
  private readonly reflowMask: HTMLDivElement;
  private reflowing = false;
  private reflowRevealTimer?: number;
  private reflowHardTimer?: number;
  private keyboardInset = 0;
  // Tier B "see the whole terminal in landscape": for a single full-screen
  // (alternate-screen) app on a short landscape phone the grid is grown taller than
  // the viewport, and the user pans the VIEW vertically to reach the top. sessionPanY
  // is the vertical view offset in px (0 = top of content); followBottom keeps the
  // view pinned to the bottom (where the cursor/input is) until the user pans up.
  private readonly landscapeMedia: MediaQueryList;
  private sessionPanY = 0;
  private sessionMaxPan = 0;
  private sessionPanFollowBottom = true;
  private viewPanPending?: { startY: number; lastY: number; pointerId: number };
  private viewPanning = false;
  private readonly viewPanBar: HTMLDivElement;
  private readonly viewPanThumb: HTMLDivElement;

  constructor(
    private readonly container: HTMLElement,
    private readonly scope: ShareScope,
    role: ShareRole,
    theme: TerminalThemeName,
    private userTheme?: TerminalThemePalette,
  ) {
    this.role = role;
    this.mobilePaneMedia = window.matchMedia(MOBILE_PANE_QUERY);
    this.landscapeMedia = window.matchMedia(SHORT_LANDSCAPE_QUERY);
    this.term = new Terminal(optionsForRole(
      role,
      theme,
      userTheme,
      scope === 'session' ? SESSION_SCROLLBACK_LINES : PANE_SCROLLBACK_LINES,
    ));
    this.term.loadAddon(
      new ImageAddon({
        enableSizeReports: false,
        iipSizeLimit: IMAGE_SEQUENCE_LIMIT,
        iipSupport: true,
        pixelLimit: IMAGE_PIXEL_LIMIT,
        sixelSizeLimit: IMAGE_SEQUENCE_LIMIT,
        sixelSupport: true,
        storageLimit: IMAGE_STORAGE_MB,
      }),
    );
    this.term.loadAddon(new WebLinksAddon());
    container.replaceChildren();
    this.stage = document.createElement('div');
    this.stage.className = 'share-terminal-stage';
    this.focusLayer = document.createElement('div');
    this.focusLayer.className = 'share-pane-focus-layer';
    this.scrollLayer = document.createElement('div');
    this.scrollLayer.className = 'share-pane-scroll-layer';
    this.reflowMask = document.createElement('div');
    this.reflowMask.className = 'share-terminal-reflow-mask';
    this.reflowMask.setAttribute('aria-hidden', 'true');
    // The view-pan scrollbar lives on the container (NOT the stage), so it stays put
    // while the stage translates under it. Hidden unless the tall-landscape view-pan
    // is active.
    this.viewPanBar = document.createElement('div');
    this.viewPanBar.className = 'share-view-pan-scrollbar';
    this.viewPanBar.hidden = true;
    this.viewPanThumb = document.createElement('div');
    this.viewPanThumb.className = 'share-view-pan-scrollbar-thumb';
    this.viewPanBar.append(this.viewPanThumb);
    container.append(this.stage);
    container.append(this.reflowMask);
    container.append(this.viewPanBar);
    this.setTheme(theme, userTheme);
    this.term.attachCustomKeyEventHandler(() => this.role !== 'spectator');
    this.bindScrollAnchor();
    const onMobilePaneChange = () => {
      this.fitSessionStage();
      this.renderActivePanePrompt();
      this.renderPaneScrollbars();
    };
    this.mobilePaneMedia.addEventListener('change', onMobilePaneChange);
    this.disposables.push({
      dispose: () => this.mobilePaneMedia.removeEventListener('change', onMobilePaneChange),
    });
    // On rotation into/out of short landscape, drop any view-pan and re-fit. Mask the
    // grid round-trip (the daemon reflows from the wide/tall landscape grid back to
    // the portrait one) so the half-resized intermediate — including a mis-placed
    // scrollbar — never shows.
    const onLandscapeChange = () => {
      this.resetSessionPan();
      this.beginPaneReflow();
      this.fitSessionStage();
    };
    this.landscapeMedia.addEventListener('change', onLandscapeChange);
    this.disposables.push({
      dispose: () => this.landscapeMedia.removeEventListener('change', onLandscapeChange),
    });
  }

  open(): void {
    this.term.open(this.stage);
    this.stage.append(this.focusLayer);
    this.stage.append(this.scrollLayer);
  }

  syncViewport(): void {
    if (this.scope === 'session') {
      this.enqueue((done) => {
        this.rememberOperatorFitSize();
        const resized = this.resizeSessionGrid();
        if (resized && this.lastSnapshotText !== undefined && this.snapshotFitsTerminal()) {
          this.writeSessionSnapshotFrame(this.lastSnapshotText, done);
          return;
        }
        // The content is already on screen from the write path; syncViewport only
        // re-fits the CSS transform, so do NOT force a full term.refresh() here —
        // that re-rendered every row on each keystroke and flashed the screen.
        this.fitSessionStage();
        this.scrollToTopLeft();
        done();
      });
      return;
    }
    if (this.stickToBottom) {
      this.scrollToBottom();
    }
  }

  fitSize(): { cols: number; rows: number } | undefined {
    const metrics = this.cellMetrics();
    if (!metrics || this.container.clientWidth <= 0 || this.container.clientHeight <= 0) {
      return undefined;
    }
    // Size the remote grid to the keyboard-independent height: the on-screen
    // keyboard shrinks the visible area, but resizing the session every time it
    // opens/closes round-trips through the daemon and visibly jumps the focused
    // pane. Add the keyboard inset back so the grid stays put; the keyboard only
    // occludes locally and fitSessionStage's prompt-follow keeps the cursor shown.
    const height = this.container.clientHeight + this.keyboardInset;
    const cols = clampTerminalSize(Math.floor(this.container.clientWidth / metrics.width));
    let rows = clampTerminalSize(Math.floor(height / metrics.height));
    if (this.shouldTallView()) {
      // A single full-screen app on mobile, whose UI is taller than the viewport
      // shows: ask the daemon for extra rows (bounded) so it draws more of its UI,
      // and let the user pan the view up to reach the cut-off top. cols stay the fit.
      rows = clampTerminalSize(Math.min(TALL_VIEW_MAX_ROWS, Math.max(rows, rows + TALL_VIEW_HEADROOM_ROWS)));
    }
    return { cols, rows };
  }

  setKeyboardInset(px: number): void {
    this.keyboardInset = Math.max(0, Math.round(px));
  }

  // True when a single full-screen (alternate-screen) app is shown on mobile (either
  // orientation) with no keyboard — the case where the grid is grown a bit taller than
  // the viewport so the user can pan the view to reach the cut-off top.
  private shouldTallView(): boolean {
    if (this.scope !== 'session' || this.keyboardInset > 0) {
      return false;
    }
    // A single full-screen (alternate-screen) app: render at natural width and let
    // the user pan vertically, with a few extra rows requested from the daemon so
    // more of the app's UI is drawn (see TALL_VIEW_HEADROOM_ROWS). This used to be
    // gated to mobile/short-landscape media, leaving a desktop browser no way to
    // reach a grid taller than its window (it just scaled the whole thing down).
    // Enabling it on desktop too gives the same scroll/pan mechanic as mobile.
    const panes = this.sessionView?.panes ?? [];
    return panes.length === 1 && panes[0].alternate_on === true;
  }

  private resetSessionPan(): void {
    this.sessionPanY = 0;
    this.sessionPanFollowBottom = true;
  }

  // True when a one-finger drag should pan the VIEW (tall-landscape full-screen app
  // whose grid is taller than the viewport), rather than scroll the app's scrollback.
  private canViewPan(): boolean {
    if (!this.shouldTallView()) {
      return false;
    }
    const screen = this.term.element?.querySelector<HTMLElement>('.xterm-screen');
    return !!screen && screen.clientHeight > this.container.clientHeight + 1;
  }

  private applyViewPan(dy: number): void {
    // Drag down (dy > 0) reveals content above (panY decreases), like natural scroll.
    this.sessionPanY = Math.min(this.sessionMaxPan, Math.max(0, this.sessionPanY - dy));
    this.sessionPanFollowBottom = this.sessionPanY >= this.sessionMaxPan - 1;
    this.fitSessionStage();
  }

  // The view-pan scrollbar is draggable: dragging the track/thumb scrubs the pan.
  bindViewPanScrollbar(): void {
    const bar = this.viewPanBar;
    const scrub = (clientY: number) => {
      const rect = bar.getBoundingClientRect();
      const frac = Math.min(1, Math.max(0, (clientY - rect.top) / Math.max(1, rect.height)));
      this.sessionPanY = frac * this.sessionMaxPan;
      this.sessionPanFollowBottom = this.sessionPanY >= this.sessionMaxPan - 1;
      this.fitSessionStage();
    };
    const onDown = (event: PointerEvent) => {
      event.preventDefault();
      event.stopPropagation();
      try {
        bar.setPointerCapture(event.pointerId);
      } catch {
        // best-effort
      }
      scrub(event.clientY);
      const onMove = (move: PointerEvent) => scrub(move.clientY);
      const onUp = () => {
        bar.removeEventListener('pointermove', onMove);
        bar.removeEventListener('pointerup', onUp);
        bar.removeEventListener('pointercancel', onUp);
      };
      bar.addEventListener('pointermove', onMove);
      bar.addEventListener('pointerup', onUp);
      bar.addEventListener('pointercancel', onUp);
    };
    bar.addEventListener('pointerdown', onDown);
    this.disposables.push({ dispose: () => bar.removeEventListener('pointerdown', onDown) });
  }

  // A thin scrollbar on the right showing the view-pan position/extent, so the user
  // sees there is more above/below and how far they've panned.
  private renderViewPanScrollbar(viewport: number, content: number, panY: number): void {
    if (content <= viewport + 1) {
      this.viewPanBar.hidden = true;
      return;
    }
    const track = Math.max(1, viewport - 8);
    const thumbHeight = Math.max(24, Math.min(track, track * (viewport / content)));
    const maxPan = content - viewport;
    const thumbTop = maxPan > 0 ? (panY / maxPan) * (track - thumbHeight) : 0;
    this.viewPanThumb.style.height = `${thumbHeight}px`;
    this.viewPanThumb.style.transform = `translateY(${Math.max(0, thumbTop)}px)`;
    this.viewPanBar.hidden = false;
  }

  setRole(role: ShareRole): void {
    this.role = role;
    this.term.options.disableStdin = role === 'spectator';
    this.term.options.cursorBlink = role === 'operator';
    this.term.options.cursorStyle = role === 'operator' ? 'block' : 'underline';
  }

  setTheme(theme: TerminalThemeName, userTheme = this.userTheme): void {
    this.userTheme = userTheme;
    this.container.dataset.theme = theme;
    this.container.dataset.themeMode = terminalThemeMode(theme, userTheme);
    this.term.options.theme = themePalette(theme, userTheme);
    if (this.term.element) {
      this.refreshTerminalFrame();
      this.syncViewport();
    }
  }

  replace(data: Uint8Array): void {
    this.decoder.decode();
    const text = this.decoder.decode(data);
    this.enqueue((done) => {
      if (this.scope === 'session') {
        this.lastSnapshotText = text;
        const snapshot = snapshotGeometry(text);
        this.snapshotCols = Math.max(MIN_TERMINAL_COLS, snapshot.cols);
        this.snapshotRows = Math.max(MIN_TERMINAL_ROWS, snapshot.rows);
        this.writeSessionSnapshotNow(text, done);
      } else {
        this.term.reset();
        this.writeDecodedNow(text, true, done);
      }
    });
  }

  write(data: Uint8Array): void {
    const text = this.decoder.decode(data, { stream: true });
    if (this.scope === 'session') {
      this.enqueue((done) => {
        // Live frames are full re-renders at the current grid; strip the erase so
        // the redraw overwrites in place instead of flashing the screen blank.
        this.writeDecodedNow(this.renderSessionFrame(withoutScreenClear(text)), false, () => {
          this.fitSessionStage();
          this.scrollToTopLeft();
          done();
        });
      });
      return;
    }
    const stickToBottom = this.stickToBottom;
    this.enqueue((done) => this.writeDecodedNow(text, stickToBottom, done));
  }

  private writeDecodedNow(data: string, stickToBottom: boolean, done: () => void): void {
    this.term.write(data, () => {
      if (stickToBottom) {
        this.scrollToBottom();
      }
      this.renderActivePanePrompt();
      done();
    });
  }

  resize(cols: number, rows: number): void {
    this.enqueue((done) => {
      this.remoteCols = Math.max(MIN_TERMINAL_COLS, cols);
      this.remoteRows = Math.max(MIN_TERMINAL_ROWS, rows);
      if (this.scope === 'session') {
        if (this.lastSnapshotText !== undefined) {
          this.writeSessionSnapshotNow(this.lastSnapshotText, done);
          return;
        }
        this.resizeSessionGrid();
        this.fitSessionStage();
        this.scrollToTopLeft();
      } else {
        this.resizeTerm(this.remoteCols, this.remoteRows);
        this.scrollToBottom();
      }
      done();
    });
  }

  setSessionView(view: SessionView): void {
    this.sessionView = view;
    // Leaving the tall-landscape full-screen case (exited the app, split, rotated)
    // drops any view-pan so re-entering starts pinned to the bottom again.
    if (!this.shouldTallView()) {
      this.resetSessionPan();
    }
    this.ensureMobilePane();
    this.fitSessionStage();
    this.renderActivePanePrompt();
    this.renderPaneScrollbars();
  }

  focusPane(paneId?: number): void {
    if (this.scope !== 'session') {
      return;
    }
    this.mobileShowAllPanes = false;
    this.mobilePaneId = paneId;
    this.ensureMobilePane();
    this.fitSessionStage();
    this.scrollToTopLeft();
    this.renderActivePanePrompt();
    this.renderPaneScrollbars();
    if (!this.isMobilePaneMode()) {
      this.focus();
    }
  }

  showAllPanes(): void {
    if (this.scope !== 'session') {
      return;
    }
    this.mobileShowAllPanes = true;
    this.mobilePaneId = undefined;
    this.fitSessionStage();
    this.scrollToTopLeft();
    this.renderActivePanePrompt();
    this.renderPaneScrollbars();
  }

  dispose(): void {
    this.disposed = true;
    this.clearReflowTimers();
    this.finishPaneResizeDrag();
    this.disposables.splice(0).forEach((disposable) => disposable.dispose());
    this.term.dispose();
  }

  onData(callback: (data: string) => void): void {
    this.dataHandler = callback;
    const disposable = this.term.onData(callback);
    this.disposables.push({
      dispose: () => {
        if (this.dataHandler === callback) {
          this.dataHandler = undefined;
        }
        disposable.dispose();
      },
    });
  }

  onPaneSelect(callback: (paneId: number) => void): void {
    // A short primary tap selects the pane. A drag is left to xterm/browser text
    // selection, so web-share behaves like a normal terminal surface.
    let tap: { x: number; y: number; time: number; pointerId: number; moved: boolean } | undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (this.scope !== 'session' || this.role !== 'operator') {
        return;
      }
      if (event.button !== 0 || this.dividerFromMouseEvent(event)) {
        tap = undefined;
        return;
      }
      const pane = this.paneFromMouseEvent(event);
      if (!pane) {
        tap = undefined;
        return;
      }
      tap = { x: event.clientX, y: event.clientY, time: nowMs(), pointerId: event.pointerId, moved: false };
    };
    const onPointerMove = (event: PointerEvent) => {
      if (tap && event.pointerId === tap.pointerId
        && (Math.abs(event.clientX - tap.x) > PANE_TAP_MOVE_THRESHOLD_PX
          || Math.abs(event.clientY - tap.y) > PANE_TAP_MOVE_THRESHOLD_PX)) {
        tap.moved = true;
      }
    };
    const onPointerUp = (event: PointerEvent) => {
      if (!tap || event.pointerId !== tap.pointerId) {
        return;
      }
      const wasTap = !tap.moved && nowMs() - tap.time < 400;
      tap = undefined;
      if (!wasTap) {
        return;
      }
      const pane = this.paneFromMouseEvent(event);
      if (pane && !this.dividerFromMouseEvent(event)) {
        event.preventDefault();
        if (event.pointerType !== 'touch') {
          this.term.focus();
        }
        callback(pane.id);
      }
    };
    const onPointerCancel = (event: PointerEvent) => {
      if (tap && event.pointerId === tap.pointerId) {
        tap = undefined;
      }
    };
    this.stage.addEventListener('pointerdown', onPointerDown);
    this.stage.addEventListener('pointermove', onPointerMove);
    this.stage.addEventListener('pointerup', onPointerUp);
    this.stage.addEventListener('pointercancel', onPointerCancel);
    this.disposables.push({
      dispose: () => {
        this.stage.removeEventListener('pointerdown', onPointerDown);
        this.stage.removeEventListener('pointermove', onPointerMove);
        this.stage.removeEventListener('pointerup', onPointerUp);
        this.stage.removeEventListener('pointercancel', onPointerCancel);
      },
    });
  }

  onPaneResize(callback: (paneId: number, direction: PaneResizeDirection, cells: number) => void): void {
    this.paneResizeHandler = callback;
    const onPointerMove = (event: PointerEvent) => {
      if (this.paneResizeDrag) {
        this.updatePaneResizeDrag(event);
        return;
      }
      this.updateResizeCursor(event);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (this.scope !== 'session' || this.role !== 'operator' || event.button !== 0) {
        return;
      }
      const divider = this.dividerFromMouseEvent(event);
      if (!divider) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (!this.isMobilePaneMode()) {
        this.term.focus();
      }
      this.paneResizeDrag = {
        divider,
        startX: event.clientX,
        startY: event.clientY,
        appliedCells: 0,
      };
      this.stage.dataset.resizing = 'true';
      this.stage.dataset.resizeAxis = divider.axis;
      this.stage.setPointerCapture(event.pointerId);
    };
    const onPointerUp = (event: PointerEvent) => this.finishPaneResizeDrag(event);
    const onPointerLeave = () => {
      if (!this.paneResizeDrag) {
        delete this.stage.dataset.resizeAxis;
      }
    };
    this.stage.addEventListener('pointermove', onPointerMove);
    this.stage.addEventListener('pointerdown', onPointerDown);
    this.stage.addEventListener('pointerup', onPointerUp);
    this.stage.addEventListener('pointercancel', onPointerUp);
    this.stage.addEventListener('pointerleave', onPointerLeave);
    this.disposables.push({
      dispose: () => {
        this.stage.removeEventListener('pointermove', onPointerMove);
        this.stage.removeEventListener('pointerdown', onPointerDown);
        this.stage.removeEventListener('pointerup', onPointerUp);
        this.stage.removeEventListener('pointercancel', onPointerUp);
        this.stage.removeEventListener('pointerleave', onPointerLeave);
      },
    });
  }

  onPaneScroll(callback: (paneId: number, delta: number) => void): void {
    this.paneScrollHandler = callback;
  }

  onTerminalMenu(callback: (x: number, y: number) => void): void {
    const onContextMenu = (event: MouseEvent) => {
      // On mobile a long-press should trigger the native selection callout, not
      // the custom terminal menu (clipboard actions live in the actions menu).
      if (this.isMobilePaneMode()) {
        return;
      }
      if (this.windowFromStatusEvent(event) || this.dividerFromMouseEvent(event)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      this.term.focus();
      callback(event.clientX, event.clientY);
    };
    this.stage.addEventListener('contextmenu', onContextMenu);
    this.disposables.push({
      dispose: () => this.stage.removeEventListener('contextmenu', onContextMenu),
    });
  }

  onWindowSelect(callback: (windowIndex: number) => void): void {
    // Desktop: a mouse-down on a window label selects it (and focuses the terminal).
    const onMouseDown = (event: MouseEvent) => {
      if (this.scope !== 'session' || this.role !== 'operator' || event.button !== 0) {
        return;
      }
      if (this.isMobilePaneMode()) {
        // Mobile taps are handled by the touch path below (which must NOT focus).
        return;
      }
      const window = this.windowFromStatusEvent(event);
      if (!window) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      this.term.focus();
      callback(window.index);
    };
    // Mobile: a tap on the green status bar must NOT pop up the on-screen keyboard.
    // Intercept it in the capture phase and preventDefault so it never reaches xterm's
    // tap-to-focus (which would focus the hidden textarea and open the keyboard); then
    // select the window on the tap-up. preventDefault covers the WHOLE status row, so
    // tapping an empty part of the bar also stays keyboard-free.
    let tap: { x: number; y: number; pointerId: number; moved: boolean } | undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType !== 'touch' || this.scope !== 'session' || this.role !== 'operator') {
        return;
      }
      if (!this.isStatusBarEvent(event)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      tap = { x: event.clientX, y: event.clientY, pointerId: event.pointerId, moved: false };
    };
    const onPointerMove = (event: PointerEvent) => {
      if (tap && event.pointerId === tap.pointerId
        && (Math.abs(event.clientX - tap.x) > 10 || Math.abs(event.clientY - tap.y) > 10)) {
        tap.moved = true;
      }
    };
    const onPointerUp = (event: PointerEvent) => {
      if (!tap || event.pointerId !== tap.pointerId) {
        return;
      }
      const window = tap.moved ? undefined : this.windowFromStatusEvent(event);
      tap = undefined;
      // Belt and braces: if xterm grabbed focus anyway, drop it so no keyboard shows.
      this.term.element?.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')?.blur();
      if (window) {
        event.preventDefault();
        event.stopPropagation();
        callback(window.index);
      }
    };
    // The load-bearing keyboard block on iOS: cancelling the touchstart prevents
    // WebKit from focusing xterm's hidden textarea (and the compat mouse events) on
    // a status-bar tap — pointerdown.preventDefault is NOT enough on iOS. Capture
    // phase + stopPropagation so it lands before xterm; the pointer path above still
    // fires (pointer events are independent of touch) and selects the window.
    const onTouchStart = (event: TouchEvent) => {
      if (this.scope !== 'session' || this.role !== 'operator' || event.touches.length !== 1) {
        return;
      }
      const touch = event.touches[0];
      if (!this.isStatusBarPoint(touch.clientX, touch.clientY)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    };
    this.stage.addEventListener('mousedown', onMouseDown);
    this.stage.addEventListener('touchstart', onTouchStart, { capture: true, passive: false });
    this.stage.addEventListener('pointerdown', onPointerDown, { capture: true });
    this.stage.addEventListener('pointermove', onPointerMove, { capture: true });
    this.stage.addEventListener('pointerup', onPointerUp, { capture: true });
    this.disposables.push({
      dispose: () => {
        this.stage.removeEventListener('mousedown', onMouseDown);
        this.stage.removeEventListener('touchstart', onTouchStart, { capture: true });
        this.stage.removeEventListener('pointerdown', onPointerDown, { capture: true });
        this.stage.removeEventListener('pointermove', onPointerMove, { capture: true });
        this.stage.removeEventListener('pointerup', onPointerUp, { capture: true });
      },
    });
  }

  private isStatusBarEvent(event: MouseEvent): boolean {
    return this.isStatusBarPoint(event.clientX, event.clientY);
  }

  onWindowMenu(callback: (windowIndex: number, x: number, y: number) => void): void {
    const onContextMenu = (event: MouseEvent) => {
      if (this.scope !== 'session' || this.role !== 'operator') {
        return;
      }
      const window = this.windowFromStatusEvent(event);
      if (!window) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (!this.isMobilePaneMode()) {
        this.term.focus();
      }
      callback(window.index, event.clientX, event.clientY);
    };
    const onPointerMove = (event: PointerEvent) => {
      if (this.scope !== 'session' || this.role !== 'operator') {
        this.stage.removeAttribute('title');
        delete this.stage.dataset.windowActions;
        return;
      }
      if (this.windowFromStatusEvent(event)) {
        this.stage.title = 'Right-click for window actions';
        this.stage.dataset.windowActions = 'true';
      } else {
        this.stage.removeAttribute('title');
        delete this.stage.dataset.windowActions;
      }
    };
    this.stage.addEventListener('contextmenu', onContextMenu);
    this.stage.addEventListener('pointermove', onPointerMove);
    this.disposables.push({
      dispose: () => {
        this.stage.removeEventListener('contextmenu', onContextMenu);
        this.stage.removeEventListener('pointermove', onPointerMove);
      },
    });
  }

  notice(text: string): void {
    this.term.writeln(`\r\n${text}`);
  }

  selection(): string {
    return this.term.getSelection();
  }

  focus(): void {
    this.term.focus();
  }

  bindLocalWheelScroll(): void {
    const onWheel = (event: WheelEvent) => {
      if (!this.container.contains(event.target as Node | null)) {
        return;
      }
      if (this.scope === 'session') {
        event.preventDefault();
        event.stopImmediatePropagation();
        const pane = this.focusedMobilePane() ?? this.paneFromMouseEvent(event);
        if (pane && this.forwardAlternateWheel(pane, event)) {
          return;
        }
        // Tall full-screen fallback (alt-screen app taller than the viewport):
        // pan the VIEW locally only when the pane/app did not consume the wheel.
        if (this.canViewPan()) {
          const { y } = wheelDeltaPixels(event, this.container.clientHeight);
          if (y !== 0) {
            this.applyViewPan(-y);
          }
          return;
        }
        if (pane) {
          this.sendPaneScroll(pane, event);
        }
        return;
      }
      const { x, y } = wheelDeltaPixels(event, this.container.clientHeight);
      if (x === 0 && y === 0) {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      if (x !== 0) {
        this.container.scrollLeft += x;
      }
      if (y !== 0) {
        this.scrollPaneViewportByPixels(y);
      }
    };
    this.container.addEventListener('wheel', onWheel, { capture: true, passive: false });
    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType !== 'touch' || !this.container.contains(event.target as Node | null)) {
        return;
      }
      // Short-landscape full-screen app: the grid is taller than the viewport, so a
      // one-finger drag pans the VIEW (not the app's scrollback) to reach the top.
      // Deferred so a stationary long-press stays free for native text selection.
      if (this.canViewPan()) {
        this.viewPanPending = { startY: event.clientY, lastY: event.clientY, pointerId: event.pointerId };
        return;
      }
      // In all-panes mode no pane is focused, so fall back to the pane under the
      // finger; otherwise touch scrolling never engages on the shared grid.
      const pane = this.focusedMobilePane() ?? this.paneFromMouseEvent(event);
      if (!pane || pane.alternate_on || pane.history_size <= 0) {
        return;
      }
      // Defer the scroll capture until the finger actually drags, so a stationary
      // long-press is left to the browser for native text selection / paste.
      this.touchPending = {
        paneId: pane.id,
        startY: event.clientY,
        lastY: event.clientY,
        pointerId: event.pointerId,
      };
    };
    const onPointerMove = (event: PointerEvent) => {
      if (this.viewPanPending && event.pointerId === this.viewPanPending.pointerId) {
        if (!this.viewPanning
          && Math.abs(event.clientY - this.viewPanPending.startY) < TOUCH_SCROLL_THRESHOLD_PX) {
          return;
        }
        if (!this.viewPanning) {
          this.viewPanning = true;
          try {
            this.container.setPointerCapture(event.pointerId);
          } catch {
            // best-effort: capture keeps the pan alive if the finger leaves the
            // element, but is not essential and may reject a synthetic pointer.
          }
        }
        event.preventDefault();
        this.applyViewPan(event.clientY - this.viewPanPending.lastY);
        this.viewPanPending.lastY = event.clientY;
        return;
      }
      if (!this.touchScroll) {
        if (!this.touchPending || event.pointerId !== this.touchPending.pointerId) {
          return;
        }
        if (Math.abs(event.clientY - this.touchPending.startY) < TOUCH_SCROLL_THRESHOLD_PX) {
          return;
        }
        this.touchScroll = { paneId: this.touchPending.paneId, lastY: this.touchPending.startY, remainder: 0 };
        this.touchPending = undefined;
        this.container.setPointerCapture(event.pointerId);
      }
      if (!this.paneScrollHandler) {
        return;
      }
      event.preventDefault();
      const metrics = this.cellMetrics();
      const lineHeight = metrics?.height ?? WHEEL_PIXEL_LINE;
      this.touchScroll.remainder += event.clientY - this.touchScroll.lastY;
      this.touchScroll.lastY = event.clientY;
      const lines = integralDelta(this.touchScroll.remainder / Math.max(1, lineHeight));
      if (lines === 0) {
        return;
      }
      this.touchScroll.remainder -= lines * lineHeight;
      this.paneScrollHandler(this.touchScroll.paneId, -lines);
    };
    const onPointerUp = (event: PointerEvent) => {
      this.touchScroll = undefined;
      this.touchPending = undefined;
      this.viewPanPending = undefined;
      this.viewPanning = false;
      if (this.container.hasPointerCapture(event.pointerId)) {
        this.container.releasePointerCapture(event.pointerId);
      }
    };
    this.container.addEventListener('pointerdown', onPointerDown, { passive: true });
    this.container.addEventListener('pointermove', onPointerMove, { passive: false });
    this.container.addEventListener('pointerup', onPointerUp);
    this.container.addEventListener('pointercancel', onPointerUp);
    this.disposables.push({
      dispose: () => {
        this.container.removeEventListener('wheel', onWheel, { capture: true });
        this.container.removeEventListener('pointerdown', onPointerDown);
        this.container.removeEventListener('pointermove', onPointerMove);
        this.container.removeEventListener('pointerup', onPointerUp);
        this.container.removeEventListener('pointercancel', onPointerUp);
      },
    });
  }

  private enqueue(operation: (done: () => void) => void): void {
    const run = () => new Promise<void>((resolve) => {
      if (this.disposed) {
        resolve();
        return;
      }
      operation(resolve);
    });
    this.operationQueue = this.operationQueue.then(run, run);
  }

  private bindScrollAnchor(): void {
    if (this.scope !== 'session') {
      this.disposables.push(this.term.onScroll(() => {
        this.stickToBottom = this.isPaneViewportNearBottom();
      }));
      return;
    }
    const onScroll = () => {
      this.stickToBottom = this.isNearBottom();
    };
    this.container.addEventListener('scroll', onScroll, { passive: true });
    this.disposables.push({
      dispose: () => this.container.removeEventListener('scroll', onScroll),
    });
  }

  private scrollToBottom(): void {
    if (this.scope !== 'session') {
      this.term.scrollToBottom();
      this.stickToBottom = true;
      return;
    }
    this.container.scrollTop = this.container.scrollHeight;
    this.stickToBottom = true;
  }

  followLiveOutput(): void {
    // A session renders the whole grid pinned to the top-left and CSS-scales it to
    // fit. The scale transform is visual only, so the stage keeps its untransformed
    // layout height and the container stays scrollable; scrolling to the "bottom"
    // here then pushes the top rows out of view on WebKit (iOS) until the next
    // frame's scrollToTopLeft restores them — the per-keystroke top blank. Only a
    // pane follows its live output downward; a session stays pinned top-left.
    if (this.scope === 'session') {
      this.scrollToTopLeft();
      return;
    }
    this.scrollToBottom();
  }

  private scrollToTop(): void {
    if (this.scope !== 'session') {
      this.term.scrollToTop();
      this.stickToBottom = false;
      return;
    }
    this.container.scrollTop = 0;
    this.stickToBottom = false;
  }

  private scrollToTopLeft(): void {
    this.container.scrollLeft = 0;
    this.scrollToTop();
  }

  private isNearBottom(): boolean {
    if (this.scope !== 'session') {
      return this.isPaneViewportNearBottom();
    }
    return this.container.scrollTop + this.container.clientHeight
      >= this.container.scrollHeight - BOTTOM_STICKY_THRESHOLD_PX;
  }

  private isPaneViewportNearBottom(): boolean {
    const buffer = this.term.buffer.active;
    return buffer.viewportY >= buffer.baseY - 1;
  }

  private scrollPaneViewportByPixels(deltaY: number): void {
    const metrics = this.cellMetrics();
    const lineHeight = metrics?.height ?? WHEEL_PIXEL_LINE;
    const lines = Math.max(1, Math.round(Math.abs(deltaY) / Math.max(1, lineHeight)));
    this.term.scrollLines(deltaY < 0 ? -lines : lines);
    this.stickToBottom = this.isPaneViewportNearBottom();
  }

  private writeSessionSnapshotNow(text: string, done: () => void): void {
    // A grid resize already blanks and re-lays-out the terminal, so the clear is
    // harmless (and the in-place overwrite would be wrong at the new size); keep
    // it only then. Same-size content frames overwrite in place without a clear.
    const resized = this.resizeSessionGrid();
    this.writeSessionSnapshotFrame(text, done, resized);
  }

  private writeSessionSnapshotFrame(text: string, done: () => void, keepClear = true): void {
    const frame = keepClear ? text : withoutScreenClear(text);
    this.writeDecodedNow(this.renderSessionFrame(frame), false, () => {
      this.fitSessionStage();
      this.scrollToTopLeft();
      if (keepClear) {
        this.refreshTerminalFrame(false);
      }
      done();
    });
  }

  private renderSessionFrame(text: string): string {
    const statusRow = this.sessionStatusRow(text);
    if (!statusRow) {
      return text;
    }
    return projectRows(text, {
      maxContentRow: Math.max(1, this.term.rows - 1),
      statusRow,
      targetStatusRow: this.term.rows,
    });
  }

  private sessionStatusRow(text: string): number | undefined {
    const rows = cursorRows(text);
    if (!rows.length) {
      return undefined;
    }
    const canonical = [this.sessionView?.size.rows, this.remoteRows]
      .filter((row): row is number => typeof row === 'number' && row >= MIN_TERMINAL_ROWS)
      .find((row) => rows.includes(row));
    if (canonical) {
      return canonical;
    }
    const candidates = [this.snapshotRows, this.remoteRows]
      .filter((row) => row >= MIN_TERMINAL_ROWS && rows.includes(row));
    return candidates.length ? Math.max(...candidates) : undefined;
  }

  private resizeSessionGrid(): boolean {
    const size = this.sessionGridSize();
    return this.resizeTerm(size.cols, size.rows);
  }

  private sessionGridSize(): { cols: number; rows: number } {
    if (this.shouldUseOperatorGrid()) {
      return { cols: this.operatorCols, rows: this.operatorRows };
    }
    const renderSize = this.sessionRenderSize();
    if (renderSize) {
      return renderSize;
    }
    return {
      cols: Math.max(
        this.remoteCols,
        this.snapshotCols,
        MIN_TERMINAL_COLS,
      ),
      rows: Math.max(this.remoteRows, this.snapshotRows, MIN_TERMINAL_ROWS),
    };
  }

  private shouldUseOperatorGrid(): boolean {
    if (this.role !== 'operator' || this.operatorCols <= 0 || this.operatorRows <= 0) {
      return false;
    }
    const renderSize = this.sessionRenderSize();
    if (!renderSize) {
      return true;
    }
    return renderSize.rows === this.operatorRows && renderSize.cols <= this.operatorCols + 1;
  }

  private snapshotFitsTerminal(): boolean {
    const renderSize = this.sessionRenderSize();
    if (!renderSize) {
      return true;
    }
    return renderSize.rows <= this.term.rows && renderSize.cols <= this.term.cols + 1;
  }

  private sessionRenderSize(): { cols: number; rows: number } | undefined {
    if (this.sessionView) {
      return this.sessionView.size;
    }
    if (this.snapshotRows <= 0 || this.snapshotCols <= 0) {
      return undefined;
    }
    return {
      cols: Math.max(this.remoteCols, this.snapshotCols, MIN_TERMINAL_COLS),
      rows: Math.max(this.remoteRows, this.snapshotRows, MIN_TERMINAL_ROWS),
    };
  }

  private rememberOperatorFitSize(): void {
    if (this.role !== 'operator') {
      return;
    }
    const size = this.fitSize();
    if (!size) {
      return;
    }
    this.operatorCols = size.cols;
    this.operatorRows = size.rows;
  }

  private cellMetrics(): { width: number; height: number } | undefined {
    const screen = this.term.element?.querySelector<HTMLElement>('.xterm-screen');
    if (!screen || this.term.cols <= 0 || this.term.rows <= 0) {
      return undefined;
    }
    const width = screen.clientWidth / this.term.cols;
    const height = screen.clientHeight / this.term.rows;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return undefined;
    }
    return { width, height };
  }

  private resizeTerm(cols: number, rows: number): boolean {
    if (this.term.cols === cols && this.term.rows === rows) {
      return false;
    }
    this.term.resize(cols, rows);
    this.refreshTerminalFrame();
    return true;
  }

  // rebuildAtlas clears the glyph texture cache, which briefly blanks the whole
  // canvas — needed after a theme/font change, but it must NOT run on routine
  // content frames or the screen flashes on every keystroke.
  private refreshTerminalFrame(rebuildAtlas = true): void {
    if (rebuildAtlas) {
      this.term.clearTextureAtlas();
    }
    this.term.refresh(0, Math.max(0, this.term.rows - 1));
    window.requestAnimationFrame(() => {
      if (!this.disposed) {
        this.term.refresh(0, Math.max(0, this.term.rows - 1));
      }
    });
  }

  private fitSessionStage(): void {
    if (this.scope !== 'session') {
      return;
    }
    const screen = this.term.element?.querySelector<HTMLElement>('.xterm-screen');
    if (!screen || this.container.clientWidth <= 0 || this.container.clientHeight <= 0) {
      return;
    }
    const width = screen.clientWidth;
    const height = screen.clientHeight;
    if (width <= 0 || height <= 0) {
      return;
    }
    // Hidden by default; the tall-landscape pan branch re-shows it.
    this.viewPanBar.hidden = true;
    const focusedPane = this.focusedMobilePane();
    // The pane geometry is expressed in sessionView.size grid units, but the
    // transform maps it onto the *rendered* xterm grid. Mid-resize (after a
    // focus-fill request) the view grew but xterm has not caught up yet, so the
    // cell metrics are wrong and the transform mangles into a tiny, double-status
    // mess. Hold the last good transform until the rendered grid matches.
    const view = this.sessionView?.size;
    if (focusedPane && view && (this.term.cols !== view.cols || this.term.rows !== view.rows)) {
      return;
    }
    const metrics = focusedPane ? this.sessionCellPixels() : undefined;
    if (focusedPane && metrics) {
      const paneWidth = Math.max(metrics.width, focusedPane.cols * metrics.width);
      const paneHeight = Math.max(metrics.height, focusedPane.rows * metrics.height);
      let transform: string;
      if (this.container.clientWidth > this.container.clientHeight) {
        // Landscape (wide + short): fit the WHOLE pane on screen so nothing is
        // hidden and there is nothing to scroll. Scale to the tighter of the two
        // axes and anchor at the pane's top-left.
        const scale = Math.min(
          MOBILE_PANE_FILL_MAX_SCALE,
          this.container.clientWidth / paneWidth,
          this.container.clientHeight / paneHeight,
        );
        transform = `scale(${scale}) translate(${-focusedPane.x * metrics.width}px, ${-focusedPane.y * metrics.height}px)`;
      } else {
        // Portrait: fill the available width with the focused pane (a side-by-side
        // split pane is narrower than the screen), then follow its prompt row
        // vertically so the active line stays in view when the zoomed pane is
        // taller than the viewport. The clip keeps neighbours out of the leftover.
        const scale = Math.min(MOBILE_PANE_FILL_MAX_SCALE, this.container.clientWidth / paneWidth);
        const visibleRows = Math.max(1, Math.floor(this.container.clientHeight / (metrics.height * scale)));
        const prompt = this.activePromptPoint(focusedPane);
        const maxTopRow = Math.max(focusedPane.y, focusedPane.y + focusedPane.rows - visibleRows);
        const topRow = Math.min(maxTopRow, Math.max(focusedPane.y, prompt.row - (visibleRows - 1)));
        transform = `scale(${scale}) translate(${-focusedPane.x * metrics.width}px, ${-topRow * metrics.height}px)`;
      }
      // Re-applying the transform/clip every output frame repaints the scaled GPU
      // layer and flashes the whole screen on each keystroke, so only touch the
      // styles when they actually change.
      if (transform !== this.lastStageTransform || this.lastStageClip !== 'pane') {
        this.stage.style.transform = transform;
        this.stage.style.clipPath = paneClipPath(focusedPane, metrics, this.stage.offsetWidth, this.stage.offsetHeight);
        this.lastStageTransform = transform;
        this.lastStageClip = 'pane';
      }
      this.container.dataset.mobilePaneFocus = 'true';
      this.stage.dataset.mobilePaneFocus = 'true';
      this.renderActivePanePrompt();
      this.renderPaneScrollbars();
      this.scheduleReflowReveal();
      return;
    }
    delete this.container.dataset.mobilePaneFocus;
    delete this.stage.dataset.mobilePaneFocus;
    let transform: string;
    const panes = this.sessionView?.panes ?? [];
    if (this.keyboardInset > 0 && panes.length <= 1 && this.container.clientHeight < height) {
      // The on-screen keyboard is open and the single full-screen pane is kept at its
      // full (keyboard-independent) height, taller than the visible area. Scaling it
      // to fit would shrink the text to an unreadable size, so keep it at natural
      // width and follow the active row vertically instead — the keyboard occludes
      // the off-screen rows. Same approach as a focused split pane in portrait.
      const cellHeight = height / Math.max(1, this.term.rows);
      const scale = Math.min(1, this.container.clientWidth / width);
      const visibleRows = Math.max(1, Math.floor(this.container.clientHeight / (cellHeight * scale)));
      const cursorRow = this.term.buffer.active.cursorY;
      const maxTopRow = Math.max(0, this.term.rows - visibleRows);
      const topRow = Math.min(maxTopRow, Math.max(0, cursorRow - (visibleRows - 1)));
      transform = topRow > 0 || scale < 0.999
        ? `scale(${scale}) translate(0px, ${-topRow * cellHeight}px)`
        : 'none';
    } else if (this.shouldTallView() && this.container.clientHeight < height) {
      // The grid is taller than the short landscape viewport: render at natural width
      // and let the user pan the view vertically (sessionPanY) to reach the top.
      // Default to the bottom (where the cursor/input is); the pan handler unsticks it.
      // The translate is written through the SAME guard below, so output frames that
      // keep sessionPanY constant produce an identical string and skip the style write
      // — no per-frame re-rasterization (the WebKit flicker condition).
      const scale = Math.min(1, this.container.clientWidth / width);
      const contentHeight = height * scale;
      const maxPan = Math.max(0, contentHeight - this.container.clientHeight);
      this.sessionMaxPan = maxPan;
      this.sessionPanY = this.sessionPanFollowBottom
        ? maxPan
        : Math.min(maxPan, Math.max(0, this.sessionPanY));
      const cellHeight = (height / Math.max(1, this.term.rows)) * scale;
      const panY = Math.round(this.sessionPanY / Math.max(1, cellHeight)) * cellHeight;
      transform = scale < 0.999
        ? `scale(${scale}) translate(0px, ${-panY / scale}px)`
        : (panY > 0 ? `translate(0px, ${-panY}px)` : 'none');
      this.renderViewPanScrollbar(this.container.clientHeight, contentHeight, this.sessionPanY);
    } else {
      const scale = Math.min(1, this.container.clientWidth / width, this.container.clientHeight / height);
      transform = scale < 0.999 ? `scale(${scale})` : 'none';
    }
    if (transform !== this.lastStageTransform || this.lastStageClip !== 'none') {
      this.stage.style.transform = transform;
      this.stage.style.clipPath = 'none';
      this.lastStageTransform = transform;
      this.lastStageClip = 'none';
    }
    this.renderActivePanePrompt();
    this.renderPaneScrollbars();
    this.scheduleReflowReveal();
  }

  // Switching the focused pane asks rmux to regrow the session so the pane fills
  // the viewport; that round-trip briefly shows a resizing, half-rendered grid.
  // Cover the terminal with a plain surface-coloured mask from the tap until the
  // new geometry settles, so the user only ever sees the before and after states.
  beginPaneReflow(): void {
    this.reflowing = true;
    this.container.dataset.reflowing = 'true';
    this.clearReflowTimers();
    // Safety net: never stay masked, even if frames never visibly settle.
    this.reflowHardTimer = window.setTimeout(() => this.endPaneReflow(), 1400);
  }

  private scheduleReflowReveal(): void {
    if (!this.reflowing) {
      return;
    }
    if (this.reflowRevealTimer !== undefined) {
      window.clearTimeout(this.reflowRevealTimer);
    }
    // Lift the mask only after the geometry has been quiet for a short window;
    // each intermediate resize frame pushes this back so churn stays hidden.
    this.reflowRevealTimer = window.setTimeout(() => this.endPaneReflow(), 200);
  }

  private endPaneReflow(): void {
    this.reflowing = false;
    this.clearReflowTimers();
    delete this.container.dataset.reflowing;
  }

  private clearReflowTimers(): void {
    if (this.reflowRevealTimer !== undefined) {
      window.clearTimeout(this.reflowRevealTimer);
      this.reflowRevealTimer = undefined;
    }
    if (this.reflowHardTimer !== undefined) {
      window.clearTimeout(this.reflowHardTimer);
      this.reflowHardTimer = undefined;
    }
  }

  // Whole-pane copy: prefer an explicit selection, else read the focused pane's
  // visible rows straight out of the xterm buffer so a one-tap copy always works.
  focusedPaneText(): string {
    const native = window.getSelection()?.toString() ?? '';
    if (native) {
      return native;
    }
    const explicit = this.term.selection();
    if (explicit) {
      return explicit;
    }
    const pane = this.focusedMobilePane() ?? this.activeSessionPane();
    return pane ? this.readPaneText(pane) : '';
  }

  private readPaneText(pane: SessionPaneView): string {
    const buffer = this.term.buffer.active;
    const base = buffer.baseY;
    const lines: string[] = [];
    for (let i = 0; i < pane.rows; i += 1) {
      const line = buffer.getLine(base + pane.y + i);
      lines.push(line ? line.translateToString(false, pane.x, pane.x + pane.cols).replace(/\s+$/u, '') : '');
    }
    while (lines.length && lines[lines.length - 1] === '') {
      lines.pop();
    }
    return lines.join('\n');
  }

  private renderActivePanePrompt(): void {
    if (this.scope !== 'session' || !this.sessionView) {
      this.focusLayer.replaceChildren();
      return;
    }
    const pane = this.activeSessionPane();
    const metrics = this.sessionCellPixels();
    if (!pane || !metrics) {
      this.focusLayer.replaceChildren();
      return;
    }
    const point = this.activePromptPoint(pane);
    const prompt = document.createElement('div');
    prompt.className = 'share-pane-active-prompt';
    prompt.title = 'Active pane';
    prompt.style.left = `${point.col * metrics.width}px`;
    prompt.style.top = `${point.row * metrics.height}px`;
    prompt.style.width = `${Math.max(3, metrics.width * 0.24)}px`;
    prompt.style.height = `${Math.max(10, metrics.height)}px`;
    this.focusLayer.replaceChildren(prompt);
  }

  private activeSessionPane(): SessionPaneView | undefined {
    const panes = this.sessionView?.panes ?? [];
    return panes.find((pane) => pane.active) ?? (panes.length === 1 ? panes[0] : undefined);
  }

  // Mirrors the picker logic in the controller: a pane is "focused" only when
  // more than one pane exists and a still-present pane is selected. Anything
  // else (single pane, fresh split, focused pane closed) shows all panes.
  private ensureMobilePane(): void {
    const panes = this.sessionView?.panes ?? [];
    const hasSelection = this.isMobilePaneMode()
      && panes.length > 1
      && this.mobilePaneId !== undefined
      && panes.some((pane) => pane.id === this.mobilePaneId);
    this.mobileShowAllPanes = !hasSelection;
    if (!hasSelection) {
      this.mobilePaneId = undefined;
    }
  }

  private focusedMobilePane(): SessionPaneView | undefined {
    if (!this.isMobilePaneMode()) {
      return undefined;
    }
    this.ensureMobilePane();
    if (this.mobileShowAllPanes) {
      return undefined;
    }
    const panes = this.sessionView?.panes ?? [];
    return panes.find((pane) => pane.id === this.mobilePaneId);
  }

  private isMobilePaneMode(): boolean {
    return this.scope === 'session' && this.mobilePaneMedia.matches;
  }

  private activePromptPoint(pane: SessionPaneView): SessionPoint {
    if (!this.sessionView) {
      return { col: pane.x, row: pane.y };
    }
    const cursor = this.term.buffer.active;
    const cursorPoint = {
      col: projectCell(cursor.cursorX, this.term.cols, this.sessionView.size.cols),
      row: projectCell(cursor.cursorY, this.term.rows, this.sessionView.size.rows),
    };
    if (
      cursorPoint.col >= pane.x
      && cursorPoint.col < pane.x + pane.cols
      && cursorPoint.row >= pane.y
      && cursorPoint.row < pane.y + pane.rows
    ) {
      return cursorPoint;
    }
    return { col: pane.x, row: pane.y };
  }

  private sessionCellPixels(): { width: number; height: number } | undefined {
    const screen = this.term.element?.querySelector<HTMLElement>('.xterm-screen');
    if (!screen || !this.sessionView) {
      return undefined;
    }
    const width = screen.clientWidth / Math.max(1, this.sessionView.size.cols);
    const height = screen.clientHeight / Math.max(1, this.sessionView.size.rows);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return undefined;
    }
    return { width, height };
  }

  private cellFromMouseEvent(event: MouseEvent): { col: number; row: number } | undefined {
    return this.cellFromPoint(event.clientX, event.clientY);
  }

  private cellFromPoint(clientX: number, clientY: number): { col: number; row: number } | undefined {
    const screen = this.term.element?.querySelector<HTMLElement>('.xterm-screen');
    if (!screen) {
      return undefined;
    }
    const rect = screen.getBoundingClientRect();
    const cellWidth = rect.width / this.term.cols;
    const cellHeight = rect.height / this.term.rows;
    if (cellWidth <= 0 || cellHeight <= 0) {
      return undefined;
    }
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) {
      return undefined;
    }
    return {
      col: Math.min(this.term.cols, Math.max(1, Math.floor(x / cellWidth) + 1)),
      row: Math.min(this.term.rows, Math.max(1, Math.floor(y / cellHeight) + 1)),
    };
  }

  // True when the point is on the bottom (status) row of the session grid.
  private isStatusBarPoint(clientX: number, clientY: number): boolean {
    const cell = this.cellFromPoint(clientX, clientY);
    return !!cell && cell.row >= this.term.rows;
  }

  private sessionCellFromMouseEvent(event: MouseEvent): { col: number; row: number } | undefined {
    const cell = this.cellFromMouseEvent(event);
    if (!cell || !this.sessionView) {
      return undefined;
    }
    return {
      col: projectCell(cell.col - 1, this.term.cols, this.sessionView.size.cols),
      row: projectCell(cell.row - 1, this.term.rows, this.sessionView.size.rows),
    };
  }

  private sessionPointFromMouseEvent(event: MouseEvent): SessionPoint | undefined {
    const screen = this.term.element?.querySelector<HTMLElement>('.xterm-screen');
    if (!screen || !this.sessionView) {
      return undefined;
    }
    const rect = screen.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (rect.width <= 0 || rect.height <= 0 || x < 0 || y < 0 || x > rect.width || y > rect.height) {
      return undefined;
    }
    return {
      col: x * this.sessionView.size.cols / rect.width,
      row: y * this.sessionView.size.rows / rect.height,
    };
  }

  private paneFromMouseEvent(event: MouseEvent): SessionPaneView | undefined {
    const cell = this.sessionCellFromMouseEvent(event);
    if (!cell || !this.sessionView) {
      return undefined;
    }
    const { col, row } = cell;
    return this.sessionView.panes.find((pane) => (
      col >= pane.x
      && col < pane.x + pane.cols
      && row >= pane.y
      && row < pane.y + pane.rows
    ));
  }

  private windowFromStatusEvent(event: MouseEvent): SessionWindowView | undefined {
    const cell = this.cellFromMouseEvent(event);
    const windows = this.sessionView?.windows;
    if (!cell || !windows?.length || cell.row < this.term.rows) {
      return undefined;
    }
    const text = this.statusRowText();
    const col = cell.col - 1;
    return windows.find((window) => windowStatusLabelContains(text, window, col));
  }

  private statusRowText(): string {
    const rows = Array.from(this.term.element?.querySelectorAll<HTMLElement>('.xterm-rows > div') ?? []);
    return rows.at(-1)?.textContent ?? '';
  }

  private dividerFromMouseEvent(event: MouseEvent): PaneDivider | undefined {
    if ((event.target as Element | null)?.closest('.share-pane-scrollbar')) {
      return undefined;
    }
    const point = this.sessionPointFromMouseEvent(event);
    if (!point || !this.sessionView) {
      return undefined;
    }
    const vertical = this.verticalDividerNear(point);
    const horizontal = this.horizontalDividerNear(point);
    if (!vertical) {
      return horizontal?.divider;
    }
    if (!horizontal) {
      return vertical.divider;
    }
    if (Math.abs(vertical.distance - horizontal.distance) < 0.1) {
      return undefined;
    }
    return vertical.distance < horizontal.distance ? vertical.divider : horizontal.divider;
  }

  private verticalDividerNear(point: SessionPoint): { divider: PaneDivider; distance: number } | undefined {
    const panes = this.sessionView?.panes ?? [];
    let best: { divider: PaneDivider; distance: number } | undefined;
    for (const candidate of panes) {
      const dividerCol = candidate.x + candidate.cols;
      const distance = Math.abs(point.col - (dividerCol + 0.5));
      if (distance > DIVIDER_HIT_SLOP_CELLS
        || point.row < candidate.y - DIVIDER_HIT_SLOP_CELLS
        || point.row >= candidate.y + candidate.rows + DIVIDER_HIT_SLOP_CELLS
        || !panes.some((neighbor) => (
          neighbor.x === dividerCol + 1
          && point.row >= neighbor.y - DIVIDER_HIT_SLOP_CELLS
          && point.row < neighbor.y + neighbor.rows + DIVIDER_HIT_SLOP_CELLS
        ))
      ) {
        continue;
      }
      if (!best || distance < best.distance) {
        best = { divider: { axis: 'vertical', paneId: candidate.id }, distance };
      }
    }
    return best;
  }

  private horizontalDividerNear(point: SessionPoint): { divider: PaneDivider; distance: number } | undefined {
    const panes = this.sessionView?.panes ?? [];
    let best: { divider: PaneDivider; distance: number } | undefined;
    for (const candidate of panes) {
      const dividerRow = candidate.y + candidate.rows;
      const distance = Math.abs(point.row - (dividerRow + 0.5));
      if (distance > DIVIDER_HIT_SLOP_CELLS
        || point.col < candidate.x - DIVIDER_HIT_SLOP_CELLS
        || point.col >= candidate.x + candidate.cols + DIVIDER_HIT_SLOP_CELLS
        || !panes.some((neighbor) => (
          neighbor.y === dividerRow + 1
          && point.col >= neighbor.x - DIVIDER_HIT_SLOP_CELLS
          && point.col < neighbor.x + neighbor.cols + DIVIDER_HIT_SLOP_CELLS
        ))
      ) {
        continue;
      }
      if (!best || distance < best.distance) {
        best = { divider: { axis: 'horizontal', paneId: candidate.id }, distance };
      }
    }
    return best;
  }

  private updateResizeCursor(event: PointerEvent): void {
    if (this.scope !== 'session' || this.role !== 'operator') {
      delete this.stage.dataset.resizeAxis;
      return;
    }
    const divider = this.dividerFromMouseEvent(event);
    if (divider) {
      this.stage.dataset.resizeAxis = divider.axis;
    } else {
      delete this.stage.dataset.resizeAxis;
    }
  }

  private updatePaneResizeDrag(event: PointerEvent): void {
    if (!this.paneResizeDrag || !this.paneResizeHandler) {
      return;
    }
    event.preventDefault();
    const metrics = this.sessionCellMetrics();
    if (!metrics) {
      return;
    }
    const drag = this.paneResizeDrag;
    const pixelDelta = drag.divider.axis === 'vertical'
      ? event.clientX - drag.startX
      : event.clientY - drag.startY;
    const cellDelta = integralDelta(pixelDelta / (
      drag.divider.axis === 'vertical' ? metrics.width : metrics.height
    ));
    const step = cellDelta - drag.appliedCells;
    if (step === 0) {
      return;
    }
    const direction: PaneResizeDirection = drag.divider.axis === 'vertical'
      ? (step > 0 ? 'right' : 'left')
      : (step > 0 ? 'down' : 'up');
    this.paneResizeHandler(
      drag.divider.paneId,
      direction,
      Math.min(MAX_DIVIDER_DRAG_CELLS, Math.abs(step)),
    );
    drag.appliedCells += step;
  }

  private finishPaneResizeDrag(event?: PointerEvent): void {
    if (event && this.stage.hasPointerCapture(event.pointerId)) {
      this.stage.releasePointerCapture(event.pointerId);
    }
    this.paneResizeDrag = undefined;
    delete this.stage.dataset.resizing;
    delete this.stage.dataset.resizeAxis;
  }

  private sessionCellMetrics(): { width: number; height: number } | undefined {
    const screen = this.term.element?.querySelector<HTMLElement>('.xterm-screen');
    if (!screen || !this.sessionView) {
      return undefined;
    }
    const rect = screen.getBoundingClientRect();
    const width = rect.width / Math.max(1, this.sessionView.size.cols);
    const height = rect.height / Math.max(1, this.sessionView.size.rows);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return undefined;
    }
    return { width, height };
  }

  private sendPaneScroll(pane: SessionPaneView, event: WheelEvent): boolean {
    if (!this.paneScrollHandler || pane.alternate_on || pane.history_size <= 0) {
      return false;
    }
    const { y } = wheelDeltaPixels(event, this.container.clientHeight);
    const metrics = this.cellMetrics();
    const lineHeight = metrics?.height ?? WHEEL_PIXEL_LINE;
    const lines = Math.max(1, Math.round(Math.abs(y) / Math.max(1, lineHeight)));
    this.paneScrollHandler(pane.id, y < 0 ? -lines : lines);
    return true;
  }

  private forwardAlternateWheel(pane: SessionPaneView, event: WheelEvent): boolean {
    if (this.role !== 'operator' || !pane.alternate_on || !pane.mouse_on || !this.dataHandler) {
      return false;
    }
    const { y } = wheelDeltaPixels(event, this.container.clientHeight);
    if (y === 0) {
      return false;
    }
    const point = this.paneMousePoint(pane, event);
    if (!point) {
      return false;
    }
    const metrics = this.cellMetrics();
    const lineHeight = metrics?.height ?? WHEEL_PIXEL_LINE;
    const steps = Math.max(1, Math.min(6, Math.round(Math.abs(y) / Math.max(1, lineHeight))));
    const button = y < 0 ? 64 : 65;
    const sequence = `\x1b[<${button};${point.col};${point.row}M`;
    this.dataHandler(sequence.repeat(steps));
    return true;
  }

  private paneMousePoint(pane: SessionPaneView, event: MouseEvent): { col: number; row: number } | undefined {
    if (!this.sessionView) {
      return undefined;
    }
    const screen = this.term.element?.querySelector<HTMLElement>('.xterm-screen');
    if (!screen) {
      return undefined;
    }
    const rect = screen.getBoundingClientRect();
    const metrics = this.sessionCellMetrics();
    if (!metrics) {
      return undefined;
    }
    const sessionCol = Math.floor((event.clientX - rect.left) / metrics.width);
    const sessionRow = Math.floor((event.clientY - rect.top) / metrics.height);
    if (
      sessionCol < pane.x
      || sessionCol >= pane.x + pane.cols
      || sessionRow < pane.y
      || sessionRow >= pane.y + pane.rows
    ) {
      return undefined;
    }
    const col = Math.max(1, Math.min(this.sessionView.size.cols, sessionCol + 1));
    const row = Math.max(1, Math.min(this.sessionView.size.rows, sessionRow + 1));
    return { col, row };
  }

  private renderPaneScrollbars(): void {
    if (this.scope !== 'session' || !this.sessionView) {
      this.scrollLayer.replaceChildren();
      return;
    }
    const metrics = this.cellMetrics();
    if (!metrics) {
      return;
    }
    const focusedPane = this.focusedMobilePane();
    const panes = focusedPane ? [focusedPane] : this.sessionView.panes;
    const bars = panes
      .filter((pane) => pane.history_size > 0 && pane.rows > 0 && pane.cols > 0 && !pane.alternate_on)
      .map((pane) => this.renderPaneScrollbar(pane, metrics));
    this.scrollLayer.replaceChildren(...bars);
  }

  private renderPaneScrollbar(
    pane: SessionPaneView,
    metrics: { width: number; height: number },
  ): HTMLDivElement {
    const bar = document.createElement('div');
    bar.className = 'share-pane-scrollbar';
    const barWidth = Math.max(5, Math.min(10, metrics.width * 0.45));
    const height = pane.rows * metrics.height;
    const totalRows = pane.history_size + pane.rows;
    const thumbHeight = Math.max(18, height * (pane.rows / Math.max(1, totalRows)));
    const maxScroll = Math.max(1, pane.history_size);
    const travel = Math.max(0, height - thumbHeight);
    const thumbTop = travel * (1 - Math.min(maxScroll, pane.scroll_offset) / maxScroll);
    bar.style.left = `${(pane.x + pane.cols) * metrics.width - barWidth}px`;
    bar.style.top = `${pane.y * metrics.height}px`;
    bar.style.width = `${barWidth}px`;
    bar.style.height = `${height}px`;
    const thumb = document.createElement('div');
    thumb.className = 'share-pane-scrollbar-thumb';
    thumb.style.height = `${thumbHeight}px`;
    thumb.style.transform = `translateY(${thumbTop}px)`;
    bar.append(thumb);
    this.bindScrollbarDrag(bar, pane, height, thumbHeight);
    return bar;
  }

  private bindScrollbarDrag(
    bar: HTMLDivElement,
    pane: SessionPaneView,
    height: number,
    thumbHeight: number,
  ): void {
    let dragOffset = Math.max(0, pane.scroll_offset);
    const update = (clientY: number, top: number) => {
      const travel = Math.max(1, height - thumbHeight);
      const y = Math.min(travel, Math.max(0, clientY - top - thumbHeight / 2));
      const nextOffset = Math.round((1 - y / travel) * pane.history_size);
      if (!this.paneScrollHandler) {
        return;
      }
      const target = Math.max(0, Math.min(pane.history_size, nextOffset));
      if (target === dragOffset) {
        return;
      }
      this.paneScrollHandler(pane.id, target > dragOffset ? -(target - dragOffset) : dragOffset - target);
      dragOffset = target;
    };
    bar.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const { top } = bar.getBoundingClientRect();
      update(event.clientY, top);
      const onMove = (move: PointerEvent) => {
        if (move.pointerId !== event.pointerId) {
          return;
        }
        move.preventDefault();
        update(move.clientY, top);
      };
      const onUp = (up: PointerEvent) => {
        if (up.pointerId !== event.pointerId) {
          return;
        }
        window.removeEventListener('pointermove', onMove, true);
        window.removeEventListener('pointerup', onUp, true);
        window.removeEventListener('pointercancel', onUp, true);
      };
      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
      window.addEventListener('pointercancel', onUp, true);
    });
  }

  private requestPaneOffset(pane: SessionPaneView, nextOffset: number): void {
    if (!this.paneScrollHandler) {
      return;
    }
    const target = Math.max(0, Math.min(pane.history_size, nextOffset));
    const current = Math.max(0, pane.scroll_offset);
    if (target === current) {
      return;
    }
    this.paneScrollHandler(pane.id, target > current ? -(target - current) : current - target);
  }
}

export function isTerminalThemeName(value: string): value is TerminalThemeName {
  return value === 'user' || value === 'dark' || value === 'light';
}

export function terminalThemeMode(theme: TerminalThemeName, userTheme?: TerminalThemePalette): TerminalThemeMode {
  if (theme === 'light') {
    return 'light';
  }
  if (theme === 'dark') {
    return 'dark';
  }
  const palette = normalizeUserTheme(userTheme);
  if (palette) {
    return relativeLuminance(palette.background) > 0.5 ? 'light' : 'dark';
  }
  return userPrefersLight() ? 'light' : 'dark';
}

export function terminalChromePalette(
  theme: TerminalThemeName,
  userTheme?: TerminalThemePalette,
): TerminalChromePalette | undefined {
  if (theme !== 'user') {
    return undefined;
  }
  const palette = normalizeUserTheme(userTheme);
  if (!palette) {
    return undefined;
  }
  return {
    accent: readableAccent(palette),
    background: palette.background,
    foreground: palette.foreground,
    mode: terminalThemeMode(theme, palette),
  };
}

function optionsForRole(
  role: ShareRole,
  theme: TerminalThemeName,
  userTheme?: TerminalThemePalette,
  scrollback = SESSION_SCROLLBACK_LINES,
): ConstructorParameters<typeof Terminal>[0] {
  return {
    allowProposedApi: false,
    alternateScrollMode: false,
    convertEol: true,
    cursorBlink: role === 'operator',
    cursorStyle: role === 'operator' ? 'block' : 'underline',
    disableStdin: role === 'spectator',
    fontFamily: '"JetBrains Mono", "SFMono-Regular", Consolas, monospace',
    fontSize: 13,
    letterSpacing: 0,
    lineHeight: 1.2,
    scrollback,
    theme: themePalette(theme, userTheme),
    // rmux streams PTY output for a concrete remote geometry. Client-side
    // reflow corrupts redraw-heavy terminal UIs during resize.
    windowsPty: { backend: 'winpty' },
  };
}

function wheelDeltaPixels(event: WheelEvent, pageHeight: number): { x: number; y: number } {
  const unit = event.deltaMode === WheelEvent.DOM_DELTA_PAGE
    ? Math.max(1, pageHeight)
    : event.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? WHEEL_PIXEL_LINE
      : 1;
  return {
    x: event.deltaX * unit,
    y: event.deltaY * unit,
  };
}

function clampTerminalSize(value: number): number {
  return Math.max(MIN_TERMINAL_COLS, Math.min(0xffff, value));
}

function projectCell(cell: number, fromSize: number, toSize: number): number {
  if (fromSize <= 0 || toSize <= 0 || fromSize === toSize) {
    return cell;
  }
  return Math.min(toSize - 1, Math.max(0, Math.floor(cell * toSize / fromSize)));
}

function windowStatusLabelContains(text: string, window: SessionWindowView, col: number): boolean {
  if (col < 0 || !text) {
    return false;
  }
  const labels = [`${window.index}:${window.name}${window.active ? '*' : ''}`, `${window.index}:${window.name}`];
  return labels.some((label) => {
    const start = text.indexOf(label);
    return start >= 0 && col >= start && col < start + label.length;
  });
}

function integralDelta(value: number): number {
  return value < 0 ? Math.ceil(value) : Math.floor(value);
}

function nowMs(): number {
  return performance.now();
}

function paneClipPath(
  pane: SessionPaneView,
  metrics: { width: number; height: number },
  stageWidth: number,
  stageHeight: number,
): string {
  const top = Math.max(0, pane.y * metrics.height);
  const left = Math.max(0, pane.x * metrics.width);
  const right = Math.max(0, stageWidth - (pane.x + pane.cols) * metrics.width);
  const bottom = Math.max(0, stageHeight - (pane.y + pane.rows) * metrics.height);
  return `inset(${top}px ${right}px ${bottom}px ${left}px)`;
}

function snapshotGeometry(text: string): { cols: number; rows: number } {
  let row = 1;
  let column = 0;
  let maxColumn = 0;
  let maxRow = 1;
  for (let index = 0; index < text.length;) {
    const char = text[index];
    if (char === '\x1b') {
      const parsed = parseCsiCursor(text, index);
      if (parsed) {
        row = parsed.row;
        column = parsed.column;
        maxRow = Math.max(maxRow, row);
        index = parsed.next;
        continue;
      }
      const next = ansiSequenceEnd(text, index);
      index = next > index ? next : index + 1;
      continue;
    }
    if (char === '\r') {
      column = 0;
      index += 1;
      continue;
    }
    if (char === '\n') {
      row += 1;
      column = 0;
      maxRow = Math.max(maxRow, row);
      index += 1;
      continue;
    }
    column += 1;
    maxColumn = Math.max(maxColumn, column);
    index += 1;
  }
  return { cols: maxColumn, rows: maxRow };
}

function cursorRows(text: string): number[] {
  return [...text.matchAll(/\x1b\[([0-9;]*)([Hf])/g)]
    .map((match) => Number.parseInt(match[1].split(';')[0] || '1', 10))
    .filter((row) => Number.isFinite(row) && row >= MIN_TERMINAL_ROWS);
}

function projectRows(
  text: string,
  options: { maxContentRow: number; statusRow?: number; targetStatusRow: number },
): string {
  let out = '';
  let drop = false;
  for (let index = 0; index < text.length;) {
    if (text[index] === '\x1b') {
      const parsed = parseCsiCursor(text, index);
      if (parsed) {
        if (parsed.row === options.statusRow) {
          out += `\x1b[${options.targetStatusRow};${parsed.column + 1}H`;
          drop = false;
        } else if (parsed.row > options.maxContentRow) {
          drop = true;
        } else {
          out += text.slice(index, parsed.next);
          drop = false;
        }
        index = parsed.next;
        continue;
      }
      const next = ansiSequenceEnd(text, index);
      if (!drop) {
        out += text.slice(index, next);
      }
      index = next > index ? next : index + 1;
      continue;
    }
    if (!drop) {
      out += text[index];
    }
    index += 1;
  }
  return out;
}

function parseCsiCursor(text: string, start: number): { row: number; column: number; next: number } | undefined {
  if (text[start + 1] !== '[') {
    return undefined;
  }
  let index = start + 2;
  while (index < text.length && !isFinalByte(text.charCodeAt(index))) {
    index += 1;
  }
  const command = text[index];
  if (command !== 'H' && command !== 'f') {
    return undefined;
  }
  const params = text.slice(start + 2, index).split(';');
  const row = Math.max(1, Number.parseInt(params[0] || '1', 10));
  const column = Math.max(0, Number.parseInt(params[1] || '1', 10) - 1);
  return { row, column, next: index + 1 };
}

function ansiSequenceEnd(text: string, start: number): number {
  if (text[start + 1] === '[') {
    let index = start + 2;
    while (index < text.length && !isFinalByte(text.charCodeAt(index))) {
      index += 1;
    }
    return Math.min(index + 1, text.length);
  }
  return Math.min(start + 2, text.length);
}

function isFinalByte(code: number): boolean {
  return code >= 0x40 && code <= 0x7e;
}

function themePalette(
  theme: TerminalThemeName,
  userTheme?: TerminalThemePalette,
): NonNullable<ConstructorParameters<typeof Terminal>[0]>['theme'] {
  const palette = normalizeUserTheme(userTheme);
  if (theme === 'user' && palette) {
    return {
      background: palette.background,
      black: palette.ansi[0],
      blue: palette.ansi[4],
      brightBlack: palette.ansi[8],
      brightBlue: palette.ansi[12],
      brightCyan: palette.ansi[14],
      brightGreen: palette.ansi[10],
      brightMagenta: palette.ansi[13],
      brightRed: palette.ansi[9],
      brightWhite: palette.ansi[15],
      brightYellow: palette.ansi[11],
      cursor: palette.cursor,
      cursorAccent: palette.background,
      cyan: palette.ansi[6],
      foreground: palette.foreground,
      green: palette.ansi[2],
      magenta: palette.ansi[5],
      red: palette.ansi[1],
      selectionBackground: selectionBackground(palette.background),
      white: palette.ansi[7],
      yellow: palette.ansi[3],
    };
  }

  if (terminalThemeMode(theme, userTheme) === 'light') {
    return {
      background: '#f5f1e8',
      black: '#1f2623',
      blue: '#1f6fd1',
      brightBlack: '#69736f',
      brightBlue: '#3f88e8',
      brightCyan: '#178f88',
      brightGreen: '#2f8f46',
      brightMagenta: '#9a5fc1',
      brightRed: '#c84f4f',
      brightWhite: '#ffffff',
      brightYellow: '#ad7f18',
      cursor: '#1f2623',
      cursorAccent: '#f5f1e8',
      cyan: '#0d7973',
      foreground: '#1f2623',
      green: '#257a37',
      magenta: '#824aa5',
      red: '#b13d3d',
      selectionBackground: '#c9ded7',
      white: '#d8d2c7',
      yellow: '#92670f',
    };
  }

  return {
    background: '#0b1416',
    black: '#071012',
    blue: '#7da7c7',
    brightBlack: '#58615e',
    brightBlue: '#9fc0d3',
    brightCyan: '#7bded4',
    brightGreen: '#90d67f',
    brightMagenta: '#d7a1ff',
    brightRed: '#ff8585',
    brightWhite: '#ffffff',
    brightYellow: '#f0d06b',
    cursor: '#e9eeec',
    cursorAccent: '#0b1416',
    cyan: '#4fc5bd',
    foreground: '#e8eee9',
    green: '#72c468',
    magenta: '#c790e8',
    red: '#ef6f6c',
    selectionBackground: '#285a48',
    white: '#d8dedc',
    yellow: '#d8b84f',
  };
}

function userPrefersLight(): boolean {
  return typeof window !== 'undefined'
    && window.matchMedia('(prefers-color-scheme: light)').matches;
}

function normalizeUserTheme(theme?: TerminalThemePalette): TerminalThemePalette | undefined {
  if (!theme || theme.ansi.length !== 16) {
    return undefined;
  }
  const colors = [theme.foreground, theme.background, theme.cursor, ...theme.ansi];
  if (!colors.every(isHexColor)) {
    return undefined;
  }
  return theme;
}

function isHexColor(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(value);
}

function relativeLuminance(hex: string): number {
  const red = parseInt(hex.slice(1, 3), 16) / 255;
  const green = parseInt(hex.slice(3, 5), 16) / 255;
  const blue = parseInt(hex.slice(5, 7), 16) / 255;
  return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
}

function channel(value: number): number {
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function selectionBackground(background: string): string {
  return relativeLuminance(background) > 0.5 ? '#c9ded7' : '#285a48';
}

function readableAccent(palette: TerminalThemePalette): string {
  const preferred = [palette.ansi[4], palette.ansi[6], palette.ansi[2], palette.cursor];
  const background = relativeLuminance(palette.background);
  return preferred.find((color) => Math.abs(relativeLuminance(color) - background) > 0.22)
    ?? palette.foreground;
}
