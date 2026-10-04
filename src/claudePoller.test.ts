import { beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ClaudePoller, encodeCwd } from "./claudePoller.js";
import type { StatusEvent } from "./contract.js";

/**
 * Fixtures mirror the REAL ~/.claude layout:
 * projects/<encoded-cwd>/<uuid>.jsonl, where encoding maps / and . to '-'.
 * Timestamps are generated fresh at runtime (static ones rot past recency
 * windows) and the hyphenated-path collision case is covered.
 */

function makeClaudeDir(
  sessions: Array<{ cwd: string; sessionId: string }>,
): string {
  const dir = mkdtempSync(join(tmpdir(), "claude-poller-test-"));
  const projects = join(dir, "projects");
  mkdirSync(projects);
  for (const s of sessions) {
    const projDir = join(projects, encodeCwd(s.cwd));
    mkdirSync(projDir, { recursive: true });
    const line = JSON.stringify({
      sessionId: s.sessionId,
      timestamp: new Date().toISOString(),
      cwd: s.cwd,
    });
    writeFileSync(join(projDir, `${s.sessionId}.jsonl`), line + "\n");
  }
  return dir;
}

interface FakeProc {
  pid: number;
  cwd: string;
  ppid: number;
}

// psTable: extra "pid ppid command" rows (e.g. the Paseo daemon). When
// omitted, ps fails, exercising the fail-open path.
function makeExecFn(procs: FakeProc[], psTable?: string[]) {
  return (cmd: string): string => {
    if (cmd.startsWith("ps -axo")) {
      if (!psTable) throw new Error("ps: unavailable");
      const rows = procs.map((p) => `${p.pid} ${p.ppid} claude`);
      return [...psTable, ...rows].join("\n") + "\n";
    }
    if (cmd.startsWith("pgrep -x 'claude'")) {
      if (procs.length === 0) throw new Error("pgrep: no match");
      return procs.map((p) => p.pid).join("\n") + "\n";
    }
    const lsofMatch = cmd.match(/lsof -a -d cwd -p (\d+)/);
    if (lsofMatch) {
      const pid = parseInt(lsofMatch[1], 10);
      const proc = procs.find((p) => p.pid === pid);
      if (!proc) throw new Error("lsof: no such process");
      return `n${proc.cwd}\n`;
    }
    throw new Error(`unexpected command: ${cmd}`);
  };
}

function collect(poller: ClaudePoller): StatusEvent[] {
  const events: StatusEvent[] = [];
  poller.poll((e) => events.push(e));
  return events;
}

