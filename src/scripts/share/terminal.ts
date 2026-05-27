import { ImageAddon } from '@xterm/addon-image';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import type { IDisposable } from '@xterm/xterm';

import type { ShareRole, ShareScope, TerminalThemeName, TerminalThemePalette } from './types';

export type { TerminalThemeName } from './types';
export type TerminalThemeMode = 'dark' | 'light';

export const DEFAULT_TERMINAL_THEME: TerminalThemeName = 'user';
const LIVE_SCROLLBACK_LINES = 0;
const BOTTOM_STICKY_THRESHOLD_PX = 8;
const WHEEL_PIXEL_LINE = 16;
const IMAGE_PIXEL_LIMIT = 4_194_304;
const IMAGE_SEQUENCE_LIMIT = 8_000_000;
const IMAGE_STORAGE_MB = 48;
const MIN_TERMINAL_COLS = 2;
const MIN_TERMINAL_ROWS = 2;

export interface TerminalChromePalette {
  accent: string;
  background: string;
  foreground: string;
  mode: TerminalThemeMode;
}

export interface ShareTerminal {
  role: ShareRole;
  term: Terminal;
  syncViewport(): void;
  setRole(role: ShareRole): void;
  setTheme(theme: TerminalThemeName, userTheme?: TerminalThemePalette): void;
  replace(data: Uint8Array): void;
  write(data: Uint8Array): void;
  resize(cols: number, rows: number): void;
  dispose(): void;
  onData(callback: (data: string) => void): void;
  onMouseInput(callback: (data: string) => void): void;
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
  controller.resize(cols, rows);
  if (role === 'operator') {
    controller.term.focus();
  }
  return controller;
}

class XtermShareTerminal implements ShareTerminal {
  readonly term: Terminal;
  role: ShareRole;

  private readonly decoder = new TextDecoder();
  private readonly stage: HTMLDivElement;
  private readonly disposables: IDisposable[] = [];
  private stickToBottom = true;
  private operationQueue = Promise.resolve();
  private disposed = false;
  private lastSnapshotText?: string;
  private remoteCols = 0;
  private remoteRows = 0;
  private snapshotCols = 0;
  private snapshotRows = 0;

  constructor(
    private readonly container: HTMLElement,
    private readonly scope: ShareScope,
    role: ShareRole,
    theme: TerminalThemeName,
    private userTheme?: TerminalThemePalette,
  ) {
    this.role = role;
    this.term = new Terminal(optionsForRole(role, theme));
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
    container.append(this.stage);
    this.setTheme(theme, userTheme);
    this.term.attachCustomKeyEventHandler(() => this.role !== 'read');
    this.bindScrollAnchor();
  }

  open(): void {
    this.term.open(this.stage);
  }

