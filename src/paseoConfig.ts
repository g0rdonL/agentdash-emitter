import type { AdapterConfig } from './paseoTypes.js';
import process from "node:process";

const DEFAULT_PASEO_BASE_URL = 'http://127.0.0.1:6767';
const DEFAULT_POLL_INTERVAL_SEC = 5;
const DEFAULT_IDLE_TTL_MIN = 30;
const DEFAULT_HEALTH_FAILURES_MAX = 3;

/**
 * Expand a leading `~` to the user's home directory.
 * Leaves non-`~` paths untouched. Handles `~/x`, `~`, and `~user/...` (the last
 * treated as a plain `~` expansion — we don't resolve other users' homes).
 */
export function expandTilde(path: string): string {
  if (path === '~') return process.env.HOME ?? process.cwd();
  if (path.startsWith('~/')) return `${process.env.HOME ?? ''}${path.slice(1)}`;
  // `~user/...` — not commonly needed here; leave as-is rather than guessing.
  return path;
}

function parsePositiveInt(raw: string | undefined, fieldName: string): number {
  if (raw === undefined || raw === '') {
    throw new Error(`${fieldName} must be set to a positive integer`);
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new Error(`${fieldName} must be a positive integer (got: ${raw})`);
  }
  return n;
}

function parseNonNegativeInt(raw: string | undefined, fieldName: string): number {
  if (raw === undefined || raw === '') {
    throw new Error(`${fieldName} must be set to a non-negative integer`);
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new Error(`${fieldName} must be a non-negative integer (got: ${raw})`);
  }
  return n;
}

/**
 * Load Paseo adapter configuration from environment variables.
 *
 * Env-file loading: callers should ensure `.env` is loaded before invoking this
 * (e.g. via `process.loadEnvFile('.env')` in `src/index.ts`). However, we also
 * attempt `process.loadEnvFile('.env')` here in a try/catch as a zero-dep
 * convenience (Node ≥20.12) so that imported `loadConfig` "just works" in tests
 * and scripts without a separate load step. Failures (file missing, etc.) are
 * silently ignored — env vars already set take precedence anyway.
 *
 * All env vars have sensible defaults — no required vars.
 * BACKEND_URL and ACCOUNT_TOKEN (used by the shared BackendSender) are validated
 * by the emitter's entry point, not here.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): AdapterConfig {
  // Best-effort .env load. Node ≥20.12 exposes process.loadEnvFile.
  if (env === process.env && typeof (process as { loadEnvFile?: (f?: string) => void }).loadEnvFile === 'function') {
    try {
      (process as { loadEnvFile: (f?: string) => void }).loadEnvFile('.env');
    } catch {
      // .env missing or unparsable — proceed with whatever env is set.
    }
  }

  const paseoBaseUrl = (env.PASEO_BASE_URL?.trim() || DEFAULT_PASEO_BASE_URL).replace(/\/+$/, '');
  const paseoAgentsDir = expandTilde(env.PASEO_AGENTS_DIR?.trim() || '~/.paseo/agents');

  const pollIntervalSec = parsePositiveInt(env.POLL_INTERVAL_SEC ?? String(DEFAULT_POLL_INTERVAL_SEC), 'POLL_INTERVAL_SEC');
  const idleTtlMin = parsePositiveInt(env.IDLE_TTL_MIN ?? String(DEFAULT_IDLE_TTL_MIN), 'IDLE_TTL_MIN');
  const healthFailuresMax = parseNonNegativeInt(env.HEALTH_FAILURES_MAX ?? String(DEFAULT_HEALTH_FAILURES_MAX), 'HEALTH_FAILURES_MAX');

  return {
    paseoBaseUrl,
    paseoAgentsDir,
    pollIntervalMs: pollIntervalSec * 1000,
    idleTtlMs: idleTtlMin * 60_000,
    healthFailuresMax,
  };
}
