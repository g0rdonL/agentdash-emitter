import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AgentSource, PaseoAgent, SourceResult } from './paseoTypes.js';

export interface McpSourceOptions {
  baseUrl: string;
  agentsDir: string;
  /** Injectable for tests; defaults to global fetch (Node 20+). */
  fetchFn?: typeof fetch;
}

interface RawMcpAgent {
  id: string;
  title?: string | null;
  cwd?: string;
  status?: string;
  archivedAt?: string | null;
  requiresAttention?: boolean;
  attentionReason?: string | null;
  updatedAt?: string;
}

interface McpJsonRpcResponse {
  result?: {
    content?: Array<{ type?: string; text?: string }>;
  };
}

const HEALTH_TIMEOUT_MS = 2000;
const MCP_TIMEOUT_MS = 8000;

export class McpSource implements AgentSource {
  private readonly baseUrl: string;
  private readonly agentsDir: string;
  private readonly fetchFn: typeof fetch;
  private cachedToken: string | null = null;
  private tokenDiscoveryPromise: Promise<string | null> | null = null;

  constructor(opts: McpSourceOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.agentsDir = opts.agentsDir;
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  async poll(): Promise<SourceResult> {
    let token = await this.getToken();
    if (!token) {
      // No agent state files at all; treat as daemon-down only if health also fails.
      // Otherwise return empty (no agents known). Per spec, missing token means
      // we cannot auth MCP — classify based on daemon health.
      return this.classifyDaemonFailure('no agent state files found for token discovery');
    }

    let res = await this.callListAgents(token);
    if (res.status === 401) {
      // Re-discover token once and retry.
      this.cachedToken = null;
      token = await this.getToken(true);
      if (!token) return this.classifyDaemonFailure('token rediscovery failed');
      res = await this.callListAgents(token);
    }

    if (res.status === 401) {
      return { ok: false, reason: 'auth', detail: 'token rejected after rediscovery' };
    }

    if (!res.ok) {
      // Network error or non-200: distinguish daemon-down via health probe.
      const isDown = await this.isDaemonDown();
      return isDown
        ? { ok: false, reason: 'daemon-down', detail: `MCP call failed (${res.detail})` }
        : { ok: false, reason: 'error', detail: `MCP call failed (${res.detail})` };
    }

    const parsed = parseMcpResponse(res.body);
    if (!parsed.ok) {
      return { ok: false, reason: 'error', detail: `failed to parse MCP response: ${parsed.detail}` };
    }

    const agents = normalizeMcpAgents(parsed.value);
    return { ok: true, agents };
  }

  private async callListAgents(
    token: string,
  ): Promise<{ ok: true; status: number; body: string } | { ok: false; status: number; detail: string }> {
    const url = `${this.baseUrl}/mcp/agents`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MCP_TIMEOUT_MS);
    try {
      const res = await this.fetchFn(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'list_agents', arguments: {} },
        }),
        signal: controller.signal,
      });
      const body = await res.text();
      if (!res.ok) {
        return { ok: false, status: res.status, detail: `HTTP ${res.status}` };
      }
      return { ok: true, status: res.status, body };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, status: 0, detail: `network: ${msg}` };
    } finally {
      clearTimeout(timer);
    }
  }

  private async getToken(forceRediscover = false): Promise<string | null> {
    if (!forceRediscover && this.cachedToken) return this.cachedToken;
    // Serialize concurrent discovery (multiple poll() calls in flight are rare but possible).
    if (this.tokenDiscoveryPromise) {
      const t = await this.tokenDiscoveryPromise;
      if (t && !forceRediscover) return t;
    }
    this.tokenDiscoveryPromise = this.discoverToken();
    const token = await this.tokenDiscoveryPromise;
    this.tokenDiscoveryPromise = null;
    if (token) this.cachedToken = token;
    return token;
  }

  private async discoverToken(): Promise<string | null> {
    try {
      // Find newest *.json under agentsDir/** by mtime.
      let files: string[] = [];
      try {
        files = await collectAgentJson(this.agentsDir);
      } catch {
        return null;
      }
      if (files.length === 0) return null;

      let newestMtime = -1;
      let newestFile: string | null = null;
      for (const f of files) {
        try {
          const st = await fs.stat(f);
          if (st.mtimeMs > newestMtime) {
            newestMtime = st.mtimeMs;
            newestFile = f;
          }
        } catch {
          // file may vanish between readdir and stat; skip.
        }
      }
      if (!newestFile) return null;

      const raw = await fs.readFile(newestFile, 'utf8');
      const obj = JSON.parse(raw) as {
        persistence?: {
          metadata?: {
            mcpServers?: {
              paseo?: {
                headers?: { Authorization?: string };
              };
            };
          };
        };
      };
      const auth =
        obj?.persistence?.metadata?.mcpServers?.paseo?.headers?.Authorization ?? null;
      if (!auth) return null;
      const m = auth.match(/^Bearer\s+(.+)$/i);
      return m ? m[1] : null;
    } catch {
      return null;
    }
  }

  private async isDaemonDown(): Promise<boolean> {
    const url = `${this.baseUrl}/api/health`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    try {
      const res = await this.fetchFn(url, { signal: controller.signal });
      return !res.ok;
    } catch {
      return true;
    } finally {
      clearTimeout(timer);
    }
  }

  private async classifyDaemonFailure(detail: string): Promise<SourceResult> {
    const down = await this.isDaemonDown();
    return down
      ? { ok: false, reason: 'daemon-down', detail }
      : { ok: false, reason: 'error', detail };
  }
}

