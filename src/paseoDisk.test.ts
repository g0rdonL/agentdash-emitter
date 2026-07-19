import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DiskSource } from './paseoDisk.js';

// Realistic agent state file fixture (captured shape, anonymized).
function stateFile(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: 'agent-uuid-1',
    provider: 'kimi',
    cwd: '/Users/gordon/dev/agentdash-paseo',
    createdAt: '2026-07-18T08:15:33.243Z',
    updatedAt: '2026-07-18T08:15:33.253Z',
    lastActivityAt: '2026-07-18T08:15:33.253Z',
    lastUserMessageAt: '2026-07-18T08:15:33.250Z',
    title: 'agentdash-paseo: WS-B paseo sources',
    labels: {},
    lastStatus: 'running',
    lastModeId: 'default',
    config: { model: 'byteplus/glm-5.2' },
    persistence: {
      provider: 'kimi',
      sessionId: 'a6869c19-34c6-4c13-bef7-81fb717c4707',
      metadata: {
        provider: 'acp',
        cwd: '/Users/gordon/dev/agentdash-paseo',
        mcpServers: {
          paseo: {
            type: 'http',
            url: 'http://127.0.0.1:6767/mcp/agents?callerAgentId=agent-uuid-1',
            headers: { Authorization: 'Bearer 3d663545-0d8c-479b-bd83-b0577a8c31fe' },
          },
        },
      },
    },
    requiresAttention: false,
    attentionReason: null,
    attentionTimestamp: null,
    internal: false,
    ...overrides,
  });
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'paseo-disk-test-'));
});

