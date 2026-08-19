import { execSync as nodeExecSync } from "child_process";
import { existsSync } from "fs";
import { createRequire } from "module";
import { basename, join } from "path";
import { homedir } from "os";
import type { StatusEvent, StatusEventMetadata } from "./contract.js";

/**
 * Polls the local OpenCode sqlite database
 * (~/.local/share/opencode/opencode.db) and emits StatusEvents for sessions
 * that have been updated within the active window.
 *
 * - The live db is opened STRICTLY read-only & immutable
 *   (file:...?mode=ro&immutable=1); it is never opened writable.
 * - Uses node:sqlite (DatabaseSync) so no new npm dependency is needed. When
 *   node:sqlite is unavailable on the runtime Node version, it falls back to
 *   shelling out to the `sqlite3` CLI with -readonly.
 * - A session is "active" if time_updated is within the last
 *   `activeThresholdMs` (default 120s). Active sessions are emitted with state
 *   derived from recency: updated < workingThresholdMs (default 15s) ago =>
 *   "thinking"; otherwise "waiting". Re-emission only happens when state or
 *   label changes between polls.
 * - When a previously-active session falls out of the active window, one
 *   final "disconnected" event is emitted, then it is forgotten.
 * - db-missing / db-locked errors are logged once and the poller keeps going.
 */

export interface OpencodePollerOptions {
  dbPath?: string;
  intervalMs?: number;
  /** Session is "active" if time_updated within this window. Default 120_000. */
  activeThresholdMs?: number;
  /** Within active window, updated more recently than this => "thinking". Default 15_000. */
  workingThresholdMs?: number;
  nowFn?: () => number;
  /** Injectable for tests; defaults to child_process.execSync (sqlite3 CLI fallback). */
  execFn?: (cmd: string) => string;
}

interface SessionRow {
  id: string;
  title: string | null;
  directory: string | null;
  agent: string | null;
  model: string | null;
  cost: number | null;
  time_created: number | null;
  time_updated: number;
}

interface KnownSession {
  status: "thinking" | "waiting";
  projectLabel: string;
}

const SESSION_PREFIX = "opencode:";
const DEFAULT_LABEL = "opencode";

export class OpencodePoller {
  private readonly dbPath: string;
  private readonly intervalMs: number;
  private readonly activeThresholdMs: number;
  private readonly workingThresholdMs: number;
  private readonly nowFn: () => number;
  private readonly execFn: (cmd: string) => string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private known = new Map<string, KnownSession>();
  private missingLogged = false;
  private lockedLogged = false;

  constructor(opts: OpencodePollerOptions = {}) {
    this.dbPath = opts.dbPath ??
      join(homedir(), ".local", "share", "opencode", "opencode.db");
    this.intervalMs = opts.intervalMs ?? 60_000;
    this.activeThresholdMs = opts.activeThresholdMs ?? 120_000;
    this.workingThresholdMs = opts.workingThresholdMs ?? 15_000;
    this.nowFn = opts.nowFn ?? Date.now;
    this.execFn = opts.execFn ??
      ((cmd: string) => nodeExecSync(cmd, { encoding: "utf-8" }) as string);
  }

