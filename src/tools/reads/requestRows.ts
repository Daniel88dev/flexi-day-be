import { z } from "zod";

const DAY_MS = 24 * 60 * 60 * 1000;

export const isoDay = z.iso.date();

type DayRange = { from: string; to: string };

const ordered = (value: unknown) => (value as DayRange).to >= (value as DayRange).from;

const spanDays = (value: unknown) =>
  (Date.parse((value as DayRange).to) - Date.parse((value as DayRange).from)) / DAY_MS + 1;

// Compare the days only once both parsed, so a bad `from` is not reported against `to` too.
const valid = ({ issues }: { issues: unknown[] }) => issues.length === 0;

/** An input with inclusive `from` and `to` days at most `maxDays` days long, plus `shape`. */
export const withDayRange = <Shape extends z.ZodRawShape>(maxDays: number, shape: Shape) =>
  z
    .object({
      from: isoDay.describe("First day, inclusive, as YYYY-MM-DD."),
      to: isoDay.describe(
        `Last day, inclusive, as YYYY-MM-DD. The range covers at most ${maxDays.toString()} days.`
      ),
      ...shape,
    })
    .refine(ordered, { path: ["to"], when: valid })
    .refine((value) => spanDays(value) <= maxDays, { path: ["to"], when: valid });

/** The half-open range the request services take. */
export const toHalfOpen = ({ from, to }: { from: string; to: string }) => ({
  startDate: from,
  endDate: new Date(Date.parse(`${to}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10),
});

export const PAGE_SIZE = 50;

export const cursorField = z
  .string()
  .regex(/^\d{1,6}$/)
  .optional()
  .describe("The `nextCursor` of the previous page. Leave out for the first page.");

/** One page of `items` and the cursor of the next, `null` on the last page. */
export const page = <T>(items: T[], cursor: string | undefined) => {
  const start = cursor ? Number(cursor) : 0;
  const end = start + PAGE_SIZE;
  return {
    items: items.slice(start, end),
    nextCursor: end < items.length ? end.toString() : null,
  };
};

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
