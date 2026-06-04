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
  private readonly desiredPaneOffsets = new Map<number, number>();
  private readonly daemonPaneOffsets = new Map<number, number>();

  reset(): void {
    this.pinned = false;
    this.scrollIntent = undefined;
    this.scrollDirection = undefined;
    this.scrollPaneId = undefined;
    this.followLiveRequested = false;
    this.desiredPaneOffsets.clear();
    this.daemonPaneOffsets.clear();
  }

  noteAppliedView(view: SessionView): void {
    const pinned = hasSessionScrollOffset(view);
    this.pinned = pinned;
    this.desiredPaneOffsets.clear();
    this.daemonPaneOffsets.clear();
    if (pinned) {
      for (const pane of view.panes) {
        const offset = Math.max(0, pane.scroll_offset);
        this.desiredPaneOffsets.set(pane.id, offset);
        this.daemonPaneOffsets.set(pane.id, offset);
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
    this.desiredPaneOffsets.clear();
    this.daemonPaneOffsets.clear();
    return true;
  }

  notePaneScroll(paneId: number, delta: number, view?: SessionView): number | undefined {
    const pane = view?.panes.find((candidate) => candidate.id === paneId);
    const current = this.currentDesiredPaneOffset(paneId, pane);
    const next = this.nextPaneOffset(current, delta, pane);
    const daemonCurrent = this.currentDaemonPaneOffset(paneId, pane);
    const wireDelta = daemonCurrent - next;
    this.scrollPaneId = paneId;
    this.scrollDirection = next > current ? 'history' : 'live';
    if (next > 0) {
      this.pinned = true;
      this.scrollIntent = 'history';
      this.followLiveRequested = false;
      this.desiredPaneOffsets.set(paneId, next);
      this.daemonPaneOffsets.set(paneId, next);
      return wireDelta === 0 ? undefined : wireDelta;
    }
    this.pinned = false;
    this.scrollIntent = 'live';
    this.followLiveRequested = true;
    this.desiredPaneOffsets.delete(paneId);
    this.daemonPaneOffsets.delete(paneId);
    return wireDelta === 0 ? undefined : wireDelta;
  }

  shouldApplyView(view: SessionView): boolean {
    if (hasSessionScrollOffset(view)) {
      if (this.scrollIntent === 'live' || this.followLiveRequested || this.shouldSuppressStaleHistoryView(view)) {
        this.noteSuppressedDaemonView(view);
        return false;
      }
      return true;
    }
    if (!this.pinned) {
      return true;
    }
    const shouldFollowLive = this.scrollIntent === 'live' || this.followLiveRequested;
    if (!shouldFollowLive) {
      this.noteSuppressedDaemonView(view);
    }
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

  private currentDesiredPaneOffset(paneId: number, pane?: SessionPaneView): number {
    return Math.max(0, this.desiredPaneOffsets.get(paneId) ?? pane?.scroll_offset ?? 0);
  }

  private currentDaemonPaneOffset(paneId: number, pane?: SessionPaneView): number {
    return Math.max(0, this.daemonPaneOffsets.get(paneId) ?? pane?.scroll_offset ?? 0);
  }

  private nextPaneOffset(current: number, delta: number, pane?: SessionPaneView): number {
    const historySize = Math.max(0, pane?.history_size ?? Number.MAX_SAFE_INTEGER);
    return Math.max(0, Math.min(historySize, current - delta));
  }

  private shouldSuppressStaleHistoryView(view: SessionView): boolean {
    if (!this.pinned || this.scrollIntent !== 'history' || this.scrollPaneId === undefined || this.scrollDirection === undefined) {
      return false;
    }
    const desired = this.desiredPaneOffsets.get(this.scrollPaneId);
    const pane = view.panes.find((candidate) => candidate.id === this.scrollPaneId);
    if (desired === undefined || !pane || pane.scroll_offset <= 0) {
      return false;
    }
    const actual = Math.max(0, pane.scroll_offset);
    return this.scrollDirection === 'history' ? actual < desired : actual > desired;
  }

  private noteSuppressedDaemonView(view: SessionView): void {
    const paneIds = new Set(view.panes.map((pane) => pane.id));
    for (const paneId of this.daemonPaneOffsets.keys()) {
      if (!paneIds.has(paneId)) {
        this.daemonPaneOffsets.delete(paneId);
      }
    }
    for (const pane of view.panes) {
      this.daemonPaneOffsets.set(pane.id, Math.max(0, pane.scroll_offset));
    }
  }
}

function hasSessionScrollOffset(view: SessionView): boolean {
  return view.panes.some((pane) => pane.scroll_offset > 0);
}

function isPassiveOperatorSignal(data: string): boolean {
  return data === '\x1b[I' || data === '\x1b[O';
}
