import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "../../db/db.js";
import { groups } from "../../db/schema/group-schema.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
import { organizations } from "../../db/schema/organization-schema.js";
import { getScopeEntries } from "../report/reportServices.js";
import { encodeSyncCursor } from "./syncCursor.js";
import type { SyncEnvelope, SyncGroupRow, SyncGroupUserRow, SyncOrganizationRow } from "./types.js";

const toIso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

const toGroupRow = (row: typeof groups.$inferSelect): SyncGroupRow => ({
  id: row.id,
  organizationId: row.organizationId,
  groupName: row.groupName,
  defaultVacationDays: row.defaultVacationDays,
  defaultHomeOfficeDays: row.defaultHomeOfficeDays,
  defaultSickDays: row.defaultSickDays,
  workingDays: row.workingDays,
  holidayCountry: row.holidayCountry,
  managerUserId: row.managerUserId,
  mainApprovalUser: row.mainApprovalUser,
  tempApprovalUser: row.tempApprovalUser,
  deletedAt: toIso(row.deletedAt),
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

const toGroupUserRow = (
  row: typeof groupUsers.$inferSelect,
  organizationId: string
): SyncGroupUserRow => ({
  id: row.id,
  groupId: row.groupId,
  organizationId,
  userId: row.userId,
  viewAccess: row.viewAccess,
  adminAccess: row.adminAccess,
  approverAccess: row.approverAccess,
  controlledUser: row.controlledUser,
  deletedAt: toIso(row.deletedAt),
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

const getScopedGroups = async (groupIds: string[]): Promise<(typeof groups.$inferSelect)[]> => {
  if (groupIds.length === 0) return [];

  return db
    .select()
    .from(groups)
    .where(inArray(groups.id, groupIds))
    .orderBy(asc(groups.updatedAt), asc(groups.id));
};

/**
 * The live member list of every group the caller sees in full, and their own
 * row in the groups they only see themselves in.
 */
const getScopedMemberships = async (
  fullGroupIds: string[],
  selfGroupIds: string[],
  callerId: string
): Promise<(typeof groupUsers.$inferSelect)[]> => {
  if (fullGroupIds.length === 0 && selfGroupIds.length === 0) return [];

  return db
    .select()
    .from(groupUsers)
    .where(
      and(
        isNull(groupUsers.deletedAt),
        or(
          fullGroupIds.length > 0 ? inArray(groupUsers.groupId, fullGroupIds) : sql`false`,
          selfGroupIds.length > 0
            ? and(inArray(groupUsers.groupId, selfGroupIds), eq(groupUsers.userId, callerId))
            : sql`false`
        )
      )
    )
    .orderBy(asc(groupUsers.updatedAt), asc(groupUsers.id));
};

const getOrganizations = async (organizationIds: string[]): Promise<SyncOrganizationRow[]> => {
  if (organizationIds.length === 0) return [];

  return db
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(inArray(organizations.id, organizationIds))
    .orderBy(asc(organizations.id));
};

/**
 * Everything the caller may see. `cursorTime` is read before the rows are, so
 * a change landing mid-read falls on the next pull's side of the cursor rather
 * than between the two.
 */
export const buildSyncSnapshot = async (
  userId: string,
  cursorTime: Date = new Date()
): Promise<SyncEnvelope> => {
  const scope = await getScopeEntries(userId);
  const fullGroupIds = scope.filter((entry) => entry.access === "all").map((e) => e.groupId);
  const selfGroupIds = scope.filter((entry) => entry.access === "self").map((e) => e.groupId);

  const [groupRows, membershipRows] = await Promise.all([
    getScopedGroups([...fullGroupIds, ...selfGroupIds]),
    getScopedMemberships(fullGroupIds, selfGroupIds, userId),
  ]);

  const organizationIdByGroupId = new Map(groupRows.map((row) => [row.id, row.organizationId]));
  const organizationRows = await getOrganizations([...new Set(organizationIdByGroupId.values())]);

  return {
    cursor: encodeSyncCursor(cursorTime),
    hasMore: false,
    reset: true,
    organizations: organizationRows,
    users: [],
    groups: groupRows.map(toGroupRow),
    groupUsers: membershipRows.map((row) =>
      toGroupUserRow(row, organizationIdByGroupId.get(row.groupId)!)
    ),
    groupMirrors: [],
    userYearQuotas: [],
    bankHolidays: [],
    vacations: [],
  };
};
