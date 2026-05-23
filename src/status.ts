import type { WidgetStatus } from './contract';

export interface StatusInput {
  active: boolean;
  thinking: boolean;
  pendingRequestCount: number;
}

/**
 * Map the three coarse signals derived from Happy to the widget status enum.
 * Priority within an active session: permission_required > thinking > waiting.
 * An inactive session is always disconnected.
 */
export function deriveStatus(input: StatusInput): WidgetStatus {
  if (!input.active) return 'disconnected';
  if (input.pendingRequestCount > 0) return 'permission_required';
  if (input.thinking) return 'thinking';
  return 'waiting';
}
