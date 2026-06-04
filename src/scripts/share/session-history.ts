import type { SessionView } from './types';

type SessionScrollIntent = 'history' | 'live';

export class SessionHistoryGate {
  private pinned = false;
  private scrollIntent?: SessionScrollIntent;
  private followLiveRequested = false;

  reset(): void {
    this.pinned = false;
    this.scrollIntent = undefined;
    this.followLiveRequested = false;
  }

  noteAppliedView(view: SessionView): void {
    this.pinned = hasSessionScrollOffset(view);
    this.scrollIntent = undefined;
    this.followLiveRequested = false;
  }

  noteOperatorData(data: string): boolean {
    if (isPassiveOperatorSignal(data)) {
      return false;
    }
    this.pinned = false;
    this.scrollIntent = undefined;
    this.followLiveRequested = true;
    return true;
  }

  notePaneScroll(delta: number): void {
    this.scrollIntent = delta < 0 ? 'history' : 'live';
    if (this.scrollIntent === 'history') {
      this.pinned = true;
      this.followLiveRequested = false;
    }
  }

  shouldApplyView(view: SessionView): boolean {
    if (hasSessionScrollOffset(view)) {
      return true;
    }
    if (!this.pinned) {
      return true;
    }
    return this.scrollIntent === 'live' || this.followLiveRequested;
  }

  shouldSuppressOutput(): boolean {
    if (this.scrollIntent === 'live' || this.followLiveRequested) {
      return false;
    }
    return this.scrollIntent === 'history' || this.pinned;
  }
}

function hasSessionScrollOffset(view: SessionView): boolean {
  return view.panes.some((pane) => pane.scroll_offset > 0);
}

function isPassiveOperatorSignal(data: string): boolean {
  return data === '\x1b[I' || data === '\x1b[O';
}
