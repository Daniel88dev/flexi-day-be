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
 * The tables arrive in dependency order so a client can apply a page as it
 * lands. Keys are the Drizzle export names; the tables this endpoint does not
 * fill yet ship as empty arrays.
 */
export type SyncEnvelope = {
  cursor: string;
  hasMore: boolean;
  reset: boolean;
  organizations: SyncOrganizationRow[];
  users: unknown[];
  groups: SyncGroupRow[];
  groupUsers: SyncGroupUserRow[];
  groupMirrors: unknown[];
  userYearQuotas: unknown[];
  bankHolidays: unknown[];
  vacations: unknown[];
};
