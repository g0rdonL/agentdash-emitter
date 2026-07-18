import { io, type Socket } from 'socket.io-client';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import type { StatusEvent, WidgetStatus } from './contract';
import type { PersistedSessionInfo } from './happyFiles';
import { happyHomeDir, loadPersistedSessions, projectLabel } from './happyFiles';
import { deriveStatus } from './status';
import { decryptAgentState, pendingRequestCount, decryptMetadataTitle } from './decryptWrapper';

export interface StatusEventCallback {
  (event: StatusEvent): void;
}

/** The pluggable source interface; the Happy adapter is the only MVP impl. */
export interface StatusAdapter {
  start(onStatusEvent: StatusEventCallback): void;
  stop(): void;
}

interface SessionRuntime {
  info: PersistedSessionInfo;
  active: boolean;
  thinking: boolean;
  pendingRequestCount: number;
  /** Chat title from decrypted metadata.summary.text or title file; null until one arrives. */
  title: string | null;
  lastEmitted: WidgetStatus | null;
  lastEmittedLabel: string | null;
  lastActiveAt: number;
  debounceTimer: ReturnType<typeof setTimeout> | null;
}

function newRuntime(info: PersistedSessionInfo): SessionRuntime {
  return {
    info,
    active: false,
    thinking: false,
    pendingRequestCount: 0,
    title: null,
    lastEmitted: null,
    lastEmittedLabel: null,
    lastActiveAt: 0,
    debounceTimer: null,
  };
}

export interface HappyAdapterOptions {
  serverUrl: string;
  accountToken: string;
  /** Injectable for tests; defaults to reading ~/.happy/sessions.json. */
  loadSessions?: () => PersistedSessionInfo[];
  /** Injectable for tests; defaults to a real socket.io-client connection. */
  socketFactory?: (serverUrl: string, accountToken: string) => Socket;
  /** Debounce window before emitting a session's status. Default 500ms. */
  debounceMs?: number;
  happyClient?: string;
}

function defaultSocketFactory(serverUrl: string, accountToken: string): Socket {
  return io(serverUrl, {
    path: '/v1/updates',
    auth: {
      token: accountToken,
      clientType: 'user-scoped',
      happyClient: 'agent-status-widget-emitter/0.0.1',
      appState: 'active',
    },
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    reconnectionAttempts: Infinity,
  });
}

export class HappyAdapter implements StatusAdapter {
  private readonly serverUrl: string;
  private readonly accountToken: string;
  private readonly loadSessions: () => PersistedSessionInfo[];
  private readonly socketFactory: (serverUrl: string, accountToken: string) => Socket;
  private readonly debounceMs: number;

  private socket: Socket | null = null;
  private sessions = new Map<string, SessionRuntime>();
  private onEvent: StatusEventCallback | null = null;
  private labelResolverInterval: ReturnType<typeof setInterval> | null = null;

  constructor(opts: HappyAdapterOptions) {
    this.serverUrl = opts.serverUrl;
    this.accountToken = opts.accountToken;
    this.loadSessions = opts.loadSessions ?? (() => loadPersistedSessions());
    this.socketFactory = opts.socketFactory ?? defaultSocketFactory;
    this.debounceMs = opts.debounceMs ?? 500;
  }

  start(onStatusEvent: StatusEventCallback): void {
    this.onEvent = onStatusEvent;
    for (const info of this.loadSessions()) {
      this.sessions.set(info.sessionId, newRuntime(info));
    }

    const socket = this.socketFactory(this.serverUrl, this.accountToken);
    this.socket = socket;

    socket.on('ephemeral', (update: unknown) => this.handleEphemeral(update));
    socket.on('update', (data: unknown) => this.handleUpdate(data));
    socket.on('disconnect', () => this.markAllDisconnected());

    socket.connect();

    // Periodically try to resolve placeholder labels from sessions.json,
    // title file, or running processes.
    this.labelResolverInterval = setInterval(() => this.resolveLabels(), 30_000);
    // Run once immediately after a short delay to let initial events arrive.
    setTimeout(() => this.resolveLabels(), 5_000);
  }

