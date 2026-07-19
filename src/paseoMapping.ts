import type { PaseoAgent } from './paseoTypes.js';
import type { WidgetStatus } from './contract.js';

/**
 * Attention reasons that map to `permission_required` regardless of lifecycle status.
 * `permission` is the canonical Paseo value; `needs_input` appears in some bundled code.
 */
const PERMISSION_REASONS = new Set(['permission', 'needs_input']);

/**
 * Lifecycle statuses considered "active working" → `thinking`.
 * `initializing` is included because an agent that is starting up is effectively busy.
 */
const THINKING_STATUSES = new Set(['running', 'initializing']);

/**
 * Lifecycle statuses that map to `disconnected` (terminal or broken),
 * EXCEPT idle which is TTL-gated in the decision table.
 */
const DISCONNECTED_STATUSES = new Set(['closed', 'error']);

/** Label prefix so Paseo rows are visually distinct on the widget. */
const LABEL_PREFIX = '⛵ ';

/** Maximum label length (prefix + name), matching the emitter convention. */
const LABEL_MAX = 40;

/** Module-level set of unknown lifecycle statuses we have already warned about. */
const warnedStatuses = new Set<string>();

/**
 * Map a Paseo agent snapshot to an AgentDash widget status per PLAN.md decision table.
 *
 * Priority order (first match wins):
 *  1. requiresAttention && reason ∈ {permission, needs_input} → permission_required
 *  2. status ∈ {running, initializing} → thinking
 *  3. status = idle && within idleTtl → waiting
 *  4. status = idle past TTL, or status ∈ {closed, error}, or archived → disconnected
 *  5. unknown status string → waiting (with one console.warn per distinct value)
 *
 * The idle TTL is computed as `nowMs - lastActivityAtMs < idleTtlMs`.
 * The boundary is strict-less-than: exactly idleTtlMs old is treated as expired
 * (mirrors `idleTtlMs` semantics — after TTL means after).
 */
export function mapAgent(
  agent: PaseoAgent,
  nowMs: number,
  idleTtlMs: number,
): WidgetStatus {
  // 1. Permission gating wins over everything.
  if (
    agent.requiresAttention &&
    agent.attentionReason !== null &&
    PERMISSION_REASONS.has(agent.attentionReason)
  ) {
    return 'permission_required';
  }

  // 4 (partial). Archived agents are always disconnected, regardless of status.
  if (agent.archived) return 'disconnected';

  // 2. Actively running.
  if (THINKING_STATUSES.has(agent.status)) return 'thinking';

  // 3 & 4 (idle branch). Idle is `waiting` within TTL, `disconnected` past it.
  if (agent.status === 'idle') {
    const ageMs = nowMs - agent.lastActivityAtMs;
    return ageMs < idleTtlMs ? 'waiting' : 'disconnected';
  }

  // 4 (terminal). closed / error.
  if (DISCONNECTED_STATUSES.has(agent.status)) return 'disconnected';

  // 5. Unknown status string — warn once per distinct value, fall back to `waiting`.
  if (!warnedStatuses.has(agent.status)) {
    warnedStatuses.add(agent.status);
    console.warn(
      `[paseo-emitter] unknown Paseo lifecycle status "${agent.status}"; mapping to waiting`,
    );
  }
  return 'waiting';
}

/**
 * Derive the widget row label for an agent: `⛵ ` + (title if set, else basename(cwd)),
 * truncated to 40 chars. Matches the emitter's label convention so rows stay compact.
 */
export function projectLabel(agent: PaseoAgent): string {
  const name =
    agent.title && agent.title.length > 0
      ? agent.title
      : basename(agent.cwd);

  const full = LABEL_PREFIX + name;
  if (full.length <= LABEL_MAX) return full;
  // Truncate, reserving room for an ellipsis so truncation is visible.
  const keep = LABEL_MAX - 1; // 1 char for the ellipsis
  return full.slice(0, keep) + '…';
}

/** Extract the final path segment of a cwd; returns the raw string if it's empty. */
function basename(cwd: string): string {
  if (!cwd) return '';
  // Trim trailing slashes, then take the last segment.
  const trimmed = cwd.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}
