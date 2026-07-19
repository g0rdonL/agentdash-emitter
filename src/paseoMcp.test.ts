import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { McpSource, normalizeMcpAgents, parseMcpResponse } from './paseoMcp.js';
import type { PaseoAgent } from './paseoTypes.js';

// --- Realistic fixtures (captured against a live Paseo daemon 2026-07-18) ---

// SSE response: `event: message\ndata: {...}` with header `agents_count=...` + JSON body.
const SSE_RESPONSE = `event: message
data: {"result":{"content":[{"type":"text","text":"agents_count=2\\nagents_ids=id-a,id-b\\n\\n{\\n  \\"agents\\": [\\n    {\\n      \\"id\\": \\"id-a\\",\\n      \\"shortId\\": \\"id-a\\",\\n      \\"title\\": \\"agentdash-paseo: WS-0 foundation\\",\\n      \\"provider\\": \\"kimi\\",\\n      \\"model\\": \\"byteplus/glm-5.2\\",\\n      \\"status\\": \\"idle\\",\\n      \\"cwd\\": \\"/Users/gordon/dev/agentdash-paseo\\",\\n      \\"createdAt\\": \\"2026-07-18T08:13:38.402Z\\",\\n      \\"updatedAt\\": \\"2026-07-18T08:14:47.169Z\\",\\n      \\"archivedAt\\": null,\\n      \\"requiresAttention\\": true,\\n      \\"attentionReason\\": \\"finished\\",\\n      \\"attentionTimestamp\\": \\"2026-07-18T08:14:47.169Z\\",\\n      \\"labels\\": {}\\n    },\\n    {\\n      \\"id\\": \\"id-b\\",\\n      \\"shortId\\": \\"id-b\\",\\n      \\"title\\": \\"agentdash-paseo: WS-B paseo sources\\",\\n      \\"provider\\": \\"kimi\\",\\n      \\"model\\": \\"byteplus/glm-5.2\\",\\n      \\"status\\": \\"running\\",\\n      \\"cwd\\": \\"/Users/gordon/dev/agentdash-paseo\\",\\n      \\"createdAt\\": \\"2026-07-18T08:15:33.243Z\\",\\n      \\"updatedAt\\": \\"2026-07-18T08:15:33.253Z\\",\\n      \\"archivedAt\\": null,\\n      \\"requiresAttention\\": false,\\n      \\"attentionReason\\": null,\\n      \\"attentionTimestamp\\": null,\\n      \\"labels\\": {}\\n    }\\n  ]\\n}"}]}}

`;

// Plain JSON (no SSE wrapper).
const JSON_RESPONSE = JSON.stringify({
  result: {
    content: [
      {
        type: 'text',
        text:
          'agents_count=1\nagents_ids=id-c\n\n' +
          JSON.stringify(
            {
              agents: [
                {
                  id: 'id-c',
                  title: 'agentdash-paseo: plan',
                  provider: 'claude',
                  model: 'claude-fable-5',
                  status: 'idle',
                  cwd: '/Users/gordon/dev/agentdash-paseo',
                  createdAt: '2026-07-18T03:09:48.993Z',
                  updatedAt: '2026-07-18T08:13:03.323Z',
                  archivedAt: null,
                  requiresAttention: true,
                  attentionReason: 'permission',
                  attentionTimestamp: '2026-07-18T05:22:39.371Z',
                  labels: {},
                },
              ],
            },
            null,
            2,
          ),
      },
    ],
  },
});

// A full agent state file with persistence.metadata.mcpServers.paseo.headers.Authorization
function stateFileContents(token: string, id = 'agent-1') {
  return JSON.stringify({
    id,
    provider: 'kimi',
    cwd: '/Users/gordon/dev/agentdash-paseo',
    createdAt: '2026-07-18T08:15:33.243Z',
    updatedAt: '2026-07-18T08:15:33.253Z',
    lastActivityAt: '2026-07-18T08:15:33.253Z',
    title: 'agentdash-paseo: WS-B paseo sources',
    labels: {},
    lastStatus: 'running',
    persistence: {
      provider: 'kimi',
      sessionId: 'a6869c19-34c6-4c13-bef7-81fb717c4707',
      nativeHandle: 'a6869c19-34c6-4c13-bef7-81fb717c4707',
      metadata: {
        provider: 'acp',
        cwd: '/Users/gordon/dev/agentdash-paseo',
        model: 'byteplus/glm-5.2',
        title: 'agentdash-paseo: WS-B paseo sources',
        mcpServers: {
          paseo: {
            type: 'http',
            url: 'http://127.0.0.1:6767/mcp/agents?callerAgentId=' + id,
            headers: {
              Authorization: `Bearer ${token}`,
            },
          },
        },
      },
    },
    requiresAttention: false,
    attentionReason: null,
    attentionTimestamp: null,
    internal: false,
  });
}

