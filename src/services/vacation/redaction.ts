import { CalendarRecordType } from "../../db/schema/vacation-schema.js";

/** What a teammate sees in place of `SICK`. Response-only: never stored, never accepted on a write. */
export const AWAY_RECORD_TYPE = "AWAY";

export type WireRecordType = CalendarRecordType | typeof AWAY_RECORD_TYPE;

/**
 * Who is reading. `privilegedGroupIds` holds the groups where the viewer is an
 * approver or a group admin, from `resolvePrivilegedGroupIds`.
 */
export type VacationViewer = {
  userId: string;
  privilegedGroupIds: ReadonlySet<string>;
};

/**
 * A viewer with no privileged groups: everyone else's rows get the teammate
 * view, whatever `userId` may approve or administer. Team calendar feeds read
 * as this, because the feed URL is a bearer link anyone holding it can open.
 */
export const teammateViewer = (userId: string): VacationViewer => ({
  userId,
  privilegedGroupIds: new Set(),
});

type RedactableRow = {
  userId: string;
  groupId: string;
  vacationType: CalendarRecordType;
  rejectedAt: Date | null;
  deletedAt: Date | null;
};

export type VacationRowAsSeen<T extends RedactableRow> = Omit<T, "vacationType"> & {
  vacationType: WireRecordType;
};

const PRIVATE_FIELDS = [
  "note",
  "rejectionReason",
  "rejectedBy",
  "rejectedByUser",
  "deletedByUserId",
  "deletedByUser",
] as const;

export const teammateRecordType = (type: CalendarRecordType): WireRecordType =>
  type === CalendarRecordType.Sick ? AWAY_RECORD_TYPE : type;

export const isPrivilegedReader = (
  viewer: VacationViewer,
  row: Pick<RedactableRow, "userId" | "groupId">
): boolean => row.userId === viewer.userId || viewer.privilegedGroupIds.has(row.groupId);

/**
 * A row's record type as this viewer may see it, for a surface that shows
 * the type and nothing else of the row, such as an excluded attendance day.
 */
export const viewRecordTypeAs = (
  viewer: VacationViewer,
  row: Pick<RedactableRow, "userId" | "groupId" | "vacationType">
): WireRecordType =>
  isPrivilegedReader(viewer, row) ? row.vacationType : teammateRecordType(row.vacationType);

/**
 * The row as this viewer may see it, or null when it must not reach them at
 * all. Standing is read against `row.groupId`, never the group being listed,
 * so a row mirrored into a group gets the teammate view there.
 */
export const viewVacationRowAs = <T extends RedactableRow>(
  viewer: VacationViewer,
  row: T
): VacationRowAsSeen<T> | null => {
  if (isPrivilegedReader(viewer, row)) return row;
  if (row.rejectedAt != null || row.deletedAt != null) return null;

  const cleared = Object.fromEntries(
    PRIVATE_FIELDS.filter((field) => field in row).map((field) => [field, null])
  );
  return {
    ...row,
    ...cleared,
    vacationType: teammateRecordType(row.vacationType),
  };
};

type ReportRow = {
  userId: string;
  groupId: string;
  vacationType: CalendarRecordType;
  rejectedAt?: Date | null;
  note?: string | null;
};

/**
 * The report and export form of {@link viewVacationRowAs}. A teammate's Sick
 * is left out rather than shown as Away, because Away means nothing as a
 * usage line. Takes per-day rows and grouped usage rows alike.
 */
export const viewReportRowAs = <T extends ReportRow>(viewer: VacationViewer, row: T): T | null => {
  if (isPrivilegedReader(viewer, row)) return row;
  if (row.vacationType === CalendarRecordType.Sick || row.rejectedAt != null) return null;
  return "note" in row ? { ...row, note: null } : row;
};
