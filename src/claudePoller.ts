import { execSync as nodeExecSync } from "child_process";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "fs";
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
  label: string;
}

const LABEL_MAX = 40;
const LABEL_SCAN_BYTES = 128 * 1024;

/** First real user prompt in a session JSONL, trimmed for a widget row. */
export function firstPromptLabel(filePath: string): string | null {
  let text: string;
  try {
    const fd = openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(LABEL_SCAN_BYTES);
      text = buf.toString("utf-8", 0, readSync(fd, buf, 0, buf.length, 0));
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
  for (const line of text.split("\n")) {
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      continue; // blank, or the last line cut off by the scan window
    }
    if (d.type !== "user" || d.isMeta || d.isSidechain) continue;
    const c = d.message?.content;
    const raw = typeof c === "string"
      ? c
      : Array.isArray(c)
      ? c.find((b: any) => b?.type === "text" && typeof b.text === "string")?.text
      : null;
    const flat = String(raw ?? "").replace(/\s+/g, " ").trim();
    if (!flat || flat.startsWith("<")) continue; // tool results, command/system tags
    return flat.length > LABEL_MAX ? flat.slice(0, LABEL_MAX - 1) + "…" : flat;
  }
  return null;
}

export class ClaudePoller {
  private readonly claudeDir: string;
  private readonly intervalMs: number;
  private readonly execFn: (cmd: string) => string;
  private readonly nowFn: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private known = new Map<string, LiveSession>();
  // pid -> session it was first assigned. Keeps two claude processes sharing a
  // cwd from swapping/collapsing onto whichever JSONL was written last.
  private pidSession = new Map<number, string>();

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
          projectLabel: s.label,
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
          projectLabel: s.label,
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

    const livePids = new Set(procs.map((p) => p.pid));
    for (const pid of this.pidSession.keys()) {
      if (!livePids.has(pid)) this.pidSession.delete(pid);
    }

    // Sticky assignments first, so a long-running process keeps its row even
    // when a sibling in the same cwd writes a newer JSONL.
    const claimed = new Set<string>();
    for (const proc of procs) {
      const sticky = this.pidSession.get(proc.pid);
      if (sticky && !claimed.has(sticky)) claimed.add(sticky);
    }

    const candidates = new Map<string, string[]>();
    for (const proc of procs.sort((a, b) => a.pid - b.pid)) {
      let sessionId = this.pidSession.get(proc.pid);
      if (!sessionId) {
        let list = candidates.get(proc.cwd);
        if (!list) {
          list = this.sessionsForCwd(proc.cwd);
          candidates.set(proc.cwd, list);
        }
        sessionId = list.find((id) => !claimed.has(id));
        if (sessionId) {
          claimed.add(sessionId);
          this.pidSession.set(proc.pid, sessionId);
        }
      }
      sessionId ??= `claude-${proc.pid}`;
      const label = this.labelFor(sessionId, proc.cwd, proc.pid);
      result.set(sessionId, { sessionId, cwd: proc.cwd, pid: proc.pid, label });
    }
    return result;
  }

  // Cached per session: the first prompt never changes, and it's only emitted
  // once, so don't rescan the JSONL every poll.
  private labels = new Map<string, string>();

  private labelFor(sessionId: string, cwd: string, pid: number): string {
    const cached = this.labels.get(sessionId);
    if (cached) return cached;
    const file = join(this.claudeDir, "projects", encodeCwd(cwd), `${sessionId}.jsonl`);
    const label = firstPromptLabel(file) ??
      (sessionId.startsWith("claude-")
        ? `${basename(cwd) || cwd} (${pid})`
        : `${basename(cwd) || cwd} ${sessionId.slice(0, 8)}`);
    this.labels.set(sessionId, label);
    return label;
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
   * Session ids whose project dir matches the process cwd (forward-encoded),
   * most recently written first. Files whose stored cwd differs (encoded-dir
   * collision) are skipped.
   */
  private sessionsForCwd(cwd: string): string[] {
    const projectsDir = join(this.claudeDir, "projects");
    if (!existsSync(projectsDir)) return [];

    const dirPath = join(projectsDir, encodeCwd(cwd));
    let files: string[];
    try {
      files = readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));
    } catch {
      return [];
    }

    const found: Array<{ sessionId: string; mtime: number }> = [];
    for (const file of files) {
      const filePath = join(dirPath, file);
      let mtime: number;
      try {
        mtime = statSync(filePath).mtime.getTime();
      } catch {
        continue;
      }

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
      if (sessionId) found.push({ sessionId, mtime });
    }
    return found.sort((x, y) => y.mtime - x.mtime).map((f) => f.sessionId);
  }
}
