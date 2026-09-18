export type SyncCursor = {
  version: number;
  cursorTime: Date;
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
