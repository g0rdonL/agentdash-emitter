import { beforeEach, describe, expect, it, vi } from "vitest";
import { TransitionTracker } from "./paseoTracker.js";
import type { PaseoAgent } from "./paseoTypes.js";

function agent(overrides: Partial<PaseoAgent> = {}): PaseoAgent {
  return {
    id: "a-1",
    title: "fix auth",
    cwd: "/dev/repo",
    status: "running",
    archived: false,
    requiresAttention: false,
    attentionReason: null,
    lastActivityAtMs: 0,
    ...overrides,
  };
}

const TTL = 30 * 60_000;
const MAX_FAILURES = 3;

/** Fixed clock so tests are deterministic. */
const T0 = 1_000_000;
function makeTracker() {
  let t = T0;
  return new TransitionTracker({
    idleTtlMs: TTL,
    healthFailuresMax: MAX_FAILURES,
    nowFn: () => t,
  });
}

describe("TransitionTracker — restart semantics", () => {
  it("fresh tracker emits current state once for each agent", () => {
    const tr = makeTracker();
    const events = tr.update([
      agent({ id: "a", status: "running" }),
      agent({ id: "b", status: "idle", lastActivityAtMs: T0 }),
    ]);
    expect(events).toHaveLength(2);
    const ids = events.map((e) => e.sessionId).sort();
    expect(ids).toEqual(["paseo:a", "paseo:b"]);
    expect(events[0].status).toBe("thinking"); // running
  });
});

