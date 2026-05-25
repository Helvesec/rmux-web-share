import '@xterm/xterm/css/xterm.css';
import '../../styles/share.css';
import '../../styles/share-chrome.css';
import '../../styles/share-dialogs.css';

import { startShareApp } from './controller';
import { registerShareServiceWorker } from './pwa';

export function mountShareApp(target: Element | null = document.body): void {
  if (!target) {
    throw new Error('missing share mount target');
  }

  const root = document.createElement('div');
  root.className = 'share-root';
  if (target === document.body) {
    document.body.replaceChildren(root);
    document.body.classList.remove('home-page');
    document.body.classList.add('share-body');
  } else {
    target.replaceChildren(root);
  }
  registerShareServiceWorker();
  startShareApp(root);
}