  stop(): void {
    if (this.labelResolverInterval) clearInterval(this.labelResolverInterval);
    this.labelResolverInterval = null;
    for (const s of this.sessions.values()) {
      if (s.debounceTimer) clearTimeout(s.debounceTimer);
    }
    this.sessions.clear();
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this.onEvent = null;
  }

  private ensureSession(sessionId: string): SessionRuntime {
    let rt = this.sessions.get(sessionId);
    if (rt) return rt;
    // Try to find the session in sessions.json (may have appeared after start).
    const info = this.loadSessions().find((s) => s.sessionId === sessionId);
    if (info) {
      rt = newRuntime(info);
    } else {
      // Session not in sessions.json (file was cleared or session started after
      // our process). Create a placeholder so we can still track status — we
      // just won't be able to decrypt the chat title.
      rt = newRuntime({
        sessionId,
        encryptionKey: '',
        encryptionVariant: 'dataKey',
        projectLabel: sessionId.slice(0, 12),
      });
    }
    this.sessions.set(sessionId, rt);
    return rt;
  }

  private handleEphemeral(update: unknown): void {
    if (!update || typeof update !== 'object') return;
    const u = update as { type?: string; id?: string; active?: boolean; activeAt?: number; thinking?: boolean };
    if (u.type !== 'activity' || typeof u.id !== 'string') return;
    const rt = this.ensureSession(u.id);
    rt.active = !!u.active;
    rt.thinking = !!u.thinking;
    if (typeof u.activeAt === 'number') rt.lastActiveAt = u.activeAt;
    this.scheduleEmit(rt);
  }

  private handleUpdate(data: unknown): void {
    if (!data || typeof data !== 'object') return;
    const body = (data as { body?: any }).body;
    if (!body || body.t !== 'update-session') return;
    const sessionId: string | undefined = body.sid ?? body.sessionId ?? body.id;
    // The session-scoped update payload does not always carry the id; if absent,
    // apply to all known sessions only when there is exactly one (MVP single-account).
    const targets: SessionRuntime[] = sessionId
      ? [this.ensureSession(sessionId)]
      : [...this.sessions.values()];
    // An update may carry metadata (chat title) and/or agentState (permissions);
    // handle each independently rather than requiring agentState to be present.
    if (!body.metadata && !body.agentState) return;
    for (const rt of targets) {
      if (body.metadata?.value != null && rt.info.encryptionKey) {
        const title = decryptMetadataTitle(
          rt.info.encryptionKey,
          rt.info.encryptionVariant,
          body.metadata.value,
        );
        if (title) rt.title = title;
      }
      if (body.agentState) {
        if (body.agentState.value == null) {
          rt.pendingRequestCount = 0;
        } else if (rt.info.encryptionKey) {
          const decrypted = decryptAgentState(
            rt.info.encryptionKey,
            rt.info.encryptionVariant,
            body.agentState.value,
          );
          rt.pendingRequestCount = pendingRequestCount(decrypted);
        }
      }
      this.scheduleEmit(rt);
    }
  }

  private markAllDisconnected(): void {
    for (const rt of this.sessions.values()) {
      rt.active = false;
      this.scheduleEmit(rt);
    }
  }

  private scheduleEmit(rt: SessionRuntime): void {
    if (rt.debounceTimer) clearTimeout(rt.debounceTimer);
    rt.debounceTimer = setTimeout(() => this.emit(rt), this.debounceMs);
  }

  private emit(rt: SessionRuntime): void {
    rt.debounceTimer = null;
    const status = deriveStatus({
      active: rt.active,
      thinking: rt.thinking,
      pendingRequestCount: rt.pendingRequestCount,
    });
    // Prefer the chat title; fall back to the working-dir name until one arrives.
    // '😊 ' prefix marks Happy sessions on the widget (mirrors the paseo
    // emitter's '⛵ ' convention); standalone Claude sessions (claudePoller)
    // stay unprefixed.
    const label = '😊 ' + (rt.title ?? rt.info.projectLabel);
    if (status === rt.lastEmitted && label === rt.lastEmittedLabel) return; // dedupe
    rt.lastEmitted = status;
    rt.lastEmittedLabel = label;
    this.onEvent?.({
      sessionId: rt.info.sessionId,
      status,
      projectLabel: label,
      updatedAt: rt.lastActiveAt || Date.now(),
    });
  }