  start(onEvent: (event: StatusEvent) => void): void {
    const tick = () => {
      try {
        this.poll(onEvent);
      } catch (err) {
        console.error("[opencode-poller] poll failed:", err);
      }
    };
    tick();
    this.timer = setInterval(tick, this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One poll cycle: emit events for active sessions + disconnects. */
  poll(onEvent: (event: StatusEvent) => void): void {
    const now = this.nowFn();
    let rows: SessionRow[];
    try {
      rows = this.queryActiveSessions(now);
    } catch (err) {
      this.handleDbError(err);
      return;
    }
    this.missingLogged = false;
    this.lockedLogged = false;

    const live = new Map<string, KnownSession>();
    for (const row of rows) {
      const sessionId = SESSION_PREFIX + row.id;
      const projectLabel = this.titleFor(row);
      const status: "thinking" | "waiting" =
        now - row.time_updated < this.workingThresholdMs
          ? "thinking"
          : "waiting";
      const metadata = this.metadataFor(row);
      const prev = this.known.get(sessionId);
      if (
        !prev || prev.status !== status || prev.projectLabel !== projectLabel
      ) {
        const event: StatusEvent = {
          sessionId,
          status,
          projectLabel,
          updatedAt: now,
        };
        if (metadata) event.metadata = metadata;
        onEvent(event);
      }
      live.set(sessionId, { status, projectLabel });
    }

    for (const [sessionId, s] of this.known) {
      if (!live.has(sessionId)) {
        onEvent({
          sessionId,
          status: "disconnected",
          projectLabel: s.projectLabel,
          updatedAt: now,
        });
      }
    }
    this.known = live;
  }

  private titleFor(row: SessionRow): string {
    if (row.title && row.title.trim()) return row.title.trim();
    if (row.directory) return basename(row.directory) || row.directory;
    return DEFAULT_LABEL;
  }

  private metadataFor(row: SessionRow): StatusEventMetadata | undefined {
    if (!row.model) return undefined;
    try {
      const parsed = JSON.parse(row.model) as { id?: unknown };
      if (typeof parsed?.id === "string" && parsed.id) {
        return { modelId: parsed.id };
      }
    } catch {
      /* malformed model json — ignore */
    }
    return undefined;
  }

  private handleDbError(err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    const dbMissing = !existsSync(this.dbPath) ||
      /no such file|SQLITE_CANTOPEN|cannot open|does not exist|unable to open/i
        .test(msg);
    if (dbMissing) {
      if (!this.missingLogged) {
        console.error(
          `[opencode-poller] db missing at ${this.dbPath} — will keep polling`,
        );
        this.missingLogged = true;
      }
      return;
    }
    if (/locked|busy|SQLITE_BUSY|SQLITE_LOCKED|database is locked/i.test(msg)) {
      if (!this.lockedLogged) {
        console.error(
          `[opencode-poller] db locked at ${this.dbPath} — will keep polling`,
        );
        this.lockedLogged = true;
      }
      return;
    }
    console.error("[opencode-poller] unexpected db error:", err);
  }

  /** Query all active sessions (time_updated >= now - activeThresholdMs). */
  private queryActiveSessions(now: number): SessionRow[] {
    const since = now - this.activeThresholdMs;
    try {
      return this.queryWithNodeSqlite(since);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        /Cannot find module|No such module|is not a function|not available|experimental/i
          .test(msg)
      ) {
        return this.queryWithSqliteCli(since);
      }
      throw err;
    }
  }

  private queryWithNodeSqlite(since: number): SessionRow[] {
    // createRequire: plain `require` is undefined under ESM (tsx runs the
    // emitter as ESM; hit live 2026-07-25 — "ReferenceError: require is not
    // defined" bypassed the CLI fallback because its message didn't match
    // the fallback regex).
    const nodeRequire = createRequire(import.meta.url);
    const { DatabaseSync } = nodeRequire(
      "node:sqlite",
    ) as typeof import("node:sqlite");
    const uri = `file:${this.dbPath}?mode=ro&immutable=1`;
    const db = new DatabaseSync(uri);
    try {
      const stmt = db.prepare(
        "SELECT id, title, directory, agent, model, cost, time_created, time_updated " +
          "FROM session WHERE time_updated >= ?",
      );
      return stmt.all(since) as unknown[] as SessionRow[];
    } finally {
      db.close();
    }
  }

  private queryWithSqliteCli(since: number): SessionRow[] {
    const escPath = this.dbPath.replace(/'/g, "'\\''");
    const sql =
      "SELECT id, title, directory, agent, model, cost, time_created, time_updated " +
      "FROM session WHERE time_updated >= " +
      Number(since) +
      ";";
    const escapedSql = sql.replace(/'/g, "'\\''");
    const cmd = `sqlite3 -readonly '${escPath}' -json '${escapedSql}'`;
    const out = this.execFn(cmd).trim();
    if (!out) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(out);
    } catch {
      return [];
    }
    return Array.isArray(parsed) ? (parsed as SessionRow[]) : [];
  }
}
