import type { PaseoAgent } from './paseoTypes.js';
import type { StatusEvent, WidgetStatus } from './contract.js';
import { mapAgent, projectLabel } from './paseoMapping.js';

/**
 * Tracked state for a session we have previously emitted an event for.
 * `null` lastEmitted means "never emitted" (fresh tracker → first emit always fires).
 */
interface TrackedSession {
  id: string;
  lastEmitted: WidgetStatus | null;
  lastEmittedLabel: string | null;
}

export interface TransitionTrackerOptions {
  idleTtlMs: number;
  healthFailuresMax: number;
  /** Injectable clock for tests; defaults to Date.now. */
  nowFn?: () => number;
}

/**
 * TransitionTracker is a fully synchronous pure-logic state machine that:
 *  - maps PaseoAgent snapshots to widget statuses (via mapAgent),
 *  - dedupes events — emits only on (status, label) change vs last emission,
 *  - emits `disconnected` exactly once per session for TTL-expiry / closed /
 *    error / archived (kept tracked with lastEmitted='disconnected' so a
 *    continuously-disconnected agent does not re-emit every tick),
 *  - emits `disconnected` once for sessions that disappear from the poll
 *    (then truly forgets them, since they will not reappear),
 *  - debounces daemon-down failures: only after `healthFailuresMax` consecutive
 *    `recordFailure()` calls does it emit `disconnected` for everything and clear.
 *
 * No I/O. The poll loop (src/index.ts) owns the source-ordering policy and feeds
 * this tracker via `update` or `recordFailure`.
 */
export class TransitionTracker {
  private readonly idleTtlMs: number;
  private readonly healthFailuresMax: number;
  private readonly nowFn: () => number;
  private readonly sessions = new Map<string, TrackedSession>();
  private failureCount = 0;
  /** True once we have fired the disconnect-all on daemon-down; prevents repeat. */
  private disconnectedAll = false;

  constructor(opts: TransitionTrackerOptions) {
    if (opts.idleTtlMs <= 0) throw new Error('idleTtlMs must be > 0');
    if (opts.healthFailuresMax <= 0) throw new Error('healthFailuresMax must be > 0');
    this.idleTtlMs = opts.idleTtlMs;
    this.healthFailuresMax = opts.healthFailuresMax;
    this.nowFn = opts.nowFn ?? (() => Date.now());
  }

  /**
   * Ingest a fresh poll result and return the events to emit this tick.
   *
   * Semantics:
   *  - Each agent is mapped via `mapAgent`; if the (status, label) differs from
   *    the last emission for that session, emit and remember.
   *  - Sessions whose mapped status is `disconnected` emit once and are kept
   *    tracked with lastEmitted='disconnected' (so the same agent appearing
   *    disconnected next tick is deduped, and a later active transition still
   *    fires). This realizes "emit once" without re-spamming the backend.
   *  - Sessions that were tracked but absent from `agents` emit `disconnected`
   *    once (if not already) and are then truly forgotten — they cannot
   *    reappear, so there is no risk of re-emission.
   *  - The daemon-down failure counter is RESET on every successful update
   *    (recovery reconciles state through the normal poll loop).
   */
  update(agents: PaseoAgent[]): StatusEvent[] {
    const nowMs = this.nowFn();
    const seen = new Set<string>();
    const events: StatusEvent[] = [];

    for (const a of agents) {
      seen.add(a.id);
      const status = mapAgent(a, nowMs, this.idleTtlMs);
      const label = projectLabel(a);

      const tracked = this.sessions.get(a.id);

      if (status === 'disconnected') {
        // Never emit `disconnected` for a session we have not previously tracked
        // (SPEC.md: disconnected is only for previously-tracked sessions). A
        // first-seen closed/error/archived/idle-past-TTL agent is already gone —
        // there is nothing to disconnect. Leave it untracked: if it later goes
        // active, the active branch fires a genuine transition; if it disappears,
        // the absent-loop finds nothing to disconnect. This is the fix for the
        // restart POST-spam (~10 wasted disconnects per process start).
        if (!tracked) continue;
        // Dedupe: if we already emitted disconnected with this label, suppress.
        // We keep the session tracked (lastEmitted='disconnected') so a
        // continuously-disconnected agent does not re-emit every tick, and so
        // the absent-session branch below recognizes it as already disconnected.
        // A later transition to an active status emits a fresh event.
        if (
          tracked.lastEmitted === 'disconnected' &&
          tracked.lastEmittedLabel === label
        ) {
          continue;
        }
        events.push(this.emit(a.id, 'disconnected', label, nowMs));
        continue;
      }

      // Active status — dedupe on (status, label).
      if (
        tracked &&
        tracked.lastEmitted === status &&
        tracked.lastEmittedLabel === label
      ) {
        // No transition; keep tracking.
        continue;
      }
      events.push(this.emit(a.id, status, label, nowMs));
    }

    // Forget sessions absent from this poll. They cannot reappear, so emit
    // `disconnected` once (if not already) and drop them entirely.
    for (const id of [...this.sessions.keys()]) {
      if (!seen.has(id)) {
        const tracked = this.sessions.get(id)!;
        if (tracked.lastEmitted !== 'disconnected') {
          events.push({
            sessionId: `paseo:${id}`,
            status: 'disconnected',
            // Use the last known label so the widget can match the row to remove.
            projectLabel: tracked.lastEmittedLabel ?? `paseo:${id}`,
            updatedAt: nowMs,
          });
        }
        this.sessions.delete(id);
      }
    }

    // A successful poll reconciles — reset the failure counter.
    this.failureCount = 0;
    this.disconnectedAll = false;

    return events;
  }

  /**
   * Record a daemon-down (or untrusted-source) failure tick.
   * Returns events to emit:
   *  - Before reaching `healthFailuresMax`: returns `[]` (debounce — daemon may
   *    be flapping).
   *  - On the tick that reaches `healthFailuresMax`: emits `disconnected` for
   *    every currently-tracked session and clears all state. Subsequent failures
   *    (until recovery via a successful `update`) return `[]`.
   */
  recordFailure(): StatusEvent[] {
    if (this.disconnectedAll) return [];
    this.failureCount += 1;
    if (this.failureCount < this.healthFailuresMax) return [];

    // Threshold reached: disconnect everything once.
    const nowMs = this.nowFn();
    const events: StatusEvent[] = [];
    for (const [id, tracked] of this.sessions) {
      if (tracked.lastEmitted === 'disconnected') continue;
      events.push({
        sessionId: `paseo:${id}`,
        status: 'disconnected',
        projectLabel: tracked.lastEmittedLabel ?? `paseo:${id}`,
        updatedAt: nowMs,
      });
    }
    this.sessions.clear();
    this.disconnectedAll = true;
    // NOTE: failureCount is NOT reset here. It stays >= max so a subsequent
    // recordFailure() remains a no-op. A successful update() resets both.
    return events;
  }

  /** Internal: build an event, record the emission, and return it. */
  private emit(
    id: string,
    status: WidgetStatus,
    label: string,
    nowMs: number,
  ): StatusEvent {
    this.sessions.set(id, {
      id,
      lastEmitted: status,
      lastEmittedLabel: label,
    });
    return {
      sessionId: `paseo:${id}`,
      status,
      projectLabel: label,
      updatedAt: nowMs,
    };
  }
}
