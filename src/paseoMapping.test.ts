import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mapAgent, projectLabel } from "./paseoMapping.js";
import type { PaseoAgent } from "./paseoTypes.js";

/** Helper: build a minimal agent with overrides. */
function agent(overrides: Partial<PaseoAgent> = {}): PaseoAgent {
  return {
    id: "a-1",
    title: null,
    cwd: "/Users/gordon/dev/some-repo",
    status: "idle",
    archived: false,
    requiresAttention: false,
    attentionReason: null,
    lastActivityAtMs: 0,
    ...overrides,
  };
}

const NOW = 1_000_000;
const TTL = 30 * 60_000; // 30 min

describe("mapAgent — decision table", () => {
  it("permission_reason → permission_required (over running)", () => {
    expect(
      mapAgent(
        agent({
          status: "running",
          requiresAttention: true,
          attentionReason: "permission",
        }),
        NOW,
        TTL,
      ),
    ).toBe("permission_required");
  });

  it("permission_reason = needs_input → permission_required", () => {
    expect(
      mapAgent(
        agent({
          status: "idle",
          requiresAttention: true,
          attentionReason: "needs_input",
        }),
        NOW,
        TTL,
      ),
    ).toBe("permission_required");
  });

  it('attentionReason "finished" does NOT trigger permission_required (idle stays waiting)', () => {
    expect(
      mapAgent(
        agent({
          status: "idle",
          requiresAttention: true,
          attentionReason: "finished",
          lastActivityAtMs: NOW, // fresh
        }),
        NOW,
        TTL,
      ),
    ).toBe("waiting");
  });

  it('attentionReason "error" does NOT trigger permission_required (closed/error → disconnected)', () => {
    expect(
      mapAgent(
        agent({
          status: "error",
          requiresAttention: true,
          attentionReason: "error",
        }),
        NOW,
        TTL,
      ),
    ).toBe("disconnected");
  });

  it("running → thinking", () => {
    expect(mapAgent(agent({ status: "running" }), NOW, TTL)).toBe("thinking");
  });

  it("initializing → thinking", () => {
    expect(mapAgent(agent({ status: "initializing" }), NOW, TTL)).toBe(
      "thinking",
    );
  });

  it("idle within TTL → waiting", () => {
    expect(
      mapAgent(
        agent({ status: "idle", lastActivityAtMs: NOW - 1_000 }),
        NOW,
        TTL,
      ),
    ).toBe("waiting");
  });

  it("idle exactly at TTL boundary (age == TTL) → disconnected (strict-less-than)", () => {
    expect(
      mapAgent(
        agent({ status: "idle", lastActivityAtMs: NOW - TTL }),
        NOW,
        TTL,
      ),
    ).toBe("disconnected");
  });

  it("idle just inside TTL (age == TTL - 1) → waiting", () => {
    expect(
      mapAgent(
        agent({ status: "idle", lastActivityAtMs: NOW - (TTL - 1) }),
        NOW,
        TTL,
      ),
    ).toBe("waiting");
  });

  it("idle past TTL → disconnected", () => {
    expect(
      mapAgent(
        agent({ status: "idle", lastActivityAtMs: NOW - TTL - 1 }),
        NOW,
        TTL,
      ),
    ).toBe("disconnected");
  });

  it("closed → disconnected", () => {
    expect(mapAgent(agent({ status: "closed" }), NOW, TTL)).toBe(
      "disconnected",
    );
  });

  it("error → disconnected", () => {
    expect(mapAgent(agent({ status: "error" }), NOW, TTL)).toBe(
      "disconnected",
    );
  });

  it("archived → disconnected even if status is running", () => {
    expect(
      mapAgent(agent({ status: "running", archived: true }), NOW, TTL),
    ).toBe("disconnected");
  });

  it("archived → disconnected even if status is idle within TTL", () => {
    expect(
      mapAgent(
        agent({
          status: "idle",
          archived: true,
          lastActivityAtMs: NOW,
        }),
        NOW,
        TTL,
      ),
    ).toBe("disconnected");
  });
});

describe("mapAgent — unknown statuses", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("unknown status → waiting", () => {
    expect(mapAgent(agent({ status: "glorp" }), NOW, TTL)).toBe("waiting");
  });

  it("warns once per distinct unknown value", () => {
    mapAgent(agent({ status: "flibbit" }), NOW, TTL);
    mapAgent(agent({ status: "flibbit" }), NOW, TTL);
    mapAgent(agent({ status: "flibbit" }), NOW, TTL);
    mapAgent(agent({ status: "zorp" }), NOW, TTL);
    mapAgent(agent({ status: "zorp" }), NOW, TTL);

    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy.mock.calls[0][0]).toContain("flibbit");
    expect(warnSpy.mock.calls[1][0]).toContain("zorp");
  });

  it("does not warn for known statuses", () => {
    for (const s of ["running", "initializing", "idle", "closed", "error"]) {
      mapAgent(agent({ status: s, lastActivityAtMs: NOW }), NOW, TTL);
    }
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe("projectLabel", () => {
  it("uses title when set, prefixed with ⛵ ", () => {
    expect(
      projectLabel(agent({ title: "fix auth bug", cwd: "/dev/repo" })),
    ).toBe("⛵ fix auth bug");
  });

  it("falls back to basename(cwd) when title is null", () => {
    expect(
      projectLabel(agent({ title: null, cwd: "/Users/gordon/dev/agentdash" })),
    ).toBe(
      "⛵ agentdash",
    );
  });

  it("falls back to basename(cwd) when title is empty string", () => {
    expect(
      projectLabel(agent({ title: "", cwd: "/Users/gordon/dev/agentdash" })),
    ).toBe(
      "⛵ agentdash",
    );
  });

  it("handles trailing slashes in cwd", () => {
    expect(
      projectLabel(agent({ title: null, cwd: "/Users/gordon/dev/repo/" })),
    ).toBe("⛵ repo");
  });

  it("truncates to 40 chars with ellipsis when too long", () => {
    const longTitle = "A".repeat(100);
    const label = projectLabel(agent({ title: longTitle, cwd: "/dev/repo" }));
    expect(label.length).toBe(40);
    expect(label.startsWith("⛵ ")).toBe(true);
    expect(label.endsWith("…")).toBe(true);
    // 2 prefix chars + 37 keep + 1 ellipsis = 40
    expect(label.slice(2, -1).length).toBe(37);
  });

  it("does not truncate a label of exactly 40 chars", () => {
    // ⛵ (1) + space (1) + 38 chars = 40
    const title = "B".repeat(38);
    const label = projectLabel(agent({ title, cwd: "/dev/repo" }));
    expect(label).toBe(`⛵ ${title}`);
    expect(label.length).toBe(40);
    expect(label.endsWith("…")).toBe(false);
  });

  it("truncates a label of 41 chars", () => {
    const title = "B".repeat(39); // ⛵ + space + 39 = 41
    const label = projectLabel(agent({ title, cwd: "/dev/repo" }));
    expect(label.length).toBe(40);
    expect(label.endsWith("…")).toBe(true);
  });

  it("basename handles cwd with no slashes", () => {
    expect(projectLabel(agent({ title: null, cwd: "bare-dir" }))).toBe(
      "⛵ bare-dir",
    );
  });

  it("basename handles empty cwd", () => {
    expect(projectLabel(agent({ title: null, cwd: "" }))).toBe("⛵ ");
  });
});
