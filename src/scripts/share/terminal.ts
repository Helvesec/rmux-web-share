import { ImageAddon } from '@xterm/addon-image';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import type { IDisposable } from '@xterm/xterm';

import type { ShareRole, TerminalThemeName, TerminalThemePalette } from './types';

export type { TerminalThemeName } from './types';
export type TerminalThemeMode = 'dark' | 'light';

export const DEFAULT_TERMINAL_THEME: TerminalThemeName = 'user';
const LIVE_SCROLLBACK_LINES = 2000;
const BOTTOM_STICKY_THRESHOLD_PX = 8;
const IMAGE_PIXEL_LIMIT = 4_194_304;
const IMAGE_SEQUENCE_LIMIT = 8_000_000;
const IMAGE_STORAGE_MB = 48;

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
  notice(text: string): void;
}

export function openShareTerminal(
  container: HTMLElement,
  role: ShareRole,
  cols: number,
  rows: number,
  theme: TerminalThemeName = DEFAULT_TERMINAL_THEME,
  userTheme?: TerminalThemePalette,
): ShareTerminal {
  const controller = new XtermShareTerminal(container, role, theme, userTheme);
  controller.open();
  controller.term.resize(cols, rows);
  controller.syncViewport();
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

  constructor(
    private readonly container: HTMLElement,
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
    this.syncViewport();
  }

  replace(data: Uint8Array): void {
    this.decoder.decode();
    const text = this.decoder.decode(data);
    this.enqueue((done) => {
      this.term.reset();
      this.writeDecodedNow(text, true, done);
    });
  }

  write(data: Uint8Array): void {
    const text = this.decoder.decode(data, { stream: true });
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
      if (this.term.cols !== cols || this.term.rows !== rows) {
        this.term.resize(cols, rows);
        this.term.clearTextureAtlas();
        this.term.refresh(0, this.term.rows - 1);
      }
      this.scrollToBottom();
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

  notice(text: string): void {
    this.term.writeln(`\r\n${text}`);
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

  private isNearBottom(): boolean {
    return this.container.scrollTop + this.container.clientHeight
      >= this.container.scrollHeight - BOTTOM_STICKY_THRESHOLD_PX;
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
    convertEol: false,
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
