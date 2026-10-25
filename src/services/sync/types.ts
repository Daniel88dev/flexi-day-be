import type { WireRecordType } from "../vacation/redaction.js";

export type SyncTableName =
  | "organizations"
  | "users"
  | "groups"
  | "groupUsers"
  | "groupMirrors"
  | "userYearQuotas"
  | "bankHolidays"
  | "vacations"
  | "groupEvents"
  | "birthdays";

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

export type SyncCapabilities = {
  acceptsAway: boolean;
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
  sickDayBenefitEnabled: boolean;
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

/**
 * The three calendar years a pull's bank holidays cover. `years` drives the
 * lazy fill, the two days bound the read, and both come from the cursor time.
 */
export type SyncBankHolidayWindow = {
  years: number[];
  /** `YYYY-MM-DD`, 1 January of the previous year. */
  firstDay: string;
  /** `YYYY-MM-DD`, 31 December of the next year. */
  lastDay: string;
};

/** Unpartitioned reference data: no `organizationId`, no `deletedAt`, so no tombstones. */
export type SyncBankHolidayRow = {
  id: string;
  date: string;
  name: string;
  country: string;
  region: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Four columns only: a pull names the people on its rows, it does not carry accounts. */
export type SyncUserRow = {
  id: string;
  name: string;
  image: string | null;
  accountDeleted: boolean;
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
  vacationType: WireRecordType;
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
 * The `group_events` row as stored, repeat columns flat with their database
 * values, plus the group's organization. A tombstone keeps `id`, `groupId`,
 * the dates and the one-off link; title, note, times, the rule and the creator
 * are null and `skippedDates` is empty.
 */
export type SyncGroupEventRow = {
  id: string;
  groupId: string;
  organizationId: string;
  createdByUserId: string | null;
  title: string | null;
  note: string | null;
  startDate: string;
  endDate: string;
  /** `HH:MM`, as the group events API answers it. */
  startTime: string | null;
  endTime: string | null;
  repeatFreq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY" | null;
  repeatInterval: number | null;
  /** 0 = Monday … 6 = Sunday; weekly only. */
  repeatWeekdays: number[] | null;
  repeatMonthlyMode: "DAY" | "NTH_WEEKDAY" | "LAST_WEEKDAY" | null;
  repeatUntil: string | null;
  /** Sorted. */
  skippedDates: string[];
  recurringEventId: string | null;
  originalDate: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * Keyed by its owner: `id` is the `userId`, the table having no id of its own.
 * Unpartitioned, like `users`. A row the caller may no longer see, because its
 * owner stopped sharing it or left the groups that showed it, ships shaped as
 * a tombstone: date and year null, `shared` false, `deletedAt` set.
 */
export type SyncBirthdayRow = {
  id: string;
  userId: string;
  month: number | null;
  day: number | null;
  year: number | null;
  shared: boolean;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * The tables arrive in dependency order so a client can apply a page as it
 * lands. Keys are the Drizzle export names.
 */
export type SyncEnvelope = {
  cursor: string;
  hasMore: boolean;
  reset: boolean;
  first: boolean;
  organizations: SyncOrganizationRow[];
  users: SyncUserRow[];
  groups: SyncGroupRow[];
  groupUsers: SyncGroupUserRow[];
  groupMirrors: SyncGroupMirrorRow[];
  userYearQuotas: SyncUserYearQuotaRow[];
  bankHolidays: SyncBankHolidayRow[];
  vacations: SyncVacationRow[];
  groupEvents: SyncGroupEventRow[];
  birthdays: SyncBirthdayRow[];
};
