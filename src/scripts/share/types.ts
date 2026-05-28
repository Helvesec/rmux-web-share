export type ShareRole = 'spectator' | 'operator';
export type ShareScope = 'pane' | 'session';
export type TerminalThemeName = 'user' | 'dark' | 'light';

export interface ShareParams {
  endpoint: string;
  token: string;
  theme?: TerminalThemeName;
  navbar: 'visible' | 'off';
  disclaimer: 'on' | 'off';
}

export interface ReadyMessage {
  type: 'ready';
  protocol_version: number;
  capabilities: string[];
  pane_size: {
    cols: number;
    rows: number;
  };
  scope: ShareScope;
  share_id?: string;
  session_name?: string;
  pane_label?: string;
  role: ShareRole;
  operator: boolean;
  controls: boolean;
  show_viewers: boolean;
  operators_active?: number;
  operators_max?: number;
  ttl_remaining_seconds?: number;
  spectators_active?: number;
  spectators_max?: number;
  viewers_connected?: number;
  terminal_palette?: TerminalThemePalette;
}

export interface ViewerCountMessage {
  type: 'viewer_count';
  spectators_active: number;
  spectators_max: number;
  operators_active: number;
  operators_max?: number;
  viewers_connected: number;
}

export interface SessionPaneView {
  id: number;
  x: number;
  y: number;
  cols: number;
  rows: number;
  history_size: number;
  scroll_offset: number;
  alternate_on: boolean;
}

export interface SessionView {
  size: {
    cols: number;
    rows: number;
  };
  panes: SessionPaneView[];
}

export interface TerminalThemePalette {
  foreground: string;
  background: string;
  cursor: string;
  ansi: string[];
}

export type ServerMessage =
  | ReadyMessage
  | ViewerCountMessage
  | { type: 'error'; code: 'invalid_share' | 'invalid_auth' | string }
  | { type: 'operator_changed'; connected: boolean }
  | { type: 'ttl_warn'; seconds_remaining: number }
  | { type: 'pane_process_exit'; exit_code: number | null }
  | {
      type: 'share_revoked';
      reason: 'stopped_by_owner' | 'ttl_expired' | 'pane_gone' | 'session_gone' | string;
    };

export interface ShareStatus {
  detail: string;
  connected?: boolean;
  tone?: 'idle' | 'ok' | 'warn' | 'error';
}
