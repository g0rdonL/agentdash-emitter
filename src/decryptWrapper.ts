import { decrypt, decodeBase64 } from './encryption';

export interface AgentRequests {
  requests?: Record<string, { tool: string; arguments: unknown; createdAt: number }>;
  [key: string]: unknown;
}

/**
 * Decrypt a base64 agentState blob with a base64 session key.
 * Returns the decrypted object, or null if decryption fails.
 * The key/variant come from sessions.json (PersistedSessionInfo).
 */
export function decryptAgentState(
  keyBase64: string,
  variant: 'legacy' | 'dataKey',
  blobBase64: string,
): AgentRequests | null {
  const key = decodeBase64(keyBase64);
  return decrypt(key, variant, decodeBase64(blobBase64)) as AgentRequests | null;
}

/** Count of pending permission requests in a (possibly null) decrypted agentState. */
export function pendingRequestCount(agentState: AgentRequests | null): number {
  if (!agentState || !agentState.requests) return 0;
  return Object.keys(agentState.requests).length;
}
