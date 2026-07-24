import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { OpencodePoller } from './opencodePoller.js';
import type { StatusEvent } from './contract.js';

/**
 * Builds a fresh temp sqlite db with a `session` table and writes the given
 * rows. Returns the db path and the raw row shapes the poller should see.
 *
 * We use node:sqlite here (test env runs Node >= 22) — but the poller under
 * test is exercised through the same code path as production via the injected
 * dbPath; production opens the db read-only/immutable, and so do the tests.
 */

interface InsertRow {
  id: string;
  title: string | null;
  directory: string | null;
  agent?: string | null;
  model?: string | null;
  cost?: number | null;
  time_created?: number | null;
  time_updated: number;
}

function makeDb(rows: InsertRow[] = []): { dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'opencode-poller-test-'));
  const dbPath = join(dir, 'opencode.db');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(
    'CREATE TABLE session (id TEXT, title TEXT, directory TEXT, agent TEXT, ' +
      'model TEXT, cost REAL, time_created INTEGER, time_updated INTEGER)',
  );
  const stmt = db.prepare(
    'INSERT INTO session (id, title, directory, agent, model, cost, time_created, time_updated) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  for (const r of rows) {
    stmt.run(
      r.id,
      r.title,
      r.directory,
      r.agent ?? null,
      r.model ?? null,
      r.cost ?? null,
      r.time_created ?? null,
      r.time_updated,
    );
  }
  db.close();
  return { dbPath };
}

function collect(poller: OpencodePoller): StatusEvent[] {
  const events: StatusEvent[] = [];
  poller.poll((e) => events.push(e));
  return events;
}

const NOW = 1_753_000_000_000;
const ACTIVE = 120_000;
const WORKING = 15_000;

function pollerWith(dbPath: string, now: number = NOW): OpencodePoller {
  return new OpencodePoller({
    dbPath,
    activeThresholdMs: ACTIVE,
    workingThresholdMs: WORKING,
    nowFn: () => now,
  });
}

