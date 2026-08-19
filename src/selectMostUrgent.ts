import type { ActiveStatus, StatusEvent } from "./contract";

const RANK: Record<ActiveStatus, number> = {
  permission_required: 3,
  waiting: 2,
  thinking: 1,
};

export function selectMostUrgent(events: StatusEvent[]): StatusEvent | null {
  let best: StatusEvent | null = null;
  let bestRank = 0;
  for (const e of events) {
    if (e.status === "disconnected") continue;
    const rank = RANK[e.status as ActiveStatus];
    if (
      !best || rank > bestRank ||
      (rank === bestRank && e.updatedAt > best.updatedAt)
    ) {
      best = e;
      bestRank = rank;
    }
  }
  return best;
}