  syncViewport(): void {
    if (this.scope === 'session') {
      this.enqueue((done) => {
        this.resizeSessionGrid();
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

  setRole(role: ShareRole): void {
    this.role = role;
    this.term.options.disableStdin = role === 'read';
    this.term.options.cursorBlink = role === 'operator';
    this.term.options.cursorStyle = role === 'operator' ? 'block' : 'underline';
  }

  setTheme(theme: TerminalThemeName, userTheme = this.userTheme): void {
    this.userTheme = userTheme;
    this.container.dataset.theme = theme;
    this.container.dataset.themeMode = terminalThemeMode(theme, userTheme);
    this.term.options.theme = themePalette(theme, userTheme);
    if (this.term.element) {
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
        this.writeDecodedNow(this.projectSessionFrame(text), false, () => {
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

  dispose(): void {
    this.disposed = true;
    this.disposables.splice(0).forEach((disposable) => disposable.dispose());
    this.term.dispose();
  }

  onData(callback: (data: string) => void): void {
    this.disposables.push(this.term.onData(callback));
  }

  onMouseInput(callback: (data: string) => void): void {
    const onMouseDown = (event: MouseEvent) => {
      if (this.scope !== 'session' || this.role !== 'operator' || event.button !== 0) {
        return;
      }
      const cell = this.cellFromMouseEvent(event);
      if (!cell) {
        return;
      }
      event.preventDefault();
      this.term.focus();
      callback(`\x1b[<0;${cell.col};${cell.row}M`);
    };
    this.stage.addEventListener('mousedown', onMouseDown);
    this.disposables.push({
      dispose: () => this.stage.removeEventListener('mousedown', onMouseDown),
    });
  }

  notice(text: string): void {
    this.term.writeln(`\r\n${text}`);
  }

  bindLocalWheelScroll(): void {
    const onWheel = (event: WheelEvent) => {
      if (!this.container.contains(event.target as Node | null)) {
        return;
      }
      const { x, y } = wheelDeltaPixels(event, this.container.clientHeight);
      if (x === 0 && y === 0) {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      this.container.scrollLeft += x;
      this.container.scrollTop += y;
    };
    this.container.addEventListener('wheel', onWheel, { capture: true, passive: false });
    this.disposables.push({
      dispose: () => this.container.removeEventListener('wheel', onWheel, { capture: true }),
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
    const onScroll = () => {
      this.stickToBottom = this.isNearBottom();
    };
    this.container.addEventListener('scroll', onScroll, { passive: true });
    this.disposables.push({
      dispose: () => this.container.removeEventListener('scroll', onScroll),
    });
  }

  private scrollToBottom(): void {
    this.container.scrollTop = this.container.scrollHeight;
    this.stickToBottom = true;
  }

  private scrollToTop(): void {
    this.container.scrollTop = 0;
    this.stickToBottom = false;
  }

  private scrollToTopLeft(): void {
    this.container.scrollLeft = 0;
    this.scrollToTop();
  }

  private isNearBottom(): boolean {
    return this.container.scrollTop + this.container.clientHeight
      >= this.container.scrollHeight - BOTTOM_STICKY_THRESHOLD_PX;
  }

  private writeSessionSnapshotNow(text: string, done: () => void): void {
    this.resizeSessionGrid();
    this.writeDecodedNow(this.projectSessionFrame(text), false, () => {
      this.fitSessionStage();
      this.scrollToTopLeft();
      done();
    });
  }

  private projectSessionFrame(text: string): string {
    return projectRows(text, {
      maxContentRow: Math.max(1, this.term.rows - 1),
      statusRow: this.sessionStatusRow(text),
      targetStatusRow: this.term.rows,
    });
  }

  private sessionStatusRow(text: string): number | undefined {
    const rows = cursorRows(text);
    if (!rows.length) {
      return undefined;
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
    return {
      cols: Math.max(
        this.remoteCols,
        this.snapshotCols,
        MIN_TERMINAL_COLS,
      ),
      rows: Math.max(this.remoteRows, this.snapshotRows, MIN_TERMINAL_ROWS),
    };
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
    this.term.clearTextureAtlas();
    this.term.refresh(0, this.term.rows - 1);
    return true;
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
    const scale = Math.min(1, this.container.clientWidth / width, this.container.clientHeight / height);
    this.stage.style.transform = scale < 0.999 ? `scale(${scale})` : 'none';
  }

  private cellFromMouseEvent(event: MouseEvent): { col: number; row: number } | undefined {
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
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) {
      return undefined;
    }
    return {
      col: Math.min(this.term.cols, Math.max(1, Math.floor(x / cellWidth) + 1)),
      row: Math.min(this.term.rows, Math.max(1, Math.floor(y / cellHeight) + 1)),
    };
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
): ConstructorParameters<typeof Terminal>[0] {
  return {
    allowProposedApi: false,
    alternateScrollMode: false,
    convertEol: true,
    cursorBlink: role === 'operator',
    cursorStyle: role === 'operator' ? 'block' : 'underline',
    disableStdin: role === 'read',
    fontFamily: '"JetBrains Mono", "SFMono-Regular", Consolas, monospace',
    fontSize: 13,
    letterSpacing: 0,
    lineHeight: 1.2,
    scrollback: LIVE_SCROLLBACK_LINES,
    theme: themePalette(theme),
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
    background: '#060807',
    black: '#0a0d0c',
    blue: '#5aa7ff',
    brightBlack: '#58615e',
    brightBlue: '#82bcff',
    brightCyan: '#7bded4',
    brightGreen: '#90d67f',
    brightMagenta: '#d7a1ff',
    brightRed: '#ff8585',
    brightWhite: '#ffffff',
    brightYellow: '#f0d06b',
    cursor: '#e9eeec',
    cursorAccent: '#060807',
    cyan: '#4fc5bd',
    foreground: '#e9eeec',
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
