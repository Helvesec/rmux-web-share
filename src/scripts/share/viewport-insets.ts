const MAX_VIEWPORT_SCALE_FOR_INSETS = 1.01;
const MIN_KEYBOARD_INSET_PX = 90;

interface ViewportLike {
  height: number;
  offsetTop: number;
  scale: number;
}

export interface ShareViewportInsetInput {
  activeElement: Element | null;
  connected: boolean;
  dialogOpen: boolean;
  mobileViewport: boolean;
  terminalElement: HTMLElement;
  viewport: ViewportLike;
  windowHeight: number;
}

export interface ShareViewportInsets {
  keyboard: number;
  bottom: number;
  top: number;
}

export function measureShareViewportInsets(input: ShareViewportInsetInput): ShareViewportInsets {
  if (!input.mobileViewport || input.dialogOpen || input.viewport.scale > MAX_VIEWPORT_SCALE_FOR_INSETS) {
    return zeroInsets();
  }

  const top = positiveRound(input.viewport.offsetTop);
  const bottom = positiveRound(input.windowHeight - input.viewport.offsetTop - input.viewport.height);
  const keyboard = positiveRound(input.windowHeight - input.viewport.height);
  const keyboardCanLift =
    input.connected
    && terminalHasEditableFocus(input.terminalElement, input.activeElement)
    && keyboard > MIN_KEYBOARD_INSET_PX
    && bottom > MIN_KEYBOARD_INSET_PX;

  if (keyboardCanLift) {
    return { top: 0, bottom: 0, keyboard };
  }

  return { top, bottom, keyboard: 0 };
}

function zeroInsets(): ShareViewportInsets {
  return { top: 0, bottom: 0, keyboard: 0 };
}

function positiveRound(value: number): number {
  return Math.max(0, Math.round(value));
}

function terminalHasEditableFocus(terminal: HTMLElement, active: Element | null): boolean {
  if (!(active instanceof HTMLElement) || !terminal.contains(active)) {
    return false;
  }

  return active instanceof HTMLTextAreaElement
    || active instanceof HTMLInputElement
    || active.isContentEditable;
}
