import { beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
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

function makeExecFn(procs: FakeProc[]) {
  return (cmd: string): string => {
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
        projectLabel: "foo",
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
    expect(events[0].projectLabel).toBe("gordon-trader");
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
        projectLabel: "foo",
        updatedAt: NOW,
      },
    ]);
    expect(collect(poller)).toEqual([]); // forgotten, no repeat
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
});
