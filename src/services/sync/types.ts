import type { CalendarRecordType } from "../../db/schema/vacation-schema.js";

export type SyncTableName =
  | "organizations"
  | "users"
  | "groups"
  | "groupUsers"
  | "groupMirrors"
  | "userYearQuotas"
  | "bankHolidays"
  | "vacations";

/** A row's place in its table's `updatedAt, id` order. `updatedAt` is null for a table ordered by id alone. */
export type SyncKeyset = {
  updatedAt: Date | null;
  id: string;
};

/** Where a page stopped. `after` is null for the start of the table. */
export type SyncPagePosition = {
  table: SyncTableName;
  after: SyncKeyset | null;
};

/**
 * What a pull is: a snapshot, which has no earlier cursor, or a delta, which
 * reads from the cursor the client sent. Every page of one loop carries the
 * same answer, so `reset` cannot flip halfway through.
 */
export type SyncLoop =
  { reset: true; previousCursorTime: null } | { reset: false; previousCursorTime: Date };

/** The paging state a cursor carries mid-loop. A cursor without one asks for a fresh pull. */
export type SyncCursorPage = SyncLoop & {
  position: SyncPagePosition;
};

export type SyncCursor = {
  version: number;
  cursorTime: Date;
  page: SyncCursorPage | null;
};

export type SyncPageRow = {
  key: SyncKeyset;
  row: unknown;
};

export type SyncTableReader = {
  table: SyncTableName;
  read: (after: SyncKeyset | null, limit: number) => Promise<SyncPageRow[]>;
};

export type SyncPage = {
  rows: Map<SyncTableName, unknown[]>;
  hasMore: boolean;
  next: SyncPagePosition | null;
};

export type SyncOrganizationRow = {
  id: string;
  name: string;
};

export type SyncGroupRow = {
  id: string;
  organizationId: string;
  groupName: string;
  defaultVacationDays: number;
  defaultHomeOfficeDays: number;
  defaultSickDays: number;
  workingDays: number[];
  holidayCountry: string | null;
  managerUserId: string;
  mainApprovalUser: string | null;
  tempApprovalUser: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SyncGroupUserRow = {
  id: string;
  groupId: string;
  organizationId: string;
  userId: string;
  viewAccess: boolean;
  adminAccess: boolean;
  approverAccess: boolean;
  controlledUser: boolean;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * A mirror the pull carries, with the target group's organization: the row is
 * what lets the client tell a mirrored booking from one of the target group's
 * own.
 */
export type SyncGroupMirrorRow = {
  id: string;
  userId: string;
  sourceGroupId: string;
  targetGroupId: string;
  organizationId: string;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * The far edge of the tables a pull bounds by date rather than by change:
 * vacations by requested day, quotas by related year.
 */
export type SyncHistoryWindow = {
  /** `YYYY-MM-DD`, compared against `vacation.requested_day`. */
  firstDay: string;
  /**
   * `YYYY`, compared as text against `user_year_quotas.related_year`. That
   * sorts as the number only because the column's check constraint pins it to
   * four digits.
   */
  firstYear: string;
};

/** Four columns only: a pull names the people on its rows, it does not carry accounts. */
export type SyncUserRow = {
  id: string;
  name: string;
  image: string | null;
  updatedAt: string;
};

export type SyncUserYearQuotaRow = {
  id: string;
  userId: string;
  groupId: string;
  organizationId: string;
  relatedYear: string;
  vacationDays: number;
  homeOfficeDays: number;
  sickDays: number;
  carriedOverDays: number;
  createdAt: string;
  updatedAt: string;
};

export type SyncVacationRow = {
  id: string;
  userId: string;
  groupId: string;
  organizationId: string;
  requestId: string;
  requestedDay: string;
  startTime: string | null;
  endTime: string | null;
  vacationType: CalendarRecordType;
  halfDay: boolean;
  approvedAt: string | null;
  approvedBy: string | null;
  rejectedAt: string | null;
  rejectedBy: string | null;
  rejectionReason: string | null;
  note: string | null;
  createdByUserId: string | null;
  deletedAt: string | null;
  deletedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * The tables arrive in dependency order so a client can apply a page as it
 * lands. Keys are the Drizzle export names; the one table this endpoint does
 * not fill yet ships as an empty array.
 */
export type SyncEnvelope = {
  cursor: string;
  hasMore: boolean;
  reset: boolean;
  organizations: SyncOrganizationRow[];
  users: SyncUserRow[];
  groups: SyncGroupRow[];
  groupUsers: SyncGroupUserRow[];
  groupMirrors: SyncGroupMirrorRow[];
  userYearQuotas: SyncUserYearQuotaRow[];
  bankHolidays: unknown[];
  vacations: SyncVacationRow[];
};
