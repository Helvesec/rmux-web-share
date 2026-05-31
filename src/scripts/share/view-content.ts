import { shareAssetUrl, shareBasePath } from './fragment';
import { provenanceDialogTemplate } from './provenance';
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
          <button class="share-mobile-actions-button" data-share-mobile-actions type="button" aria-haspopup="menu" aria-label="Controls" title="Controls">
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
              <path d="M5 7h14M5 12h14M5 17h14" />
            </svg>
          </button>
          <span class="share-brand-divider" aria-hidden="true"></span>
          <a class="share-brand-context" data-share-home-link href="${shareBasePath()}">SHARE</a>
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
          <span class="share-role-badge" title="Spectator, read-only">
            <svg class="share-role-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none">
              <rect x="6" y="10" width="12" height="10" rx="2" />
              <path d="M9 10V7a3 3 0 0 1 6 0v3" />
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
            <svg class="share-theme-icon share-theme-icon-sun" aria-hidden="true" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2v2.5M12 19.5V22M4.93 4.93 6.7 6.7M17.3 17.3l1.77 1.77M2 12h2.5M19.5 12H22M4.93 19.07 6.7 17.3M17.3 6.7l1.77-1.77" />
            </svg>
            <svg class="share-theme-icon share-theme-icon-moon" aria-hidden="true" viewBox="0 0 24 24" fill="none">
              <path d="M20 14.6A7.4 7.4 0 0 1 9.4 4 8 8 0 1 0 20 14.6Z" />
            </svg>
            <select class="share-theme-select" data-share-terminal-theme aria-label="Terminal theme">
              <option value="user">Host</option>
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
          </label>
          <span class="share-operator-state" aria-hidden="true"></span>
          <button class="share-exit-button" data-share-session-menu type="button" aria-haspopup="dialog" aria-label="Disconnect" title="Disconnect">
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
              <path d="M10 5H6.5A2.5 2.5 0 0 0 4 7.5v9A2.5 2.5 0 0 0 6.5 19H10" />
              <path d="M15 8l4 4-4 4" />
              <path d="M9 12h10" />
            </svg>
          </button>
        </div>
      </header>
      <div class="share-mobile-pane-select-row" data-share-mobile-pane-select-row hidden>
        <button class="share-mobile-pane-select" data-share-mobile-pane-select type="button" aria-haspopup="menu">
          <span>Pane</span>
          <strong data-share-mobile-pane-current>All panes</strong>
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
      </div>
      <section class="share-terminal-shell" data-share-terminal-shell aria-label="Shared terminal">
        <div class="share-terminal" data-share-terminal>
          <div class="share-terminal-placeholder" data-share-terminal-placeholder data-tone="idle">waiting</div>
        </div>
      </section>
      <dialog class="share-session-actions" data-share-session-actions>
        <form method="dialog" class="share-session-actions-panel">
          <button class="share-dialog-close" data-share-session-close type="button" aria-label="Close" title="Close">
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
          <h1>Disconnect</h1>
          <p>Disconnect closes only this browser. The rmux session keeps running.</p>
          <div class="share-confirm-actions">
            <button data-share-session-detach class="primary" type="button">Disconnect only</button>
            <button data-share-session-logout class="danger" type="button">Close rmux session</button>
          </div>
        </form>
      </dialog>
      <div class="share-window-menu" data-share-window-menu role="menu" hidden>
        <button data-share-window-new type="button" role="menuitem">New</button>
        <button data-share-window-edit type="button" role="menuitem">Edit</button>
        <button data-share-window-kill class="danger" type="button" role="menuitem">Delete</button>
      </div>
      <div class="share-mobile-pane-menu" data-share-mobile-pane-menu role="menu" hidden>
        <div class="share-mobile-pane-menu-title" data-share-mobile-pane-title>Session panes</div>
        <div class="share-mobile-pane-list" data-share-mobile-pane-list></div>
      </div>
      <div class="share-mobile-control-menu" data-share-mobile-control-menu role="menu" hidden>
        <button data-share-mobile-split-horizontal type="button" role="menuitem">
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
            <rect x="4" y="5" width="16" height="14" rx="1.5" />
            <path d="M12 5v14" />
          </svg>
          <span class="share-menu-label">Split right</span>
          <span class="share-menu-shortcut">Ctrl+B %</span>
        </button>
        <button data-share-mobile-split-vertical type="button" role="menuitem">
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
            <rect x="4" y="5" width="16" height="14" rx="1.5" />
            <path d="M4 12h16" />
          </svg>
          <span class="share-menu-label">Split down</span>
          <span class="share-menu-shortcut">Ctrl+B "</span>
        </button>
        <button data-share-mobile-new-window type="button" role="menuitem">
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
            <rect x="5" y="5" width="14" height="14" rx="1.5" />
            <path d="M12 8v8M8 12h8" />
          </svg>
          <span class="share-menu-label">New window</span>
          <span class="share-menu-shortcut">Ctrl+B C</span>
        </button>
        <button data-share-mobile-kill-pane type="button" role="menuitem">
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
          <span class="share-menu-label">Close active pane</span>
          <span class="share-menu-shortcut">Ctrl+B X</span>
        </button>
        <div class="share-menu-separator" role="separator"></div>
        <button data-share-mobile-stop-process type="button" role="menuitem">
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
          <span class="share-menu-label">Stop process</span>
          <span class="share-menu-shortcut">Ctrl+C</span>
        </button>
        <button data-share-mobile-clear-screen type="button" role="menuitem">
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
            <path d="M5 7h14M5 12h10M5 17h6" />
          </svg>
          <span class="share-menu-label">Clear screen</span>
          <span class="share-menu-shortcut">Ctrl+L</span>
        </button>
        <button data-share-mobile-reverse-search type="button" role="menuitem">
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
            <path d="M11 19a8 8 0 1 1 5.7-2.4" />
            <path d="M17 17h-4v-4" />
          </svg>
          <span class="share-menu-label">Reverse search</span>
          <span class="share-menu-shortcut">Ctrl+R</span>
        </button>
      </div>
      <div class="share-terminal-menu" data-share-terminal-menu role="menu" hidden>
        <button data-share-terminal-copy type="button" role="menuitem">
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
            <rect x="8" y="8" width="10" height="10" rx="1.5" />
            <path d="M6 16H5.5A1.5 1.5 0 0 1 4 14.5v-9A1.5 1.5 0 0 1 5.5 4h9A1.5 1.5 0 0 1 16 5.5V6" />
          </svg>
          <span class="share-menu-label">Copy</span>
          <span class="share-menu-shortcut" data-share-terminal-copy-shortcut></span>
        </button>
        <button data-share-terminal-paste type="button" role="menuitem">
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
            <path d="M9 5h6l1 2h2v13H6V7h2l1-2Z" />
            <path d="M9 11h6M9 15h5" />
          </svg>
          <span class="share-menu-label">Paste</span>
          <span class="share-menu-shortcut" data-share-terminal-paste-shortcut></span>
        </button>
        <button data-share-terminal-show-toolbar type="button" role="menuitem" hidden>
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
            <path d="M5 8h14M8 12h8M10 16h4" />
          </svg>
          <span class="share-menu-label" data-share-terminal-toolbar-label>Show toolbar</span>
          <span class="share-menu-shortcut" aria-hidden="true"></span>
        </button>
        <div class="share-menu-separator" data-share-terminal-controls-separator role="separator" hidden></div>
        <div class="share-terminal-menu-section" data-share-terminal-controls role="group" hidden>
          <button data-share-terminal-split-horizontal type="button" role="menuitem">
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
              <rect x="4" y="5" width="16" height="14" rx="1.5" />
              <path d="M12 5v14" />
            </svg>
            <span class="share-menu-label">Split Horizontally</span>
            <span class="share-menu-shortcut">Ctrl+B %</span>
          </button>
          <button data-share-terminal-split-vertical type="button" role="menuitem">
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
              <rect x="4" y="5" width="16" height="14" rx="1.5" />
              <path d="M4 12h16" />
            </svg>
            <span class="share-menu-label">Split Vertically</span>
            <span class="share-menu-shortcut">Ctrl+B "</span>
          </button>
          <button data-share-terminal-new-window type="button" role="menuitem">
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
              <rect x="5" y="5" width="14" height="14" rx="1.5" />
              <path d="M12 8v8M8 12h8" />
            </svg>
            <span class="share-menu-label">New Window</span>
            <span class="share-menu-shortcut">Ctrl+B C</span>
          </button>
          <button data-share-terminal-kill-pane type="button" role="menuitem">
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
            <span class="share-menu-label">Close Pane</span>
            <span class="share-menu-shortcut">Ctrl+B X</span>
          </button>
        </div>
        <div class="share-menu-separator" role="separator"></div>
        <button data-share-terminal-provenance type="button" role="menuitem">
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
            <path d="M12 3l8 4v5c0 5-3.4 7.8-8 9-4.6-1.2-8-4-8-9V7l8-4Z" />
            <path d="M9.5 12l1.8 1.8 3.7-4" />
          </svg>
          <span class="share-menu-label">Security & provenance</span>
          <span class="share-menu-shortcut" aria-hidden="true"></span>
        </button>
      </div>
      <dialog class="share-confirm" data-share-confirm>
        <form method="dialog" class="share-confirm-panel">
          <div class="share-confirm-mark" data-share-confirm-mark aria-hidden="true">
            <img data-share-confirm-logo src="${shareAssetUrl('rmux-logo-light.svg')}" alt="" />
          </div>
          <h1 data-share-confirm-title></h1>
          <p class="share-confirm-endpoint" data-share-endpoint hidden></p>
          <p data-share-confirm-detail></p>
          <label class="share-pin" data-share-pin-group hidden>
            <span>Pairing code</span>
            <div class="share-pin-entry">
              <input data-share-pin inputmode="numeric" pattern="[0-9]{6}" autocomplete="one-time-code" maxlength="6" aria-label="Pairing code" />
              <span class="share-pin-boxes" data-share-pin-boxes aria-hidden="true">
                <i></i><i></i><i></i><i></i><i></i><i></i>
              </span>
            </div>
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
      ${provenanceDialogTemplate()}
    </main>
  `;
}

export function titleCase(role: ShareRole): string {
  return role === 'operator' ? 'Operator' : 'Spectator';
}