describe("ClaudePoller", () => {
  const NOW = 1_752_500_000_000;

  it("emits thinking for a new process-backed session", () => {
    const claudeDir = makeClaudeDir([{
      cwd: "/Users/gordon/dev/foo",
      sessionId: "sess-aaa",
    }]);
    const poller = new ClaudePoller({
      claudeDir,
      execFn: makeExecFn([{ pid: 100, cwd: "/Users/gordon/dev/foo", ppid: 1 }]),
      nowFn: () => NOW,
    });
    const events = collect(poller);
    expect(events).toEqual([
      {
        sessionId: "sess-aaa",
        status: "thinking",
        projectLabel: "foo sess-aaa",
        updatedAt: NOW,
      },
    ]);
  });

  it("resolves hyphenated paths via the JSONL cwd field (no backward-decode)", () => {
    const claudeDir = makeClaudeDir([{
      cwd: "/opt/gordon-trader",
      sessionId: "sess-hyph",
    }]);
    const poller = new ClaudePoller({
      claudeDir,
      execFn: makeExecFn([{ pid: 101, cwd: "/opt/gordon-trader", ppid: 1 }]),
      nowFn: () => NOW,
    });
    const events = collect(poller);
    expect(events).toHaveLength(1);
    expect(events[0].sessionId).toBe("sess-hyph");
    expect(events[0].projectLabel).toBe("gordon-trader sess-hyp");
  });

  it("does not re-emit for an already-known session", () => {
    const claudeDir = makeClaudeDir([{
      cwd: "/Users/gordon/dev/foo",
      sessionId: "sess-aaa",
    }]);
    const execFn = makeExecFn([{
      pid: 100,
      cwd: "/Users/gordon/dev/foo",
      ppid: 1,
    }]);
    const poller = new ClaudePoller({ claudeDir, execFn, nowFn: () => NOW });
    collect(poller);
    expect(collect(poller)).toEqual([]); // second poll, same state
  });

  it("emits disconnected once when the process goes away", () => {
    const claudeDir = makeClaudeDir([{
      cwd: "/Users/gordon/dev/foo",
      sessionId: "sess-aaa",
    }]);
    const procs: FakeProc[] = [{
      pid: 100,
      cwd: "/Users/gordon/dev/foo",
      ppid: 1,
    }];
    const poller = new ClaudePoller({
      claudeDir,
      execFn: makeExecFn(procs),
      nowFn: () => NOW,
    });
    collect(poller); // discovers
    procs.length = 0; // process exits
    const events = collect(poller);
    expect(events).toEqual([
      {
        sessionId: "sess-aaa",
        status: "disconnected",
        projectLabel: "foo sess-aaa",
        updatedAt: NOW,
      },
    ]);
    expect(collect(poller)).toEqual([]); // forgotten, no repeat
  });

  it("keeps two processes in one cwd on separate, stable sessions", () => {
    const cwd = "/Users/gordon/dev/foo";
    const claudeDir = makeClaudeDir([
      { cwd, sessionId: "sess-old" },
      { cwd, sessionId: "sess-new" },
    ]);
    const projDir = join(claudeDir, "projects", encodeCwd(cwd));
    utimesSync(join(projDir, "sess-old.jsonl"), 1000, 1000);
    utimesSync(join(projDir, "sess-new.jsonl"), 2000, 2000);
    const poller = new ClaudePoller({
      claudeDir,
      execFn: makeExecFn([
        { pid: 100, cwd, ppid: 1 },
        { pid: 101, cwd, ppid: 1 },
      ]),
      nowFn: () => NOW,
    });
    const first = collect(poller);
    expect(first.map((e) => e.sessionId).sort()).toEqual(["sess-new", "sess-old"]);

    // The older session now gets written to; assignments must not swap or flap.
    utimesSync(join(projDir, "sess-old.jsonl"), 3000, 3000);
    expect(collect(poller)).toEqual([]);
  });

  it("labels a session by its first real user prompt", () => {
    const cwd = "/Users/gordon";
    const claudeDir = makeClaudeDir([{ cwd, sessionId: "sess-lbl" }]);
    const lines = [
      { type: "user", isMeta: true, message: { content: "meta noise" } },
      { type: "user", message: { content: [{ type: "text", text: "<system-reminder>x</system-reminder>" }] } },
      { type: "user", message: { content: [{ type: "text", text: "fix the   widget\nplease, it keeps flapping between two sessions" }] } },
    ];
    writeFileSync(
      join(claudeDir, "projects", encodeCwd(cwd), "sess-lbl.jsonl"),
      lines.map((l) => JSON.stringify({ ...l, cwd })).join("\n") + "\n",
    );
    const poller = new ClaudePoller({
      claudeDir,
      execFn: makeExecFn([{ pid: 100, cwd, ppid: 1 }]),
      nowFn: () => NOW,
    });
    const [ev] = collect(poller);
    expect(ev.projectLabel).toBe("fix the widget please, it keeps flappin…");
    expect(ev.projectLabel.length).toBeLessThanOrEqual(40);
  });

  it("disconnects a remembered session that ended while the emitter was down", () => {
    const cwd = "/Users/gordon/dev/foo";
    const claudeDir = makeClaudeDir([{ cwd, sessionId: "sess-aaa" }]);
    const statePath = join(claudeDir, "state", "known.json");
    const procs: FakeProc[] = [{ pid: 100, cwd, ppid: 1 }];
    const first = new ClaudePoller({
      claudeDir,
      execFn: makeExecFn(procs),
      nowFn: () => NOW,
      statePath,
    });
    expect(collect(first)).toHaveLength(1);

    // Emitter restarts; the claude process exited in the meantime.
    procs.length = 0;
    const second = new ClaudePoller({
      claudeDir,
      execFn: makeExecFn(procs),
      nowFn: () => NOW,
      statePath,
    });
    expect(collect(second)).toEqual([
      {
        sessionId: "sess-aaa",
        status: "disconnected",
        projectLabel: "foo sess-aaa",
        updatedAt: NOW,
      },
    ]);
  });

  it("does not re-announce a remembered session that is still running", () => {
    const cwd = "/Users/gordon/dev/foo";
    const claudeDir = makeClaudeDir([{ cwd, sessionId: "sess-aaa" }]);
    const statePath = join(claudeDir, "state", "known.json");
    const procs: FakeProc[] = [{ pid: 100, cwd, ppid: 1 }];
    const opts = { claudeDir, execFn: makeExecFn(procs), nowFn: () => NOW, statePath };
    collect(new ClaudePoller(opts));
    expect(collect(new ClaudePoller(opts))).toEqual([]);
  });

  it("never assigns a Paseo-owned session to a standalone process", () => {
    const cwd = "/Users/gordon";
    const claudeDir = makeClaudeDir([
      { cwd, sessionId: "sess-mine" },
      { cwd, sessionId: "sess-paseo" },
    ]);
    const projDir = join(claudeDir, "projects", encodeCwd(cwd));
    utimesSync(join(projDir, "sess-mine.jsonl"), 1000, 1000);
    utimesSync(join(projDir, "sess-paseo.jsonl"), 2000, 2000); // newest
    const poller = new ClaudePoller({
      claudeDir,
      execFn: makeExecFn([{ pid: 100, cwd, ppid: 1 }]),
      nowFn: () => NOW,
      excludeSessionIds: () => new Set(["sess-paseo"]),
    });
    expect(collect(poller).map((e) => e.sessionId)).toEqual(["sess-mine"]);
  });

  it("liveEvents lists exactly the sessions currently reported", () => {
    const cwd = "/Users/gordon/dev/foo";
    const claudeDir = makeClaudeDir([{ cwd, sessionId: "sess-aaa" }]);
    const procs: FakeProc[] = [{ pid: 100, cwd, ppid: 1 }];
    const poller = new ClaudePoller({
      claudeDir,
      execFn: makeExecFn(procs),
      nowFn: () => NOW,
    });
    expect(poller.liveEvents()).toEqual([]);
    collect(poller);
    expect(poller.liveEvents()).toEqual([
      { sessionId: "sess-aaa", status: "thinking", projectLabel: "foo sess-aaa", updatedAt: NOW },
    ]);
    procs.length = 0;
    collect(poller);
    expect(poller.liveEvents()).toEqual([]);
  });

  it("falls back to claude-<pid> when no session file matches the cwd", () => {
    const claudeDir = makeClaudeDir([]); // empty projects dir
    const poller = new ClaudePoller({
      claudeDir,
      execFn: makeExecFn([{ pid: 200, cwd: "/somewhere/else", ppid: 1 }]),
      nowFn: () => NOW,
    });
    const events = collect(poller);
    expect(events).toHaveLength(1);
    expect(events[0].sessionId).toBe("claude-200");
    expect(events[0].status).toBe("thinking");
  });

  it("emits nothing when no claude processes are running", () => {
    const claudeDir = makeClaudeDir([{
      cwd: "/Users/gordon/dev/foo",
      sessionId: "sess-aaa",
    }]);
    const poller = new ClaudePoller({
      claudeDir,
      execFn: makeExecFn([]),
      nowFn: () => NOW,
    });
    expect(collect(poller)).toEqual([]);
  });

  it("skips claude processes launched by the Paseo daemon (plugin reports them)", () => {
    const claudeDir = makeClaudeDir([
      { cwd: "/Users/gordon/dev/foo", sessionId: "sess-paseo" },
      { cwd: "/Users/gordon/dev/bar", sessionId: "sess-mine" },
    ]);
    const poller = new ClaudePoller({
      claudeDir,
      execFn: makeExecFn(
        [
          { pid: 100, cwd: "/Users/gordon/dev/foo", ppid: 50 }, // child of Paseo Daemon
          { pid: 200, cwd: "/Users/gordon/dev/bar", ppid: 60 }, // child of a terminal shell
        ],
        ["40 1 node /Users/gordon/.local/bin/paseo daemon run --home /Users/gordon/.paseo",
          "45 40 Paseo Supervisor", "50 45 Paseo Daemon", "60 1 -zsh"],
      ),
      nowFn: () => NOW,
    });
    const events = collect(poller);
    expect(events.map((e) => e.sessionId)).toEqual(["sess-mine"]);
  });

  it("does not skip anything when ps is unavailable (fail open)", () => {
    const claudeDir = makeClaudeDir([{ cwd: "/Users/gordon/dev/foo", sessionId: "sess-aaa" }]);
    const poller = new ClaudePoller({
      claudeDir,
      execFn: makeExecFn([{ pid: 100, cwd: "/Users/gordon/dev/foo", ppid: 50 }]),
      nowFn: () => NOW,
    });
    expect(collect(poller).map((e) => e.sessionId)).toEqual(["sess-aaa"]);
  });
});
