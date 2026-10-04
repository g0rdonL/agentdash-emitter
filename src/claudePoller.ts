import { execSync as nodeExecSync } from "child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { basename, join } from "path";
import { homedir } from "os";
import type { StatusEvent } from "./contract.js";
import process from "node:process";

/**
 * Polls local Claude Code sessions (~/.claude/projects JSONL layout) and
 * emits StatusEvents for process-backed sessions only.
 *
 * - Only sessions with a LIVE claude process become rows (state=thinking).
 *   Idle JSONLs are ignored — a 24h idle window would flood the widget.
 * - Claude processes launched by the Paseo daemon are skipped: the agentdash
 *   Paseo plugin already reports those agents (dedup). They are recognised
 *   by an ancestor whose ps command line is the Paseo daemon/supervisor.
 * - When a previously-reported session loses its process, one final
 *   'disconnected' event is emitted, then it is forgotten.
 *
 * Discovery facts (verified against real ~/.claude, 2026-07-12):
 * - Sessions: ~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl
 * - Dir name encoding is LOSSY (/ and . -> -). Never backward-decode.
 * - JSONL lines carry sessionId, timestamp, cwd. Read cwd from the data;
 *   match processes by FORWARD-encoding their real cwd.
 */

export function encodeCwd(cwd: string): string {
  return String(cwd).replace(/[/.]/g, "-");
}

// Ancestors that mark a claude process as Paseo-launched. The daemon renames
// its process title to "Paseo Daemon", which pgrep -f cannot see but ps can.
const PASEO_ANCESTOR_RE = /^(Paseo (Daemon|Supervisor)\b|\S*node\b.*\bpaseo daemon run\b)/;

export interface ClaudePollerOptions {
  claudeDir?: string;
  intervalMs?: number;
  /** Injectable for tests; defaults to child_process.execSync. */
  execFn?: (cmd: string) => string;
  nowFn?: () => number;
}

interface LiveSession {
  sessionId: string;
  cwd: string;
  pid: number;
}

export class ClaudePoller {
  private readonly claudeDir: string;
  private readonly intervalMs: number;
  private readonly execFn: (cmd: string) => string;
  private readonly nowFn: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private known = new Map<string, LiveSession>();

  constructor(opts: ClaudePollerOptions = {}) {
    this.claudeDir = opts.claudeDir ?? join(homedir(), ".claude");
    this.intervalMs = opts.intervalMs ?? 60_000;
    this.execFn = opts.execFn ??
      ((cmd: string) => nodeExecSync(cmd, { encoding: "utf-8" }) as string);
    this.nowFn = opts.nowFn ?? Date.now;
  }

