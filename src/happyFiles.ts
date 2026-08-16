import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import process from "node:process";

// ── Credentials (subset we need: the bearer token + which decrypt variant) ──
const credentialsSchema = z.object({
  token: z.string(),
  secret: z.string().optional(),
  encryption: z
    .object({ publicKey: z.string(), machineKey: z.string() })
    .optional(),
});

export interface ParsedCredentials {
  token: string;
  encryptionVariant: 'legacy' | 'dataKey';
}

export function parseCredentials(contents: string): ParsedCredentials {
  const raw = credentialsSchema.parse(JSON.parse(contents));
  if (raw.secret) return { token: raw.token, encryptionVariant: 'legacy' };
  if (raw.encryption) return { token: raw.token, encryptionVariant: 'dataKey' };
  throw new Error('access.key has neither legacy secret nor dataKey encryption');
}

// ── Persisted sessions (plaintext metadata + per-session key/variant) ──
const persistedSessionsSchema = z.object({
  sessions: z
    .record(
      z.string(),
      z.object({
        encryptionKey: z.string(),
        encryptionVariant: z.enum(['legacy', 'dataKey']),
        metadata: z.object({ path: z.string() }).passthrough(),
      }).passthrough(),
    )
    .optional(),
});

export interface PersistedSessionInfo {
  sessionId: string;
  encryptionKey: string;
  encryptionVariant: 'legacy' | 'dataKey';
  projectLabel: string;
}

export function projectLabel(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  if (!trimmed) return 'unknown';
  const seg = trimmed.split('/').pop();
  return seg && seg.length > 0 ? seg : 'unknown';
}

export function parsePersistedSessions(contents: string): PersistedSessionInfo[] {
  const raw = persistedSessionsSchema.parse(JSON.parse(contents));
  const sessions = raw.sessions ?? {};
  return Object.entries(sessions).map(([sessionId, s]) => ({
    sessionId,
    encryptionKey: s.encryptionKey,
    encryptionVariant: s.encryptionVariant,
    projectLabel: projectLabel(s.metadata.path),
  }));
}

// ── Convenience loaders (read the real files) ──
export function happyHomeDir(): string {
  return process.env.HAPPY_HOME_DIR ?? join(homedir(), '.happy');
}

export function loadCredentials(home = happyHomeDir()): ParsedCredentials {
  return parseCredentials(readFileSync(join(home, 'access.key'), 'utf8'));
}

export function loadPersistedSessions(home = happyHomeDir()): PersistedSessionInfo[] {
  return parsePersistedSessions(readFileSync(join(home, 'sessions.json'), 'utf8'));
}