  /**
   * Periodically re-read sessions.json, title file, and scan processes to
   * resolve placeholder labels.
   */
  private resolveLabels(): void {
    // 1. Try sessions.json first (may have been repopulated by new sessions).
    const persisted = this.loadSessions();
    for (const info of persisted) {
      const rt = this.sessions.get(info.sessionId);
      if (rt && !rt.info.encryptionKey) {
        // Upgrade placeholder with real session info.
        rt.info = info;
        console.log(`[adapter] resolved label from sessions.json: ${info.sessionId.slice(0, 12)} → ${info.projectLabel}`);
        this.scheduleEmit(rt);
      }
    }

    // 2. Try session-titles.json (written by PostToolUse hook on change_title).
    this.resolveFromTitleFile();

    // 3. For remaining placeholders, try to extract CWDs from Happy wrapper processes.
    const placeholders = [...this.sessions.values()].filter((rt) => !rt.info.encryptionKey && !rt.title);
    if (placeholders.length === 0) return;

    try {
      // Find Happy wrapper PIDs and their CWDs.
      const hookDir = `${process.env.HAPPY_HOME_DIR ?? `${process.env.HOME}/.happy`}/tmp/hooks`;
      const cwdMap = new Map<number, string>();
      const files = execSync(`ls ${hookDir}/session-hook-*.json 2>/dev/null`, { encoding: 'utf-8' }).trim().split('\n').filter(Boolean);
      for (const f of files) {
        const pid = parseInt(f.match(/session-hook-(\d+)/)?.[1] ?? '0');
        if (!pid) continue;
        try {
          execSync(`kill -0 ${pid}`, { stdio: 'ignore' });
          const cwd = execSync(`lsof -p ${pid} 2>/dev/null | grep cwd | awk '{print $NF}'`, { encoding: 'utf-8' }).trim();
          if (cwd) cwdMap.set(pid, cwd);
        } catch { /* dead process */ }
      }

      // Assign unmatched CWDs to unmatched placeholders.
      // This is best-effort — can't perfectly match session IDs to PIDs without
      // the daemon's internal state, but CWD-based labels are better than truncated IDs.
      const usedCwds = new Set<string>();
      for (const rt of this.sessions.values()) {
        if (rt.info.encryptionKey) usedCwds.add(rt.info.projectLabel);
      }
      const availableCwds = [...cwdMap.values()]
        .map((cwd) => ({ cwd, label: projectLabel(cwd) }))
        .filter(({ label }) => !usedCwds.has(label));

      let i = 0;
      for (const rt of placeholders) {
        if (i >= availableCwds.length) break;
        const { label } = availableCwds[i++];
        rt.info = { ...rt.info, projectLabel: label };
        console.log(`[adapter] resolved label from process: ${rt.info.sessionId.slice(0, 12)} → ${label}`);
        this.scheduleEmit(rt);
      }
    } catch { /* lsof/ls failed — skip this cycle */ }
  }

  /**
   * Read chat titles from ~/.happy/session-titles.json (written by PostToolUse hook
   * when change_title MCP tool is called). Titles are keyed by Happy session ID.
   */
  private resolveFromTitleFile(): void {
    try {
      const raw = readFileSync(`${happyHomeDir()}/session-titles.json`, 'utf-8');
      const titles = JSON.parse(raw) as Record<string, { title: string; updatedAt: number }>;

      for (const [sessionId, entry] of Object.entries(titles)) {
        if (!entry?.title) continue;
        // Try exact match first, then prefix match.
        let matched: SessionRuntime | undefined;
        matched = this.sessions.get(sessionId);
        if (!matched) {
          for (const rt of this.sessions.values()) {
            if (rt.info.sessionId.startsWith(sessionId) || sessionId.startsWith(rt.info.sessionId)) {
              matched = rt;
              break;
            }
          }
        }
        if (matched && matched.title !== entry.title) {
          matched.title = entry.title;
          console.log(`[adapter] resolved title from file: ${matched.info.sessionId.slice(0, 12)} → ${entry.title}`);
          this.scheduleEmit(matched);
        }
      }
    } catch { /* file doesn't exist yet or is malformed — fine */ }
  }
}
