import { describe, it, expect } from 'vitest';
import { encrypt, encodeBase64, getRandomBytes } from './encryption';
import { decryptAgentState } from './decryptWrapper';

describe('decryptAgentState', () => {
  it('round-trips a dataKey-encrypted agentState (32-byte key)', () => {
    const key = getRandomBytes(32);
    const keyB64 = encodeBase64(key);
    const agentState = { requests: { 'req-1': { tool: 'Bash', arguments: {}, createdAt: 1 } } };
    const cipher = encrypt(key, 'dataKey', agentState);
    const cipherB64 = encodeBase64(cipher);
    expect(decryptAgentState(keyB64, 'dataKey', cipherB64)).toEqual(agentState);
  });
  it('round-trips a legacy-encrypted agentState (32-byte secret)', () => {
    const key = getRandomBytes(32);
    const keyB64 = encodeBase64(key);
    const agentState = { requests: {} };
    const cipher = encrypt(key, 'legacy', agentState);
    expect(decryptAgentState(keyB64, 'legacy', encodeBase64(cipher))).toEqual(agentState);
  });
  it('returns null on a corrupt blob', () => {
    const key = getRandomBytes(32);
    expect(decryptAgentState(encodeBase64(key), 'dataKey', encodeBase64(getRandomBytes(40)))).toBeNull();
  });
});
