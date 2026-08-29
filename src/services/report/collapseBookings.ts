import type { CalendarRecordType } from "../../db/schema/vacation-schema.js";
import type { ReportBooking } from "./types.js";

export type BookingRow = {
  userId: string;
  userName: string;
  groupId: string;
  groupName: string;
  vacationType: CalendarRecordType;
  requestedDay: string;
  halfDay: boolean;
  approvedAt: Date | null;
  rejectedAt: Date | null;
  note: string | null;
};

const addOneDay = (iso: string): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

const statusOf = (row: BookingRow): ReportBooking["status"] => {
  if (row.approvedAt) return "approved";
  if (row.rejectedAt) return "rejected";
  return "pending";
};

/**
 * Collapses contiguous per-day rows into one booking per (user, group, type,
 * status) run, so the report shows "12–16 Mar, 5 days" instead of five rows.
 *
 * Input must be ordered by (userId, groupId, vacationType, requestedDay) —
 * `getBookingsForScope` selects in exactly that order. Status is part of the
 * run key: a pending day sitting next to an approved one is a different
 * booking as far as the reader is concerned.
 *
 * `days` is weighted by `halfDay`, matching how quota usage is counted
 * everywhere else.
 */
export const collapseBookings = (rows: BookingRow[]): ReportBooking[] => {
  const result: ReportBooking[] = [];

  for (const row of rows) {
    const status = statusOf(row);
    const weight = row.halfDay ? 0.5 : 1;
    const last = result[result.length - 1];

    if (
      last &&
      last.userId === row.userId &&
      last.groupId === row.groupId &&
      last.vacationType === row.vacationType &&
      last.status === status &&
      addOneDay(last.to) === row.requestedDay
    ) {
      last.to = row.requestedDay;
      last.days += weight;
      if (!last.note && row.note) last.note = row.note;
      continue;
    }

    result.push({
      userId: row.userId,
      userName: row.userName,
      groupId: row.groupId,
      groupName: row.groupName,
      vacationType: row.vacationType,
      from: row.requestedDay,
      to: row.requestedDay,
      days: weight,
      year: Number(row.requestedDay.slice(0, 4)),
      month: Number(row.requestedDay.slice(5, 7)),
      status,
      note: row.note,
    });
  }

  return result;
};