async function collectAgentJson(agentsDir: string): Promise<string[]> {
  const out: string[] = [];
  let topEntries: import('node:fs').Dirent[];
  try {
    topEntries = await fs.readdir(agentsDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of topEntries) {
    if (!entry.isDirectory()) continue;
    const sub = path.join(agentsDir, entry.name);
    let subEntries: import('node:fs').Dirent[];
    try {
      subEntries = await fs.readdir(sub, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of subEntries) {
      if (f.isFile() && f.name.endsWith('.json')) {
        out.push(path.join(sub, f.name));
      }
    }
  }
  return out;
}

export function parseMcpResponse(
  body: string,
): { ok: true; value: McpJsonRpcResponse } | { ok: false; detail: string } {
  let jsonText: string;
  const trimmed = body.trim();
  // SSE shape: lines like `event: message` and `data: {...}`.
  if (trimmed.startsWith('event:') || trimmed.startsWith('data:')) {
    const dataLines: string[] = [];
    for (const line of trimmed.split(/\r?\n/)) {
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    jsonText = dataLines.join('\n');
  } else {
    jsonText = trimmed;
  }
  let outer: McpJsonRpcResponse;
  try {
    outer = JSON.parse(jsonText) as McpJsonRpcResponse;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: `outer JSON parse failed: ${msg}` };
  }
  return { ok: true, value: outer };
}

export function normalizeMcpAgents(resp: McpJsonRpcResponse): PaseoAgent[] {
  const text = resp?.result?.content?.[0]?.text;
  if (!text) return [];
  // The text payload starts with a plaintext header
  // (`agents_count=...\nagents_ids=...\n\n`) followed by pretty-printed JSON
  // `{"agents": [...]}`. Slice from the first `{`.
  const start = text.indexOf('{');
  if (start < 0) return [];
  let inner: { agents?: RawMcpAgent[] };
  try {
    inner = JSON.parse(text.slice(start)) as { agents?: RawMcpAgent[] };
  } catch {
    return [];
  }
  const agents = Array.isArray(inner?.agents) ? inner!.agents! : [];
  const out: PaseoAgent[] = [];
  for (const a of agents) {
    if (!a || typeof a.id !== 'string') continue;
    out.push({
      id: a.id,
      title: a.title ?? null,
      cwd: typeof a.cwd === 'string' ? a.cwd : '',
      status: typeof a.status === 'string' ? a.status : '',
      archived: a.archivedAt != null,
      requiresAttention: a.requiresAttention === true,
      attentionReason: a.attentionReason ?? null,
      lastActivityAtMs: a.updatedAt ? Date.parse(a.updatedAt) : 0,
    });
  }
  return out;
}
