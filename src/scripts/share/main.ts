import '@xterm/xterm/css/xterm.css';
import '../../styles/share.css';
import '../../styles/share-chrome.css';
import '../../styles/share-dialogs.css';
import '../../styles/share-home.css';

import { startShareApp } from './controller';
import { hasActiveShareParams, hasShareFragment } from './fragment';
import { startShareHome } from './home';
import { registerShareServiceWorker } from './pwa';
import { trackShareWindowBounds } from './window-bounds';

export function mountShareApp(target: Element | null = document.body): void {
  if (!target) {
    throw new Error('missing share mount target');
  }

  const root = document.createElement('div');
  root.className = 'share-root';
  const shareMode = hasShareFragment(window.location.hash) || hasActiveShareParams();
  document.body.classList.toggle('home-page', !shareMode);
  document.body.classList.toggle('share-body', shareMode);
  if (target === document.body) {
    document.body.replaceChildren(root);
  } else {
    target.replaceChildren(root);
  }
  registerShareServiceWorker();
  if (shareMode) {
    trackShareWindowBounds();
    startShareApp(root);
  } else {
    startShareHome(root);
  }
}
