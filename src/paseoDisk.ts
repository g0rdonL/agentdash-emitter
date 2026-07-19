import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AgentSource, PaseoAgent, SourceResult } from './paseoTypes.js';

export interface DiskSourceOptions {
  agentsDir: string;
}

/**
 * Paths we have already warned about (malformed / id-less files). Deduped at
 * module level so a permanently-broken file warns ONCE per process rather than
 * every poll tick (default 5s → ~17k log lines/day otherwise).
 */
const warnedPaths = new Set<string>();

function warnOnce(fullPath: string, message: string): void {
  if (warnedPaths.has(fullPath)) return;
  warnedPaths.add(fullPath);
  console.warn(message);
}

interface RawDiskAgent {
  id?: string;
  title?: string | null;
  cwd?: string;
  lastStatus?: string;
  lastActivityAt?: string;
  requiresAttention?: boolean;
  attentionReason?: string | null;
  archivedAt?: string | null;
}

export class DiskSource implements AgentSource {
  private readonly agentsDir: string;

  constructor(opts: DiskSourceOptions) {
    this.agentsDir = opts.agentsDir;
  }

  async poll(): Promise<SourceResult> {
    const agents: PaseoAgent[] = [];
    let topEntries: import('node:fs').Dirent[];
    try {
      topEntries = await fs.readdir(this.agentsDir, { withFileTypes: true });
    } catch {
      // Missing dir → empty list (never fails hard).
      return { ok: true, agents };
    }
    for (const entry of topEntries) {
      if (!entry.isDirectory()) continue;
      const sub = path.join(this.agentsDir, entry.name);
      let subEntries: import('node:fs').Dirent[];
      try {
        subEntries = await fs.readdir(sub, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const f of subEntries) {
        if (!f.isFile() || !f.name.endsWith('.json')) continue;
        const full = path.join(sub, f.name);
        try {
          const raw = await fs.readFile(full, 'utf8');
          const obj = JSON.parse(raw) as RawDiskAgent;
          if (!obj || typeof obj.id !== 'string') {
            warnOnce(full, `[paseo-disk] skipping ${full}: missing id`);
            continue;
          }
          agents.push({
            id: obj.id,
            title: obj.title ?? null,
            cwd: typeof obj.cwd === 'string' ? obj.cwd : '',
            status: typeof obj.lastStatus === 'string' ? obj.lastStatus : '',
            // Disk state files DO carry `archivedAt` when an agent is archived
            // (contrary to an earlier assumption). Derive `archived` from it,
            // matching McpSource normalization — otherwise an archived-but-idle
            // agent would show as a ghost `waiting` row on the disk-fallback path.
            archived: obj.archivedAt != null,
            requiresAttention: obj.requiresAttention === true,
            attentionReason: obj.attentionReason ?? null,
            lastActivityAtMs: obj.lastActivityAt
              ? Date.parse(obj.lastActivityAt)
              : 0,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          warnOnce(full, `[paseo-disk] skipping ${full}: ${msg}`);
        }
      }
    }
    return { ok: true, agents };
  }
}