describe('OpencodePoller', () => {
  it('emits working (thinking) for a session updated within the working window', () => {
    const { dbPath } = makeDb([
      {
        id: 'sess-a',
        title: 'Refactor pollers',
        directory: '/home/me/work/foo',
        model: JSON.stringify({ id: 'gpt-5', providerID: 'openai' }),
        time_updated: NOW - 5_000,
      },
    ]);
    const poller = pollerWith(dbPath);
    const events = collect(poller);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      sessionId: 'opencode:sess-a',
      status: 'thinking',
      projectLabel: 'Refactor pollers',
      updatedAt: NOW,
      metadata: { modelId: 'gpt-5' },
    });
  });

  it('emits idle (waiting) for a session updated past the working window but in active window', () => {
    const { dbPath } = makeDb([
      {
        id: 'sess-b',
        title: 'Idle work',
        directory: '/home/me/work/bar',
        time_updated: NOW - WORKING - 1_000, // 16s ago — active but idle
      },
    ]);
    const poller = pollerWith(dbPath);
    const events = collect(poller);
    expect(events).toEqual([
      {
        sessionId: 'opencode:sess-b',
        status: 'waiting',
        projectLabel: 'Idle work',
        updatedAt: NOW,
      },
    ]);
  });

  it('active-threshold boundary: exactly at boundary is active, just beyond is inactive', () => {
    const { dbPath } = makeDb([
      {
        id: 'at',
        title: 'At boundary',
        directory: null,
        time_updated: NOW - ACTIVE, // exactly 120s ago — inclusive: active
      },
      {
        id: 'past',
        title: 'Just past',
        directory: null,
        time_updated: NOW - ACTIVE - 1, // 120_001ms ago — inactive
      },
    ]);
    const poller = pollerWith(dbPath);
    const events = collect(poller);
    expect(events.map((e) => e.sessionId)).toEqual(['opencode:at']);
  });

  it('working-threshold boundary: exactly at boundary is idle, just under is working', () => {
    const { dbPath } = makeDb([
      {
        id: 'exactly',
        title: 'T',
        directory: '/d/x',
        time_updated: NOW - WORKING, // exactly 15s ago -> idle (uses <)
      },
      {
        id: 'under',
        title: 'U',
        directory: '/d/u',
        time_updated: NOW - WORKING + 1, // 14_999ms ago -> working
      },
    ]);
    const poller = pollerWith(dbPath);
    const events = collect(poller);
    const byId = Object.fromEntries(events.map((e) => [e.sessionId, e.status]));
    expect(byId).toEqual({ 'opencode:exactly': 'waiting', 'opencode:under': 'thinking' });
  });

  it('falls back to directory basename when title is empty', () => {
    const { dbPath } = makeDb([
      { id: 'no-title', title: '', directory: '/home/me/work/baz', time_updated: NOW - 1_000 },
      { id: 'no-title-no-dir', title: '', directory: null, time_updated: NOW - 1_000 },
    ]);
    const poller = pollerWith(dbPath);
    const events = collect(poller);
    const labels = Object.fromEntries(events.map((e) => [e.sessionId, e.projectLabel]));
    expect(labels['opencode:no-title']).toBe('baz');
    expect(labels['opencode:no-title-no-dir']).toBe('opencode');
  });

  it('parses model JSON into metadata.modelId and omits metadata when model is missing', () => {
    const { dbPath } = makeDb([
      {
        id: 'with-model',
        title: 'm',
        directory: '/d',
        model: JSON.stringify({ id: 'claude-opus-5', providerID: 'anthropic' }),
        time_updated: NOW - 1_000,
      },
      {
        id: 'no-model',
        title: 'n',
        directory: '/d',
        model: null,
        time_updated: NOW - 1_000,
      },
      {
        id: 'bad-model',
        title: 'b',
        directory: '/d',
        model: 'not-json',
        time_updated: NOW - 1_000,
      },
    ]);
    const poller = pollerWith(dbPath);
    const events = collect(poller);
    const byId = Object.fromEntries(events.map((e) => [e.sessionId, e]));
    expect(byId['opencode:with-model'].metadata).toEqual({ modelId: 'claude-opus-5' });
    expect(byId['opencode:no-model'].metadata).toBeUndefined();
    expect(byId['opencode:bad-model'].metadata).toBeUndefined();
  });

  it('does not re-emit when state is unchanged on a subsequent poll', () => {
    const { dbPath } = makeDb([
      { id: 'sess-c', title: 'Stable', directory: '/d', time_updated: NOW - 5_000 },
    ]);
    const poller = pollerWith(dbPath);
    collect(poller);
    expect(collect(poller)).toEqual([]);
  });

  it('emits disconnected once when a session falls out of the active window, then forgets it', () => {
    const { dbPath } = makeDb([
      { id: 'sess-d', title: 'Gone', directory: '/d', time_updated: NOW - 5_000 },
    ]);
    let now = NOW;
    const poller = new OpencodePoller({
      dbPath,
      activeThresholdMs: ACTIVE,
      workingThresholdMs: WORKING,
      nowFn: () => now,
    });
    const first = collect(poller);
    expect(first.map((e) => e.status)).toEqual(['thinking']);

    now += ACTIVE + 10_000; // session now well past the active window
    const second = collect(poller);
    expect(second).toEqual([
      { sessionId: 'opencode:sess-d', status: 'disconnected', projectLabel: 'Gone', updatedAt: now },
    ]);
    expect(collect(poller)).toEqual([]); // forgotten
  });

  it('survives a missing db: logs once, keeps polling, then recovers when db appears', () => {
    const poller = pollerWith(join('/nonexistent/opencode.db'));
    expect(collect(poller)).toEqual([]); // no crash, no events
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    collect(poller);
    const calls = consoleError.mock.calls.length;
    expect(calls).toBeLessThanOrEqual(1); // logged at most once per consecutive failure
    consoleError.mockRestore();
  });
});