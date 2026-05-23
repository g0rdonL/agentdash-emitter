import { io, type Socket } from 'socket.io-client';
import type { StatusEvent, WidgetStatus } from './contract';
import type { PersistedSessionInfo } from './happyFiles';
import { loadPersistedSessions } from './happyFiles';
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
  /** Chat title from decrypted metadata.summary.text; null until one arrives. */
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
  }

  stop(): void {
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

  private ensureSession(sessionId: string): SessionRuntime | null {
    // Sessions we have no plaintext metadata for can't get a project label —
    // re-read sessions.json once in case it appeared after start().
    let rt = this.sessions.get(sessionId);
    if (rt) return rt;
    const info = this.loadSessions().find((s) => s.sessionId === sessionId);
    if (!info) return null;
    rt = newRuntime(info);
    this.sessions.set(sessionId, rt);
    return rt;
  }

  private handleEphemeral(update: unknown): void {
    if (!update || typeof update !== 'object') return;
    const u = update as { type?: string; id?: string; active?: boolean; activeAt?: number; thinking?: boolean };
    if (u.type !== 'activity' || typeof u.id !== 'string') return;
    const rt = this.ensureSession(u.id);
    if (!rt) return;
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
      ? [this.ensureSession(sessionId)].filter((x): x is SessionRuntime => x !== null)
      : [...this.sessions.values()];
    // An update may carry metadata (chat title) and/or agentState (permissions);
    // handle each independently rather than requiring agentState to be present.
    if (!body.metadata && !body.agentState) return;
    for (const rt of targets) {
      if (body.metadata?.value != null) {
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
        } else {
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
    const label = rt.title ?? rt.info.projectLabel;
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
}
