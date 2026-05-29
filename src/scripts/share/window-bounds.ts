const SHARE_WINDOW_BOUNDS_KEY = 'rmux.share.windowBounds.v1';
const DEFAULT_WIDTH = 1200;
const DEFAULT_HEIGHT = 760;
const PAIRING_WIDTH = 680;
const PAIRING_HEIGHT = 560;
const MIN_WIDTH = 720;
const MIN_HEIGHT = 520;
const MIN_TERMINAL_WIDTH = 960;
const MIN_TERMINAL_HEIGHT = 680;

let saveBounds = false;

interface ShareWindowBounds {
  width: number;
  height: number;
  left: number;
  top: number;
}

export function shareWindowFeatures(mode: 'terminal' | 'pairing' = 'terminal'): string {
  const bounds = mode === 'pairing'
    ? centeredBounds(PAIRING_WIDTH, PAIRING_HEIGHT, PAIRING_WIDTH, PAIRING_HEIGHT)
    : terminalBounds();
  return [
    'popup=yes',
    `width=${bounds.width}`,
    `height=${bounds.height}`,
    `left=${bounds.left}`,
    `top=${bounds.top}`,
    'menubar=no',
    'toolbar=no',
    'location=no',
    'status=no',
    'scrollbars=no',
    'resizable=yes',
  ].join(',');
}

export function shouldOpenShareInCurrentTab(): boolean {
  return window.matchMedia('(max-width: 820px), (pointer: coarse)').matches;
}

export function trackShareWindowBounds(): void {
  const save = throttle(() => {
    if (!saveBounds) {
      return;
    }
    writeWindowBounds({
      width: window.outerWidth,
      height: window.outerHeight,
      left: window.screenX,
      top: window.screenY,
    });
  }, 300);
  window.addEventListener('resize', save);
  window.addEventListener('beforeunload', () => save.flush());
}

export function enableShareWindowBoundsTracking(): void {
  saveBounds = true;
}

export function resizeShareWindowForPairingPrompt(): void {
  saveBounds = false;
  resizeWindow(centeredBounds(PAIRING_WIDTH, PAIRING_HEIGHT, PAIRING_WIDTH, PAIRING_HEIGHT));
}

export function resizeShareWindowForTerminal(): void {
  resizeWindow(terminalBounds());
  saveBounds = true;
}

function loadWindowBounds(): ShareWindowBounds | undefined {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SHARE_WINDOW_BOUNDS_KEY) ?? 'null') as unknown;
    return isWindowBounds(parsed) ? clampBounds(parsed) : undefined;
  } catch {
    return undefined;
  }
}

function writeWindowBounds(bounds: ShareWindowBounds): void {
  if (!isWindowBounds(bounds)) {
    return;
  }
  try {
    window.localStorage.setItem(SHARE_WINDOW_BOUNDS_KEY, JSON.stringify(clampBounds(bounds)));
  } catch {
    // Window geometry is optional preference state.
  }
}

function terminalBounds(): ShareWindowBounds {
  return loadWindowBounds() ?? centeredBounds(DEFAULT_WIDTH, DEFAULT_HEIGHT, MIN_TERMINAL_WIDTH, MIN_TERMINAL_HEIGHT);
}

function centeredBounds(
  preferredWidth = DEFAULT_WIDTH,
  preferredHeight = DEFAULT_HEIGHT,
  minWidth = MIN_WIDTH,
  minHeight = MIN_HEIGHT,
): ShareWindowBounds {
  const availableWidth = window.screen.availWidth || window.innerWidth || DEFAULT_WIDTH;
  const availableHeight = window.screen.availHeight || window.innerHeight || DEFAULT_HEIGHT;
  const width = Math.min(preferredWidth, Math.max(minWidth, availableWidth - 80));
  const height = Math.min(preferredHeight, Math.max(minHeight, availableHeight - 80));
  const screenOffset = window.screen as Screen & { availLeft?: number; availTop?: number };
  return {
    width,
    height,
    left: Math.max(0, Math.round((availableWidth - width) / 2 + (screenOffset.availLeft ?? 0))),
    top: Math.max(0, Math.round((availableHeight - height) / 2 + (screenOffset.availTop ?? 0))),
  };
}

function clampBounds(bounds: ShareWindowBounds): ShareWindowBounds {
  const availableWidth = window.screen.availWidth || bounds.width;
  const availableHeight = window.screen.availHeight || bounds.height;
  const width = Math.min(Math.max(Math.round(bounds.width), MIN_TERMINAL_WIDTH), Math.max(MIN_TERMINAL_WIDTH, availableWidth));
  const height = Math.min(Math.max(Math.round(bounds.height), MIN_TERMINAL_HEIGHT), Math.max(MIN_TERMINAL_HEIGHT, availableHeight));
  return {
    width,
    height,
    left: Math.max(0, Math.round(bounds.left)),
    top: Math.max(0, Math.round(bounds.top)),
  };
}

function resizeWindow(bounds: ShareWindowBounds): void {
  try {
    window.moveTo(bounds.left, bounds.top);
    window.resizeTo(bounds.width, bounds.height);
  } catch {
    // Browsers may ignore resize requests for normal tabs.
  }
}

function isWindowBounds(value: unknown): value is ShareWindowBounds {
  return Boolean(
    value
      && typeof value === 'object'
      && finitePositive((value as ShareWindowBounds).width)
      && finitePositive((value as ShareWindowBounds).height)
      && Number.isFinite((value as ShareWindowBounds).left)
      && Number.isFinite((value as ShareWindowBounds).top),
  );
}

function finitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function throttle(callback: () => void, delayMs: number): (() => void) & { flush: () => void } {
  let timeout: number | undefined;
  const run = () => {
    timeout = undefined;
    callback();
  };
  const throttled = () => {
    if (timeout !== undefined) {
      return;
    }
    timeout = window.setTimeout(run, delayMs);
  };
  throttled.flush = () => {
    if (timeout !== undefined) {
      window.clearTimeout(timeout);
      timeout = undefined;
    }
    callback();
  };
  return throttled;
}
