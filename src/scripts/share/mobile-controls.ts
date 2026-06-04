export interface MobileControlHandlers {
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

const MOBILE_CONTROL_ACTIONS = [
  'splitHorizontal',
  'splitVertical',
  'newWindow',
  'killPane',
  'stopProcess',
  'clearScreen',
  'reverseSearch',
  'copyPane',
  'copy',
  'paste',
] as const satisfies readonly (keyof MobileControlHandlers)[];

export type MobileControlAction = (typeof MOBILE_CONTROL_ACTIONS)[number];

export interface MobileControlButtonBinding {
  button: HTMLButtonElement;
  action: MobileControlAction;
}

export function bindMobileControlMenu(
  menu: HTMLElement,
  bindings: readonly MobileControlButtonBinding[],
  runAction: (action: MobileControlAction) => void,
): void {
  for (const { button, action } of bindings) {
    button.dataset.mobileControlAction = action;
  }

  menu.addEventListener(
    'pointerdown',
    (event) => {
      const button = mobileControlButtonFromEvent(menu, event);
      if (!button) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      runMobileControlButton(button, runAction);
    },
    { capture: true },
  );

  menu.addEventListener('click', (event) => {
    if (event.detail !== 0) {
      return;
    }
    const button = mobileControlButtonFromEvent(menu, event);
    if (!button) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    runMobileControlButton(button, runAction);
  });
}

function mobileControlButtonFromEvent(menu: HTMLElement, event: Event): HTMLButtonElement | undefined {
  for (const node of event.composedPath()) {
    if (
      node instanceof HTMLButtonElement
      && menu.contains(node)
      && isMobileControlAction(node.dataset.mobileControlAction)
      && !node.disabled
    ) {
      return node;
    }
  }
  return undefined;
}

function runMobileControlButton(
  button: HTMLButtonElement,
  runAction: (action: MobileControlAction) => void,
): void {
  const action = button.dataset.mobileControlAction;
  if (isMobileControlAction(action)) {
    runAction(action);
  }
}

function isMobileControlAction(value: string | undefined): value is MobileControlAction {
  return value !== undefined && (MOBILE_CONTROL_ACTIONS as readonly string[]).includes(value);
}
