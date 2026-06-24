import type { SessionPaneView, SessionView } from './types';

type SessionScrollIntent = 'history' | 'live';
type SessionScrollDirection = 'history' | 'live';
export type SessionSnapshotPolicy = 'drop' | 'keep-first' | 'replace';

export class SessionHistoryGate {
  private pinned = false;
  private scrollIntent?: SessionScrollIntent;
  private scrollDirection?: SessionScrollDirection;
  private scrollPaneId?: number;
  private followLiveRequested = false;
  // scroll_offset is relative to the live bottom and changes as output appends.
  // top_line is the stable history anchor shared with the daemon.
  private readonly desiredPaneTopLines = new Map<number, number>();

  reset(): void {
    this.pinned = false;
    this.scrollIntent = undefined;
    this.scrollDirection = undefined;
    this.scrollPaneId = undefined;
    this.followLiveRequested = false;
    this.desiredPaneTopLines.clear();
  }

  noteAppliedView(view: SessionView): void {
    const pinned = hasSessionScrollOffset(view);
    this.pinned = pinned;
    this.desiredPaneTopLines.clear();
    if (pinned) {
      for (const pane of view.panes) {
        this.desiredPaneTopLines.set(pane.id, paneTopLine(pane));
      }
    }
    this.scrollIntent = undefined;
    this.scrollDirection = undefined;
    this.scrollPaneId = undefined;
    this.followLiveRequested = false;
  }

  noteOperatorData(data: string): boolean {
    if (isPassiveOperatorSignal(data)) {
      return false;
    }
    this.pinned = false;
    this.scrollIntent = undefined;
    this.scrollDirection = undefined;
    this.scrollPaneId = undefined;
    this.followLiveRequested = true;
    this.desiredPaneTopLines.clear();
    return true;
  }

  notePaneScroll(paneId: number, delta: number, view?: SessionView): number | undefined {
    const pane = view?.panes.find((candidate) => candidate.id === paneId);
    const current = this.currentDesiredPaneTopLine(paneId, pane);
    if (current === undefined) {
      return undefined;
    }
    const next = this.nextPaneTopLine(current, delta, pane);
    if (next === current) {
      return undefined;
    }
    this.scrollPaneId = paneId;
    this.scrollDirection = next < current ? 'history' : 'live';
    const historySize = Math.max(0, pane?.history_size ?? Number.MAX_SAFE_INTEGER);
    if (next < historySize) {
      this.pinned = true;
      this.scrollIntent = 'history';
      this.followLiveRequested = false;
      this.desiredPaneTopLines.set(paneId, next);
      // The daemon owns the same top_line anchor, so the wire request stays a
      // plain relative scroll delta instead of a compensation from old offsets.
      return delta;
    }
    this.pinned = false;
    this.scrollIntent = 'live';
    this.followLiveRequested = true;
    this.desiredPaneTopLines.delete(paneId);
    return delta;
  }

  shouldApplyView(view: SessionView): boolean {
    if (hasSessionScrollOffset(view)) {
      if (this.scrollIntent === 'live' || this.followLiveRequested || this.shouldSuppressStaleHistoryView(view)) {
        return false;
      }
      return true;
    }
    if (!this.pinned) {
      return true;
    }
    const shouldFollowLive = this.scrollIntent === 'live' || this.followLiveRequested;
    return shouldFollowLive;
  }

  shouldSuppressOutput(): boolean {
    if (this.scrollIntent === 'live' || this.followLiveRequested) {
      return false;
    }
    return this.scrollIntent === 'history' || this.pinned;
  }

  snapshotPolicy(): SessionSnapshotPolicy {
    if (!this.pinned) {
      return 'replace';
    }
    if (this.scrollIntent === 'history') {
      return 'keep-first';
    }
    return 'drop';
  }

  private currentDesiredPaneTopLine(paneId: number, pane?: SessionPaneView): number | undefined {
    const desired = this.desiredPaneTopLines.get(paneId);
    if (desired !== undefined) {
      return Math.max(0, desired);
    }
    return pane ? paneTopLine(pane) : undefined;
  }

  private nextPaneTopLine(current: number, delta: number, pane?: SessionPaneView): number {
    const historySize = Math.max(0, pane?.history_size ?? Number.MAX_SAFE_INTEGER);
    return Math.max(0, Math.min(historySize, current + delta));
  }

  private shouldSuppressStaleHistoryView(view: SessionView): boolean {
    if (!this.pinned || this.scrollIntent !== 'history' || this.scrollPaneId === undefined || this.scrollDirection === undefined) {
      return false;
    }
    const desired = this.desiredPaneTopLines.get(this.scrollPaneId);
    const pane = view.panes.find((candidate) => candidate.id === this.scrollPaneId);
    if (desired === undefined || !pane || pane.scroll_offset <= 0) {
      return false;
    }
    const actual = paneTopLine(pane);
    return this.scrollDirection === 'history' ? actual > desired : actual < desired;
  }
}

function hasSessionScrollOffset(view: SessionView): boolean {
  return view.panes.some((pane) => pane.scroll_offset > 0);
}

function paneTopLine(pane: SessionPaneView): number {
  const historySize = Math.max(0, pane.history_size);
  const scrollOffset = Math.max(0, Math.min(historySize, pane.scroll_offset));
  return historySize - scrollOffset;
}

function isPassiveOperatorSignal(data: string): boolean {
  return data === '\x1b[I' || data === '\x1b[O';
}
