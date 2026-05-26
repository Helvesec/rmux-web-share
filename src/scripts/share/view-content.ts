import { shareAssetUrl } from './fragment';
import type { ShareRole } from './types';

export function shareViewTemplate(): string {
  return `
    <main class="share-app" data-chrome="visible" data-navbar="visible" data-operator="free" data-role="read" data-controls="disabled" data-terminal-mode="dark" data-terminal-theme="user">
      <header class="share-topbar">
        <div class="share-brand">
          <a class="share-brand-home" href="https://rmux.io/" aria-label="RMUX">
            <span class="share-brand-mark" aria-hidden="true">
              <img class="share-brand-logo share-brand-logo-dark" src="${shareAssetUrl('rmux-logo-dark.svg')}" alt="" />
              <img class="share-brand-logo share-brand-logo-light" src="${shareAssetUrl('rmux-logo-light.svg')}" alt="" />
            </span>
            <span class="share-brand-title">RMUX</span>
          </a>
          <span class="share-brand-divider" aria-hidden="true"></span>
          <span class="share-brand-context">Web Multiplex</span>
        </div>
        <div class="share-topbar-meta">
          <span class="share-role-badge">
            <svg class="share-role-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none">
              <path d="M7 10V8a5 5 0 0 1 10 0v2" />
              <rect x="5" y="10" width="14" height="10" rx="2.5" />
              <path d="M12 14v2.5" />
            </svg>
            <span data-share-role>Read Only</span>
          </span>
          <span class="share-session-label" data-share-meta hidden>rmux share</span>
          <span class="share-viewer-count" data-share-viewers hidden aria-label="Connected browsers">
            <svg class="share-viewer-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none">
              <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
              <circle cx="12" cy="12" r="2.8" />
            </svg>
            <span data-share-viewers-count>0</span>
          </span>
          <span class="share-controls-inline" data-share-controls hidden>
            <span class="share-controls-copy">Controls</span>
            <button class="share-controls-toggle" data-share-controls-passthrough type="button" aria-pressed="false">rmux keys</button>
          </span>
          <label class="share-theme-control">
            <span class="share-visually-hidden">Terminal theme</span>
            <svg class="share-theme-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2v2.5M12 19.5V22M4.93 4.93 6.7 6.7M17.3 17.3l1.77 1.77M2 12h2.5M19.5 12H22M4.93 19.07 6.7 17.3M17.3 6.7l1.77-1.77" />
            </svg>
            <select class="share-theme-select" data-share-terminal-theme aria-label="Terminal theme">
              <option value="user">Client</option>
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
          </label>
          <span class="share-operator-state" aria-hidden="true"></span>
          <button class="share-status" data-share-status-menu type="button" data-tone="idle" aria-haspopup="dialog">
            <span data-share-status>Disconnected</span>
            <span class="share-status-chevron" aria-hidden="true"></span>
          </button>
          <button class="share-chrome-button share-chrome-hide" data-share-chrome-hide type="button" aria-label="Hide toolbar" title="Hide toolbar">
            <span aria-hidden="true"></span>
          </button>
        </div>
      </header>
      <button class="share-chrome-button share-chrome-show" data-share-chrome-show type="button" aria-label="Show toolbar" title="Show toolbar">
        <span aria-hidden="true"></span>
      </button>
      <section class="share-terminal-shell" aria-label="Shared terminal">
        <div class="share-terminal" data-share-terminal>
          <div class="share-terminal-placeholder" data-share-terminal-placeholder data-tone="idle">waiting</div>
        </div>
        <div class="share-reconnect" data-share-reconnect hidden>
          <div class="share-reconnect-panel">
            <h1>Disconnected from this share</h1>
            <p>The share link is kept only in this tab. Reconnect now or copy the link before closing it.</p>
            <div class="share-reconnect-actions">
              <button data-share-reconnect-copy type="button">Copy link</button>
              <button data-share-reconnect-connect class="primary" type="button">Reconnect</button>
            </div>
          </div>
        </div>
      </section>
      <aside class="share-toast" data-share-toast role="status" aria-live="polite" hidden></aside>
      <dialog class="share-session-actions" data-share-session-actions>
        <form method="dialog" class="share-session-actions-panel">
          <h1>Connection actions</h1>
          <p>Disconnect closes only this browser. Close rmux session stops the shared session for everyone.</p>
          <div class="share-confirm-actions">
            <button data-share-session-detach type="button">Disconnect browser</button>
            <button data-share-session-logout class="danger" type="button">Close rmux session</button>
          </div>
        </form>
      </dialog>
      <dialog class="share-confirm" data-share-confirm>
        <form method="dialog" class="share-confirm-panel">
          <h1>Connect to <span data-share-endpoint></span>?</h1>
          <p data-share-confirm-detail></p>
          <label class="share-pin" data-share-pin-group hidden>
            <span>Pairing code</span>
            <input data-share-pin inputmode="numeric" pattern="[0-9]{6}" autocomplete="one-time-code" maxlength="6" placeholder="000000" />
            <small data-share-pin-error></small>
          </label>
          <a class="share-confirm-help" href="https://rmux.io/docs/web-share/#first-time-on-chrome" target="_blank" rel="noopener noreferrer">
            Connection help
          </a>
          <button class="share-provenance-trigger" data-share-provenance-open type="button">Security & provenance</button>
          <div class="share-confirm-actions">
            <button data-share-confirm-cancel type="button">Cancel</button>
            <button data-share-confirm-connect class="primary" type="button">Connect</button>
          </div>
        </form>
      </dialog>
      <dialog class="share-provenance" data-share-provenance>
        <form method="dialog" class="share-provenance-panel">
          <h1>Security & provenance</h1>
          <p data-share-provenance-statement>
            share.rmux.io serves only the static frontend and does not relay terminal data. The token stays in the URL fragment, the source is public, builds are verifiable, deployments are traceable, and the frontend can be self-hosted.
          </p>
          <dl class="share-provenance-list">
            <div>
              <dt>GitHub SHA-1</dt>
              <dd><a data-share-provenance-commit href="https://github.com/Helvesec/rmux-web-share" target="_blank" rel="noopener noreferrer">loading</a></dd>
            </div>
            <div>
              <dt>Build run</dt>
              <dd><a data-share-provenance-run href="https://github.com/Helvesec/rmux-web-share/actions" target="_blank" rel="noopener noreferrer">loading</a></dd>
            </div>
            <div>
              <dt>Cloudflare</dt>
              <dd><a data-share-provenance-cloudflare href="https://github.com/Helvesec/rmux-web-share/actions" target="_blank" rel="noopener noreferrer">deployment proof</a></dd>
            </div>
            <div>
              <dt>Asset hashes</dt>
              <dd><a href="${shareAssetUrl('checksums.txt')}" target="_blank" rel="noopener noreferrer">checksums.txt</a></dd>
            </div>
          </dl>
          <div class="share-confirm-actions">
            <button type="submit">Close</button>
          </div>
        </form>
      </dialog>
    </main>
  `;
}

export function privacyToastContent(endpoint: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const icon = document.createElement('span');
  icon.className = 'share-toast-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = '🔒';

  const body = document.createElement('span');
  body.className = 'share-toast-body';
  body.textContent = privacyToastMessage(endpoint);

  const link = document.createElement('a');
  link.href = 'https://rmux.io/docs/web-share/';
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = 'More info';

  fragment.append(icon, body, link);
  return fragment;
}

function privacyToastMessage(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    if (url.protocol === 'wss:') {
      return `Secure WebSocket to ${url.host}. share.rmux.io only served this static client; terminal data does not pass through share.rmux.io.`;
    }
    if (isLoopbackHost(url.hostname)) {
      return `Local client-side session. share.rmux.io only served this static app; terminal data stays between this browser and ${url.host}.`;
    }
    return `Client-side session. Terminal data connects directly to ${url.host}; share.rmux.io only served the static app.`;
  } catch {
    return 'Client-side session. share.rmux.io only served the static app; terminal data connects to the endpoint in this link.';
  }
}

function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

export function titleCase(role: ShareRole): string {
  return role === 'operator' ? 'Operator' : 'Read Only';
}
