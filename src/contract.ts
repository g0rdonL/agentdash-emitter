import { z } from 'zod';

export const WIDGET_STATUSES = ['permission_required', 'waiting', 'thinking', 'disconnected'] as const;
export type WidgetStatus = (typeof WIDGET_STATUSES)[number];

// The "active" statuses a session can present (disconnected => never selected).
export type ActiveStatus = 'permission_required' | 'waiting' | 'thinking';

export const StatusEventSchema = z.object({
  sessionId: z.string().min(1),
  status: z.enum(WIDGET_STATUSES),
  projectLabel: z.string().min(1),
  updatedAt: z.number().int().nonnegative(),
});
export type StatusEvent = z.infer<typeof StatusEventSchema>;