afterEach(async () => {
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeFile(slug: string, name: string, contents: string, mtime?: Date) {
  const sub = path.join(tmpDir, slug);
  await fs.mkdir(sub, { recursive: true });
  const full = path.join(sub, name);
  await fs.writeFile(full, contents);
  if (mtime) await fs.utimes(full, mtime, mtime);
  return full;
}

describe('DiskSource.poll', () => {
  it('parses a real-shaped state file into PaseoAgent', async () => {
    await writeFile('Users-gordon-dev-agentdash-paseo', 'agent-1.json', stateFile());
    const src = new DiskSource({ agentsDir: tmpDir });
    const res = await src.poll();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.agents).toHaveLength(1);
    const a = res.agents[0];
    expect(a.id).toBe('agent-uuid-1');
    expect(a.title).toBe('agentdash-paseo: WS-B paseo sources');
    expect(a.cwd).toBe('/Users/gordon/dev/agentdash-paseo');
    expect(a.status).toBe('running');
    expect(a.archived).toBe(false);
    expect(a.requiresAttention).toBe(false);
    expect(a.attentionReason).toBeNull();
    expect(a.lastActivityAtMs).toBe(Date.parse('2026-07-18T08:15:33.253Z'));
  });

  it('maps requiresAttention and attentionReason fields', async () => {
    await writeFile(
      'slug',
      'a.json',
      stateFile({
        id: 'a-1',
        lastStatus: 'idle',
        lastActivityAt: '2026-07-18T08:13:03.323Z',
        requiresAttention: true,
        attentionReason: 'permission',
        attentionTimestamp: '2026-07-18T05:22:39.371Z',
      }),
    );
    const src = new DiskSource({ agentsDir: tmpDir });
    const res = await src.poll();
    if (!res.ok) throw new Error('expected ok');
    expect(res.agents).toHaveLength(1);
    expect(res.agents[0]).toMatchObject({
      id: 'a-1',
      status: 'idle',
      requiresAttention: true,
      attentionReason: 'permission',
    });
  });

  it('marks a file with no archivedAt as not-archived', async () => {
    await writeFile(
      'slug',
      'closed.json',
      stateFile({ id: 'closed-1', lastStatus: 'closed' }),
    );
    const src = new DiskSource({ agentsDir: tmpDir });
    const res = await src.poll();
    if (!res.ok) throw new Error('expected ok');
    expect(res.agents[0].status).toBe('closed');
    expect(res.agents[0].archived).toBe(false);
  });

  it('derives archived=true from archivedAt on disk (even when idle)', async () => {
    // Disk state files DO carry archivedAt for archived agents. An archived-but-
    // idle agent must be marked archived so it maps to disconnected, not a ghost
    // `waiting` row on the disk-fallback path.
    await writeFile(
      'slug',
      'archived-idle.json',
      stateFile({
        id: 'arch-1',
        lastStatus: 'idle',
        archivedAt: '2026-07-17T08:01:04.629Z',
      }),
    );
    const src = new DiskSource({ agentsDir: tmpDir });
    const res = await src.poll();
    if (!res.ok) throw new Error('expected ok');
    expect(res.agents).toHaveLength(1);
    expect(res.agents[0].status).toBe('idle');
    expect(res.agents[0].archived).toBe(true);
  });

  it('skips malformed JSON files with a warn', async () => {
    await writeFile('slug', 'good.json', stateFile({ id: 'good-1' }));
    await writeFile('slug', 'bad.json', '{ not valid json');
    const src = new DiskSource({ agentsDir: tmpDir });
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: string) => warns.push(msg);
    try {
      const res = await src.poll();
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.agents).toHaveLength(1);
      expect(res.agents[0].id).toBe('good-1');
      expect(warns.some((w) => w.includes('skipping'))).toBe(true);
    } finally {
      console.warn = origWarn;
    }
  });

  it('skips files without an id', async () => {
    await writeFile('slug', 'noid.json', JSON.stringify({ title: 'no id here' }));
    const src = new DiskSource({ agentsDir: tmpDir });
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: string) => warns.push(msg);
    try {
      const res = await src.poll();
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.agents).toHaveLength(0);
      expect(warns.some((w) => w.includes('skipping'))).toBe(true);
    } finally {
      console.warn = origWarn;
    }
  });

  it('returns empty list (ok) when agentsDir does not exist', async () => {
    const src = new DiskSource({ agentsDir: path.join(tmpDir, 'does-not-exist') });
    const res = await src.poll();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.agents).toEqual([]);
  });

  it('returns empty list when dir exists but has no subdirectories', async () => {
    await fs.writeFile(path.join(tmpDir, 'loose.json'), stateFile({ id: 'loose' }));
    const src = new DiskSource({ agentsDir: tmpDir });
    const res = await src.poll();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.agents).toEqual([]);
  });

  it('reads multiple agents across multiple subdirectories', async () => {
    await writeFile('slug-a', 'a1.json', stateFile({ id: 'a-1', title: 'A1' }));
    await writeFile('slug-a', 'a2.json', stateFile({ id: 'a-2', title: 'A2' }));
    await writeFile('slug-b', 'b1.json', stateFile({ id: 'b-1', title: 'B1' }));
    const src = new DiskSource({ agentsDir: tmpDir });
    const res = await src.poll();
    if (!res.ok) throw new Error('expected ok');
    expect(res.agents.map((a) => a.id).sort()).toEqual(['a-1', 'a-2', 'b-1']);
  });

  it('ignores non-json files in subdirectories', async () => {
    await writeFile('slug', 'a.json', stateFile({ id: 'a-1' }));
    await writeFile('slug', 'b.txt', 'not json');
    await writeFile('slug', 'c.log', 'not json either');
    const src = new DiskSource({ agentsDir: tmpDir });
    const res = await src.poll();
    if (!res.ok) throw new Error('expected ok');
    expect(res.agents).toHaveLength(1);
    expect(res.agents[0].id).toBe('a-1');
  });

  it('handles missing optional fields gracefully', async () => {
    await writeFile(
      'slug',
      'minimal.json',
      JSON.stringify({ id: 'min-1', cwd: '/p' }),
    );
    const src = new DiskSource({ agentsDir: tmpDir });
    const res = await src.poll();
    if (!res.ok) throw new Error('expected ok');
    const a = res.agents[0];
    expect(a.id).toBe('min-1');
    expect(a.title).toBeNull();
    expect(a.status).toBe('');
    expect(a.requiresAttention).toBe(false);
    expect(a.attentionReason).toBeNull();
    expect(a.lastActivityAtMs).toBe(0);
    expect(a.archived).toBe(false);
  });
});
