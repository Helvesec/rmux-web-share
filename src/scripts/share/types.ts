export type ShareRole = 'read' | 'operator';
export type ShareScope = 'pane' | 'session';
export type TerminalThemeName = 'user' | 'dark' | 'light';

export interface ShareParams {
  endpoint: string;
  token: string;
  theme?: TerminalThemeName;
  navbar: 'visible' | 'off';
  disclaimer: 'on' | 'off';
  requiresPin: boolean;
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
  writable: boolean;
  controls: boolean;
  operator_connected?: boolean;
  ttl_remaining_seconds?: number;
  readers_active?: number;
  readers_max?: number;
  terminal_palette?: TerminalThemePalette;
}

export interface TerminalThemePalette {
  foreground: string;
  background: string;
  cursor: string;
  ansi: string[];
}

export type ServerMessage =
  | ReadyMessage
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
