import { shareAssetUrl } from './fragment';
import type { ShareRole } from './types';

export function shareViewTemplate(): string {
  return `
    <main class="share-app" data-chrome="visible" data-navbar="visible" data-connected="false" data-operator="free" data-role="spectator" data-terminal-mode="dark" data-terminal-theme="user">
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
        <nav class="share-topbar-actions" data-share-session-controls hidden aria-label="Session controls">
          <button class="share-icon-button" data-share-split-horizontal type="button" aria-label="Split right" title="Split right">
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
              <rect x="4" y="5" width="16" height="14" rx="1.5" />
              <path d="M12 5v14" />
            </svg>
          </button>
          <button class="share-icon-button" data-share-split-vertical type="button" aria-label="Split down" title="Split down">
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
              <rect x="4" y="5" width="16" height="14" rx="1.5" />
              <path d="M4 12h16" />
            </svg>
          </button>
          <button class="share-icon-button" data-share-new-window type="button" aria-label="New window" title="New window">
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
              <rect x="5" y="5" width="14" height="14" rx="1.5" />
              <path d="M12 8v8M8 12h8" />
            </svg>
          </button>
          <button class="share-icon-button" data-share-kill-pane type="button" aria-label="Close active pane" title="Close active pane">
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </nav>
        <div class="share-topbar-meta">
          <span class="share-role-badge" title="Read-only">
            <svg class="share-role-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none">
              <path d="M10 5h4M6 9h12M7 9v8h10V9M4 4l16 16" />
            </svg>
            <span class="share-visually-hidden" data-share-role>Spectator</span>
          </span>
          <span class="share-session-label" data-share-meta hidden>rmux share</span>
          <span class="share-viewer-count" data-share-viewers hidden aria-label="Connected browsers">
            <svg class="share-viewer-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none">
              <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
              <circle cx="12" cy="12" r="2.8" />
            </svg>
            <span data-share-viewers-count>0</span>
          </span>
          <span class="share-visually-hidden" data-share-status>Disconnected</span>
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
          <button class="share-exit-button" data-share-session-menu type="button" aria-haspopup="dialog" aria-label="Connection actions" title="Connection actions">
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
              <path d="M10 5H6.5A2.5 2.5 0 0 0 4 7.5v9A2.5 2.5 0 0 0 6.5 19H10" />
              <path d="M15 8l4 4-4 4" />
              <path d="M9 12h10" />
            </svg>
          </button>
        </div>
      </header>
      <button class="share-chrome-button share-chrome-hide" data-share-chrome-hide type="button" hidden></button>
      <button class="share-chrome-button share-chrome-show" data-share-chrome-show type="button" hidden></button>
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
      <dialog class="share-session-actions" data-share-session-actions>
        <form method="dialog" class="share-session-actions-panel">
          <h1>Connection actions</h1>
          <p>Disconnect closes only this browser. Close rmux session stops the shared session for everyone.</p>
          <button class="share-provenance-trigger" data-share-session-provenance type="button">Security & provenance</button>
          <div class="share-confirm-actions">
            <button data-share-session-detach type="button">Disconnect browser</button>
            <button data-share-session-logout class="danger" type="button">Close rmux session</button>
          </div>
        </form>
      </dialog>
      <div class="share-window-menu" data-share-window-menu role="menu" hidden>
        <button data-share-window-new type="button" role="menuitem">Nouveau</button>
        <button data-share-window-edit type="button" role="menuitem">Edit</button>
        <button data-share-window-kill class="danger" type="button" role="menuitem">Supprimer</button>
      </div>
      <dialog class="share-confirm" data-share-confirm>
        <form method="dialog" class="share-confirm-panel">
          <h1 data-share-confirm-title></h1>
          <p class="share-confirm-endpoint" data-share-endpoint hidden></p>
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
            share.rmux.io serves only the static frontend and does not relay terminal data. Terminal frames are end-to-end encrypted, the token stays in the URL fragment, the source is public, builds are verifiable, deployments are traceable, and the frontend can be self-hosted.
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

export function titleCase(role: ShareRole): string {
  return role === 'operator' ? 'Operator' : 'Spectator';
}