function makeFetch(
  handler: (url: string, init: RequestInit) => Promise<{ status: number; body: string }>,
): typeof fetch {
  return (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url;
    const { status, body } = await handler(url, init);
    return new Response(body, {
      status,
      headers: { 'Content-Type': status === 200 ? 'text/event-stream' : 'application/json' },
    });
  }) as unknown as typeof fetch;
}

let tmpDir: string;

async function setupAgentsDir(token: string) {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'paseo-mcp-test-'));
  const slug = 'Users-gordon-dev-test-project';
  const sub = path.join(tmpDir, slug);
  await fs.mkdir(sub, { recursive: true });
  await fs.writeFile(path.join(sub, 'agent-1.json'), stateFileContents(token, 'agent-1'));
  return tmpDir;
}

async function cleanupTmp() {
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true });
    tmpDir = '' as any;
  }
}

beforeEach(cleanupTmp);
afterEach(cleanupTmp);

describe('parseMcpResponse', () => {
  it('parses SSE response with data: lines', () => {
    const r = parseMcpResponse(SSE_RESPONSE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.result?.content?.[0]?.text).toContain('agents_count=2');
  });

  it('parses plain JSON response', () => {
    const r = parseMcpResponse(JSON_RESPONSE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.result?.content?.[0]?.text).toContain('agents_count=1');
  });

  it('returns detail on malformed JSON', () => {
    const r = parseMcpResponse('not json at all');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.detail).toMatch(/JSON parse/);
  });
});

describe('normalizeMcpAgents', () => {
  it('strips header and parses agents with correct normalization', () => {
    const parsed = parseMcpResponse(SSE_RESPONSE);
    if (!parsed.ok) throw new Error('parse failed');
    const agents = normalizeMcpAgents(parsed.value);
    expect(agents).toHaveLength(2);
    const a = agents[0];
    expect(a.id).toBe('id-a');
    expect(a.title).toBe('agentdash-paseo: WS-0 foundation');
    expect(a.status).toBe('idle');
    expect(a.archived).toBe(false);
    expect(a.requiresAttention).toBe(true);
    expect(a.attentionReason).toBe('finished');
    expect(a.lastActivityAtMs).toBe(Date.parse('2026-07-18T08:14:47.169Z'));
  });

  it('detects archived agents (archivedAt set)', () => {
    const resp = {
      result: {
        content: [
          {
            type: 'text',
            text:
              'agents_count=1\nagents_ids=x\n\n' +
              JSON.stringify({
                agents: [
                  {
                    id: 'x',
                    title: null,
                    cwd: '/p',
                    status: 'closed',
                    archivedAt: '2026-07-18T00:00:00.000Z',
                    requiresAttention: false,
                    attentionReason: null,
                    updatedAt: '2026-07-18T00:00:00.000Z',
                  },
                ],
              }),
          },
        ],
      },
    };
    const agents = normalizeMcpAgents(resp);
    expect(agents).toHaveLength(1);
    expect(agents[0].archived).toBe(true);
    expect(agents[0].status).toBe('closed');
  });

  it('returns empty when text missing', () => {
    expect(normalizeMcpAgents({})).toEqual([]);
    expect(normalizeMcpAgents({ result: { content: [] } })).toEqual([]);
    expect(normalizeMcpAgents({ result: { content: [{ text: 'no brace here' }] } })).toEqual([]);
  });

  it('skips agents without an id', () => {
    const resp = {
      result: {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ agents: [{ id: 'good' }, { title: 'no id' }] }),
          },
        ],
      },
    };
    const agents = normalizeMcpAgents(resp);
    expect(agents.map((a) => a.id)).toEqual(['good']);
  });
});

