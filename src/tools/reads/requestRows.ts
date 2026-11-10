export type RequestStatus = "pending" | "approved" | "rejected" | "cancelled";

type DayRow = {
  requestId: string;
  groupId: string;
  requestedDay: string;
  vacationType: string;
  halfDay: boolean;
  approvedAt: Date | string | null;
  rejectedAt: Date | string | null;
  deletedAt: Date | string | null;
  note?: string | null;
  rejectionReason?: string | null;
  user: { id: string; name: string };
};

export const statusOf = (row: DayRow): RequestStatus =>
  row.deletedAt != null
    ? "cancelled"
    : row.rejectedAt != null
      ? "rejected"
      : row.approvedAt != null
        ? "approved"
        : "pending";

export type RequestSummary = {
  requestId: string;
  groupId: string;
  personId: string;
  personName: string;
  type: string;
  status: RequestStatus;
  firstDay: string;
  lastDay: string;
  days: number;
  note: string | null;
  rejectionReason: string | null;
};

/**
 * Per-day rows folded into one entry per Request and state, oldest first. A
 * Request whose days differ in state (one day cancelled) yields one entry per state.
 */
export const summarizeRequests = (rows: DayRow[]): RequestSummary[] => {
  const byKey = new Map<string, RequestSummary>();
  for (const row of [...rows].sort((a, b) => a.requestedDay.localeCompare(b.requestedDay))) {
    const status = statusOf(row);
    const key = `${row.requestId}:${status}`;
    const weight = row.halfDay ? 0.5 : 1;
    const entry = byKey.get(key);
    if (entry) {
      entry.lastDay = row.requestedDay;
      entry.days += weight;
      continue;
    }
    byKey.set(key, {
      requestId: row.requestId,
      groupId: row.groupId,
      personId: row.user.id,
      personName: row.user.name,
      type: row.vacationType,
      status,
      firstDay: row.requestedDay,
      lastDay: row.requestedDay,
      days: weight,
      note: row.note ?? null,
      rejectionReason: row.rejectionReason ?? null,
    });
  }
  return [...byKey.values()];
};
