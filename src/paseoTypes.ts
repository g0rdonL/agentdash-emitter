/** Normalized Paseo agent snapshot — both sources produce this shape. */
export interface PaseoAgent {
  id: string;
  title: string | null;
  cwd: string;
  /** Raw lifecycle status: initializing|idle|running|error|closed (or unknown). */
  status: string;
  archived: boolean;
  requiresAttention: boolean;
  attentionReason: string | null;
  /** ms epoch of last activity (MCP: updatedAt; disk: lastActivityAt). */
  lastActivityAtMs: number;
}

export type SourceResult =
  | { ok: true; agents: PaseoAgent[] }
  | { ok: false; reason: "auth" | "daemon-down" | "error"; detail?: string };

export interface AgentSource {
  poll(): Promise<SourceResult>;
}

export interface AdapterConfig {
  paseoBaseUrl: string; // PASEO_BASE_URL, default http://127.0.0.1:6767
  paseoAgentsDir: string; // PASEO_AGENTS_DIR, default ~/.paseo/agents (~ expanded)
  pollIntervalMs: number; // POLL_INTERVAL_SEC * 1000, default 5000
  idleTtlMs: number; // IDLE_TTL_MIN * 60_000, default 30 min
  healthFailuresMax: number; // HEALTH_FAILURES_MAX, default 3
}