  start(onEvent: (event: StatusEvent) => void): void {
    const tick = () => {
      try {
        this.poll(onEvent);
      } catch (err) {
        console.error("[claude-poller] poll failed:", err);
      }
    };
    tick();
    this.timer = setInterval(tick, this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One poll cycle: diff live sessions against known, emit changes. */
  poll(onEvent: (event: StatusEvent) => void): void {
    const live = this.discover();
    const now = this.nowFn();

    for (const [sessionId, s] of live) {
      const prev = this.known.get(sessionId);
      if (!prev) {
        onEvent({
          sessionId,
          status: "thinking",
          projectLabel: basename(s.cwd) || s.cwd,
          updatedAt: now,
        });
      }
      this.known.set(sessionId, s);
    }

    for (const [sessionId, s] of this.known) {
      if (!live.has(sessionId)) {
        onEvent({
          sessionId,
          status: "disconnected",
          projectLabel: basename(s.cwd) || s.cwd,
          updatedAt: now,
        });
        this.known.delete(sessionId);
      }
    }
  }

  /** Find claude processes, then map them to sessions. */
  private discover(): Map<string, LiveSession> {
    const result = new Map<string, LiveSession>();

    const procs = this.claudeProcesses();
    if (procs.length === 0) return result;

    for (const proc of procs) {
      const session = this.sessionForCwd(proc.cwd);
      const sessionId = session ?? `claude-${proc.pid}`;
      result.set(sessionId, { sessionId, cwd: proc.cwd, pid: proc.pid });
    }
    return result;
  }

  private claudeProcesses(): Array<{ pid: number; cwd: string }> {
    let pids: number[] = [];
    try {
      pids = this.execFn("pgrep -x 'claude'")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((p) => parseInt(p, 10))
        .filter((p) => Number.isFinite(p) && p !== process.pid);
    } catch {
      return []; // pgrep exits 1 when nothing matches
    }

    const paseoOwned = this.paseoOwnedFilter();
    const out: Array<{ pid: number; cwd: string }> = [];
    for (const pid of pids) {
      if (paseoOwned(pid)) continue; // agentdash Paseo plugin reports it
      const cwd = this.cwdOf(pid);
      if (!cwd) continue;
      out.push({ pid, cwd });
    }
    return out;
  }

  /**
   * Returns a predicate for "pid descends from the Paseo daemon", built from
   * one ps snapshot. Fails open (nothing skipped) if ps is unavailable, so a
   * ps hiccup can only cause a duplicate row, never a missing one.
   */
  private paseoOwnedFilter(): (pid: number) => boolean {
    const parent = new Map<number, number>();
    const paseo = new Set<number>();
    try {
      for (const line of this.execFn("ps -axo pid=,ppid=,command=").split("\n")) {
        const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
        if (!m) continue;
        const pid = parseInt(m[1], 10);
        parent.set(pid, parseInt(m[2], 10));
        if (PASEO_ANCESTOR_RE.test(m[3])) paseo.add(pid);
      }
    } catch {
      return () => false;
    }
    if (paseo.size === 0) return () => false;
    return (pid: number) => {
      let current = pid;
      for (let hops = 0; hops < 20; hops++) {
        const ppid = parent.get(current);
        if (ppid === undefined || ppid <= 1) return false;
        if (paseo.has(ppid)) return true;
        current = ppid;
      }
      return false;
    };
  }

  private cwdOf(pid: number): string | null {
    try {
      const cwd = this.execFn(
        `lsof -a -d cwd -p ${pid} -Fn 2>/dev/null | grep '^n' | head -1`,
      )
        .trim()
        .replace(/^n/, "");
      return cwd || null;
    } catch {
      return null;
    }
  }

  /**
   * Find the most recently active session JSONL whose project dir matches
   * the process cwd (forward-encoded) or whose stored cwd field matches.
   */
  private sessionForCwd(cwd: string): string | null {
    const projectsDir = join(this.claudeDir, "projects");
    if (!existsSync(projectsDir)) return null;

    const encoded = encodeCwd(cwd);
    let best: { sessionId: string; mtime: number } | null = null;

    let dirs: string[];
    try {
      dirs = readdirSync(projectsDir);
    } catch {
      return null;
    }

    for (const dir of dirs) {
      if (dir !== encoded) continue;
      const dirPath = join(projectsDir, dir);
      let files: string[];
      try {
        files = readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));
      } catch {
        continue;
      }
      for (const file of files) {
        const filePath = join(dirPath, file);
        let mtime: number;
        try {
          mtime = statSync(filePath).mtime.getTime();
        } catch {
          continue;
        }
        if (best && mtime <= best.mtime) continue;

        let sessionId = file.replace(/\.jsonl$/, "");
        // Prefer sessionId + cwd from the JSONL data when present.
        try {
          const lines = readFileSync(filePath, "utf-8").split("\n").filter(
            Boolean,
          );
          for (
            let i = lines.length - 1;
            i >= 0 && i >= lines.length - 20;
            i--
          ) {
            try {
              const d = JSON.parse(lines[i]);
              if (d.cwd && d.cwd !== cwd) {
                // Encoded dir collided with a different real path — skip file.
                sessionId = "";
              }
              if (d.cwd) break;
            } catch {
              /* skip unparsable line */
            }
          }
        } catch {
          /* fall back to filename stem */
        }
        if (sessionId) best = { sessionId, mtime };
      }
    }
    return best?.sessionId ?? null;
  }
}