describe("TransitionTracker — transition dedupe", () => {
  it("same status twice → one event, then no event", () => {
    const tr = makeTracker();
    const a = agent({ id: "a", status: "running" });
    expect(tr.update([a])).toHaveLength(1);
    expect(tr.update([a])).toHaveLength(0);
    expect(tr.update([a])).toHaveLength(0);
  });

  it("status change emits a new event", () => {
    const tr = makeTracker();
    const a = agent({ id: "a", status: "running" });
    tr.update([a]);
    // running → permission_required
    const events = tr.update([
      agent({
        id: "a",
        status: "running",
        requiresAttention: true,
        attentionReason: "permission",
      }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe("permission_required");
  });

  it("label change emits a new event (same status)", () => {
    const tr = makeTracker();
    tr.update([agent({ id: "a", title: "old", status: "running" })]);
    const events = tr.update([
      agent({ id: "a", title: "new title", status: "running" }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe("thinking");
    expect(events[0].projectLabel).toContain("new title");
  });

  it("label AND status unchanged → no event", () => {
    const tr = makeTracker();
    const a = agent({ id: "a", title: "t", status: "running" });
    tr.update([a]);
    expect(tr.update([a])).toHaveLength(0);
  });
});

describe("TransitionTracker — TTL expiry", () => {
  it("idle within TTL → waiting; past TTL → disconnected, exactly once", () => {
    let t = T0;
    const tr = new TransitionTracker({
      idleTtlMs: TTL,
      healthFailuresMax: MAX_FAILURES,
      nowFn: () => t,
    });

    // Fresh idle within TTL.
    let events = tr.update([
      agent({ id: "a", status: "idle", lastActivityAtMs: t - 1_000 }),
    ]);
    expect(events[0].status).toBe("waiting");

    // Still within TTL, no change.
    t += 1_000;
    expect(
      tr.update([
        agent({ id: "a", status: "idle", lastActivityAtMs: T0 - 1_000 }),
      ]),
    ).toHaveLength(0);

    // Cross TTL boundary — now disconnected.
    t = T0 + TTL + 1;
    events = tr.update([
      agent({ id: "a", status: "idle", lastActivityAtMs: T0 - 1_000 }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe("disconnected");

    // Further ticks on this id produce nothing (forgotten).
    events = tr.update([
      agent({ id: "a", status: "idle", lastActivityAtMs: T0 - 1_000 }),
    ]);
    expect(events).toHaveLength(0);
  });

  it("closed → disconnected once and forget", () => {
    const tr = makeTracker();
    tr.update([agent({ id: "a", status: "running" })]);
    const events = tr.update([agent({ id: "a", status: "closed" })]);
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe("disconnected");
    // Forgotten — re-appearing as running later is a fresh transition.
    const events2 = tr.update([agent({ id: "a", status: "running" })]);
    expect(events2).toHaveLength(1);
    expect(events2[0].status).toBe("thinking");
  });

  it("tracked running → error emits exactly one disconnected", () => {
    const tr = makeTracker();
    tr.update([agent({ id: "a", status: "running" })]);
    const events = tr.update([agent({ id: "a", status: "error" })]);
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe("disconnected");
  });

  it("tracked running → archived emits exactly one disconnected", () => {
    const tr = makeTracker();
    tr.update([agent({ id: "a", status: "running" })]);
    const events = tr.update([
      agent({ id: "a", status: "running", archived: true }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe("disconnected");
  });

  // SPEC: disconnected is only emitted for previously-tracked sessions. A fresh
  // tracker seeing an already-dead agent (closed/error/archived/idle-past-TTL)
  // must emit NOTHING — this is the fix for restart POST-spam.
  it("fresh tracker: first-seen closed emits zero events", () => {
    const tr = makeTracker();
    expect(tr.update([agent({ id: "a", status: "closed" })])).toHaveLength(0);
  });

  it("fresh tracker: first-seen error emits zero events", () => {
    const tr = makeTracker();
    expect(tr.update([agent({ id: "a", status: "error" })])).toHaveLength(0);
  });

  it("fresh tracker: first-seen archived emits zero events (even if status running)", () => {
    const tr = makeTracker();
    expect(
      tr.update([agent({ id: "a", status: "running", archived: true })]),
    ).toHaveLength(0);
  });

  it("fresh tracker: first-seen idle-past-TTL emits zero events", () => {
    let t = T0;
    const tr = new TransitionTracker({
      idleTtlMs: TTL,
      healthFailuresMax: MAX_FAILURES,
      nowFn: () => t,
    });
    // lastActivity is well past the TTL — maps to disconnected, but never tracked.
    expect(
      tr.update([
        agent({ id: "a", status: "idle", lastActivityAtMs: T0 - TTL - 1 }),
      ]),
    ).toHaveLength(0);
    // And it must not have been silently tracked either: a later active state
    // is a genuine first transition (one event), and disappearing after that
    // yields exactly one disconnected.
    expect(tr.update([agent({ id: "a", status: "running" })])).toHaveLength(1);
    const gone = tr.update([]);
    expect(gone).toHaveLength(1);
    expect(gone[0].status).toBe("disconnected");
  });
});

describe("TransitionTracker — missing session", () => {
  it("tracked session absent from poll → disconnected once and forgotten", () => {
    const tr = makeTracker();
    tr.update([
      agent({ id: "a", status: "running" }),
      agent({ id: "b", status: "running" }),
    ]);
    // Only 'a' present now — 'b' should disconnect.
    const events = tr.update([agent({ id: "a", status: "running" })]);
    expect(events).toHaveLength(1);
    expect(events[0].sessionId).toBe("paseo:b");
    expect(events[0].status).toBe("disconnected");
    // 'b' stays forgotten — re-introducing 'a' only should not re-emit 'b'.
    const events2 = tr.update([agent({ id: "a", status: "running" })]);
    expect(events2).toHaveLength(0);
  });

  it("first-seen closed then absent → no events at all", () => {
    const tr = makeTracker();
    // First-seen closed is never tracked (no disconnect emitted).
    expect(tr.update([agent({ id: "a", status: "closed" })])).toHaveLength(0);
    // Now absent — nothing tracked, so still no event.
    expect(tr.update([])).toHaveLength(0);
  });
});

describe("TransitionTracker — daemon-down debounce", () => {
  it("2 failures → no events; 3rd → disconnect-all; 4th → no-op", () => {
    const tr = makeTracker();
    tr.update([
      agent({ id: "a", status: "running" }),
      agent({ id: "b", status: "running" }),
    ]);

    expect(tr.recordFailure()).toHaveLength(0); // 1
    expect(tr.recordFailure()).toHaveLength(0); // 2
    const events = tr.recordFailure(); // 3 — threshold
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.status === "disconnected")).toBe(true);
    const ids = events.map((e) => e.sessionId).sort();
    expect(ids).toEqual(["paseo:a", "paseo:b"]);

    // 4th failure — no-op until recovery.
    expect(tr.recordFailure()).toHaveLength(0);
  });

  it("after disconnect-all, recovery (update) re-tracks fresh and resets counter", () => {
    const tr = makeTracker();
    tr.update([agent({ id: "a", status: "running" })]);
    for (let i = 0; i < MAX_FAILURES; i++) tr.recordFailure();
    // All cleared.
    expect(tr.recordFailure()).toHaveLength(0);

    // Recovery — agent 'a' is back, should emit thinking fresh.
    const events = tr.update([agent({ id: "a", status: "running" })]);
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe("thinking");

    // Failure counter is reset — need MAX_FAILURES again to disconnect.
    expect(tr.recordFailure()).toHaveLength(0);
    expect(tr.recordFailure()).toHaveLength(0);
    expect(tr.recordFailure()).toHaveLength(1); // only 'a' tracked now
  });

  it("update() resets the failure counter (no premature disconnect-all)", () => {
    const tr = makeTracker();
    tr.update([agent({ id: "a", status: "running" })]);
    tr.recordFailure();
    tr.recordFailure(); // 2
    // Successful poll resets.
    tr.update([agent({ id: "a", status: "running" })]);
    // Now 2 more failures should NOT trigger (need 3 since reset).
    expect(tr.recordFailure()).toHaveLength(0);
    expect(tr.recordFailure()).toHaveLength(0);
    expect(tr.recordFailure()).toHaveLength(1);
  });

  it("recordFailure when nothing is tracked → threshold reached, no events", () => {
    const tr = makeTracker();
    expect(tr.recordFailure()).toHaveLength(0);
    expect(tr.recordFailure()).toHaveLength(0);
    expect(tr.recordFailure()).toHaveLength(0); // threshold reached, but nothing tracked
  });
});

describe("TransitionTracker — constructor validation", () => {
  it("rejects non-positive idleTtlMs", () => {
    expect(
      () =>
        new TransitionTracker({
          idleTtlMs: 0,
          healthFailuresMax: 3,
        }),
    ).toThrow();
  });

  it("rejects non-positive healthFailuresMax", () => {
    expect(
      () =>
        new TransitionTracker({
          idleTtlMs: 1000,
          healthFailuresMax: 0,
        }),
    ).toThrow();
  });
});
