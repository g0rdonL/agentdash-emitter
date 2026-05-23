import { describe, it, expect } from 'vitest';
import { selectMostUrgent } from './selectMostUrgent';
import type { StatusEvent } from './contract';

const ev = (o: Partial<StatusEvent>): StatusEvent => ({
  sessionId: 's', status: 'waiting', projectLabel: 'p', updatedAt: 0, ...o,
});

describe('selectMostUrgent', () => {
  it('returns null for no events', () => {
    expect(selectMostUrgent([])).toBeNull();
  });
  it('returns null when all disconnected', () => {
    expect(selectMostUrgent([ev({ status: 'disconnected' })])).toBeNull();
  });
  it('prefers permission_required over waiting and thinking', () => {
    const r = selectMostUrgent([
      ev({ sessionId: 'w', status: 'waiting' }),
      ev({ sessionId: 't', status: 'thinking' }),
      ev({ sessionId: 'p', status: 'permission_required' }),
    ]);
    expect(r?.sessionId).toBe('p');
    expect(r?.status).toBe('permission_required');
  });
  it('breaks ties by most recent updatedAt', () => {
    const r = selectMostUrgent([
      ev({ sessionId: 'old', updatedAt: 100 }),
      ev({ sessionId: 'new', updatedAt: 200 }),
    ]);
    expect(r?.sessionId).toBe('new');
  });
});
