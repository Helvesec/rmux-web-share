import type { SessionPaneView, SessionView } from './types';

type SessionScrollIntent = 'history' | 'live';

export class SessionHistoryGate {
  private pinned = false;
  private scrollIntent?: SessionScrollIntent;
  private followLiveRequested = false;
  private liveResetWhilePinned = false;
  private readonly paneOffsets = new Map<number, number>();

  reset(): void {
    this.pinned = false;
    this.scrollIntent = undefined;
    this.followLiveRequested = false;
    this.liveResetWhilePinned = false;
    this.paneOffsets.clear();
  }

  noteAppliedView(view: SessionView): void {
    const pinned = hasSessionScrollOffset(view);
    this.pinned = pinned;
    this.paneOffsets.clear();
    if (pinned) {
      this.liveResetWhilePinned = false;
      for (const pane of view.panes) {
        this.paneOffsets.set(pane.id, Math.max(0, pane.scroll_offset));
      }
    } else {
      this.liveResetWhilePinned = false;
    }
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
    this.liveResetWhilePinned = false;
    this.paneOffsets.clear();
    return true;
  }

  notePaneScroll(paneId: number, delta: number, view?: SessionView): number {
    const pane = view?.panes.find((candidate) => candidate.id === paneId);
    const current = this.currentPaneOffset(paneId, pane);
    const next = this.nextPaneOffset(current, delta, pane);
    if (next > 0) {
      this.pinned = true;
      this.scrollIntent = 'history';
      this.followLiveRequested = false;
      this.paneOffsets.set(paneId, next);
      return this.liveResetWhilePinned ? -next : delta;
    }
    this.pinned = false;
    this.scrollIntent = 'live';
    this.followLiveRequested = true;
    this.liveResetWhilePinned = false;
    this.paneOffsets.delete(paneId);
    return delta;
  }

  shouldApplyView(view: SessionView): boolean {
    if (hasSessionScrollOffset(view)) {
      return true;
    }
    if (!this.pinned) {
      return true;
    }
    const shouldFollowLive = this.scrollIntent === 'live' || this.followLiveRequested;
    if (!shouldFollowLive) {
      this.liveResetWhilePinned = true;
    }
    return shouldFollowLive;
  }

  shouldSuppressOutput(): boolean {
    if (this.scrollIntent === 'live' || this.followLiveRequested) {
      return false;
    }
    return this.scrollIntent === 'history' || this.pinned;
  }

  shouldQueueSnapshot(): boolean {
    return !this.pinned || this.scrollIntent === 'history';
  }

  private currentPaneOffset(paneId: number, pane?: SessionPaneView): number {
    return Math.max(0, this.paneOffsets.get(paneId) ?? pane?.scroll_offset ?? 0);
  }

  private nextPaneOffset(current: number, delta: number, pane?: SessionPaneView): number {
    const historySize = Math.max(0, pane?.history_size ?? Number.MAX_SAFE_INTEGER);
    return Math.max(0, Math.min(historySize, current - delta));
  }
}

function hasSessionScrollOffset(view: SessionView): boolean {
  return view.panes.some((pane) => pane.scroll_offset > 0);
}

function isPassiveOperatorSignal(data: string): boolean {
  return data === '\x1b[I' || data === '\x1b[O';
}