describe('McpSource.poll', () => {
  it('sends correct POST and returns normalized agents on SSE success', async () => {
    const token = 'tok-sse-123';
    const dir = await setupAgentsDir(token);
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    const fetchFn = makeFetch(async (url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return { status: 200, body: SSE_RESPONSE };
    });
    const src = new McpSource({ baseUrl: 'http://127.0.0.1:6767/', agentsDir: dir, fetchFn });
    const res = await src.poll();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.agents).toHaveLength(2);
    expect(res.agents[0].id).toBe('id-a');
    expect(capturedUrl).toBe('http://127.0.0.1:6767/mcp/agents');
    expect(capturedInit?.method).toBe('POST');
    const headers = (capturedInit?.headers as Record<string, string>) ?? {};
    expect(headers['Authorization']).toBe(`Bearer ${token}`);
    expect(headers['Accept']).toBe('application/json, text/event-stream');
    const body = JSON.parse(capturedInit?.body as string);
    expect(body).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'list_agents', arguments: {} },
    });
  });

  it('parses plain JSON response (no SSE wrapper)', async () => {
    const token = 'tok-json-456';
    const dir = await setupAgentsDir(token);
    const fetchFn = makeFetch(async () => ({ status: 200, body: JSON_RESPONSE }));
    const src = new McpSource({ baseUrl: 'http://127.0.0.1:6767', agentsDir: dir, fetchFn });
    const res = await src.poll();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.agents).toHaveLength(1);
    expect(res.agents[0].id).toBe('id-c');
    expect(res.agents[0].requiresAttention).toBe(true);
    expect(res.agents[0].attentionReason).toBe('permission');
  });

  it('re-discovers token on 401 then succeeds', async () => {
    // Simulate real token rotation: initially only the stale-token file exists.
    // On the first 401 response, the fetch handler writes a newer file with the
    // fresh token (as the daemon would when rotating), and rediscovery finds it.
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'paseo-mcp-401-'));
    const slug = 'Users-x';
    const sub = path.join(tmpDir, slug);
    await fs.mkdir(sub, { recursive: true });
    const stalePath = path.join(sub, 'old.json');
    const freshPath = path.join(sub, 'new.json');
    await fs.writeFile(stalePath, stateFileContents('stale-token', 'old'));
    const staleTime = new Date(Date.now() - 60_000);
    await fs.utimes(stalePath, staleTime, staleTime);

    let callCount = 0;
    let freshWritten = false;
    const fetchFn = makeFetch(async (_url, init) => {
      callCount++;
      const auth = (init?.headers as Record<string, string>)?.['Authorization'] ?? '';
      if (auth === 'Bearer stale-token') {
        // Simulate token rotation: a newer state file appears with the fresh token.
        if (!freshWritten) {
          await fs.writeFile(freshPath, stateFileContents('fresh-token', 'new'));
          await fs.utimes(freshPath, new Date(), new Date());
          freshWritten = true;
        }
        return { status: 401, body: '{"error":"unauthorized"}' };
      }
      if (auth === 'Bearer fresh-token') return { status: 200, body: SSE_RESPONSE };
      return { status: 500, body: '' };
    });
    const src = new McpSource({ baseUrl: 'http://127.0.0.1:6767', agentsDir: tmpDir, fetchFn });
    const res = await src.poll();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.agents).toHaveLength(2);
    expect(callCount).toBe(2);
  });

  it('returns auth failure when 401 persists after rediscovery', async () => {
    const token = 'tok-bad';
    const dir = await setupAgentsDir(token);
    const fetchFn = makeFetch(async () => ({ status: 401, body: '{"error":"unauthorized"}' }));
    const src = new McpSource({ baseUrl: 'http://127.0.0.1:6767', agentsDir: dir, fetchFn });
    const res = await src.poll();
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('auth');
  });

  it('classifies network refusal + health failure as daemon-down', async () => {
    const token = 'tok-down';
    const dir = await setupAgentsDir(token);
    const fetchFn = makeFetch(async (url) => {
      if (url.endsWith('/api/health')) {
        throw new Error('ECONNREFUSED');
      }
      throw new Error('ECONNREFUSED');
    });
    const src = new McpSource({ baseUrl: 'http://127.0.0.1:6767', agentsDir: dir, fetchFn });
    const res = await src.poll();
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('daemon-down');
  });

  it('classifies as error when MCP fails but health is OK', async () => {
    const token = 'tok-mcperr';
    const dir = await setupAgentsDir(token);
    const fetchFn = makeFetch(async (url) => {
      if (url.endsWith('/api/health')) return { status: 200, body: '{"status":"ok"}' };
      return { status: 500, body: '' };
    });
    const src = new McpSource({ baseUrl: 'http://127.0.0.1:6767', agentsDir: dir, fetchFn });
    const res = await src.poll();
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('error');
  });

  it('classifies daemon-down when no state files exist AND health fails', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'paseo-mcp-empty-'));
    const fetchFn = makeFetch(async (url) => {
      if (url.endsWith('/api/health')) throw new Error('ECONNREFUSED');
      throw new Error('unreached');
    });
    const src = new McpSource({ baseUrl: 'http://127.0.0.1:6767', agentsDir: tmpDir, fetchFn });
    const res = await src.poll();
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('daemon-down');
  });

  it('returns error when no state files exist but daemon is healthy', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'paseo-mcp-empty2-'));
    const fetchFn = makeFetch(async (url) => {
      if (url.endsWith('/api/health')) return { status: 200, body: '{"status":"ok"}' };
      throw new Error('unreached');
    });
    const src = new McpSource({ baseUrl: 'http://127.0.0.1:6767', agentsDir: tmpDir, fetchFn });
    const res = await src.poll();
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('error');
  });
});
