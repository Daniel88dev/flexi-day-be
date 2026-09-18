import { and, asc, eq, gt, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { db } from "../../db/db.js";
import { groups } from "../../db/schema/group-schema.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
import { organizations } from "../../db/schema/organization-schema.js";
import { getScopeEntries } from "../report/reportServices.js";
import type { ReportScopeEntry } from "../report/types.js";
import { encodeSyncCursor, SYNC_OVERLAP_MS } from "./syncCursor.js";
import type { SyncEnvelope, SyncGroupRow, SyncGroupUserRow, SyncOrganizationRow } from "./types.js";

/** The caller's groups split by how much of each they see. */
type SyncScope = {
  fullGroupIds: string[];
  selfGroupIds: string[];
  groupIds: string[];
};

const splitScope = (entries: ReportScopeEntry[]): SyncScope => {
  const fullGroupIds = entries.filter((e) => e.access === "all").map((e) => e.groupId);
  const selfGroupIds = entries.filter((e) => e.access === "self").map((e) => e.groupId);
  return { fullGroupIds, selfGroupIds, groupIds: [...fullGroupIds, ...selfGroupIds] };
};

/** Every membership row of a group seen in full, the caller's own row elsewhere. */
const inMembershipScope = (scope: SyncScope, callerId: string): SQL | undefined =>
  or(
    scope.fullGroupIds.length > 0 ? inArray(groupUsers.groupId, scope.fullGroupIds) : sql`false`,
    scope.selfGroupIds.length > 0
      ? and(inArray(groupUsers.groupId, scope.selfGroupIds), eq(groupUsers.userId, callerId))
      : sql`false`
  );

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

/** The live member list of every group in scope, at the depth the scope allows. */
const getScopedMemberships = async (
  scope: SyncScope,
  callerId: string
): Promise<(typeof groupUsers.$inferSelect)[]> => {
  if (scope.groupIds.length === 0) return [];

  return db
    .select()
    .from(groupUsers)
    .where(and(isNull(groupUsers.deletedAt), inMembershipScope(scope, callerId)))
    .orderBy(asc(groupUsers.updatedAt), asc(groupUsers.id));
};

const getGroupsChangedSince = async (
  groupIds: string[],
  since: Date
): Promise<(typeof groups.$inferSelect)[]> => {
  if (groupIds.length === 0) return [];

  return db
    .select()
    .from(groups)
    .where(and(inArray(groups.id, groupIds), gt(groups.updatedAt, since)))
    .orderBy(asc(groups.updatedAt), asc(groups.id));
};

/** No `deletedAt` filter: a membership soft-deleted since the cursor is the tombstone. */
const getMembershipsChangedSince = async (
  scope: SyncScope,
  callerId: string,
  since: Date
): Promise<(typeof groupUsers.$inferSelect)[]> => {
  if (scope.groupIds.length === 0) return [];

  return db
    .select()
    .from(groupUsers)
    .where(and(gt(groupUsers.updatedAt, since), inMembershipScope(scope, callerId)))
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

/** Every group in scope, changed or not, so a membership can carry its organization. */
const getOrganizationIdByGroupId = async (groupIds: string[]): Promise<Map<string, string>> => {
  if (groupIds.length === 0) return new Map();

  const rows = await db
    .select({ id: groups.id, organizationId: groups.organizationId })
    .from(groups)
    .where(inArray(groups.id, groupIds));

  return new Map(rows.map((row) => [row.id, row.organizationId]));
};

/** The tables this endpoint does not fill yet ship empty, in dependency order. */
const buildEnvelope = (payload: {
  cursorTime: Date;
  reset: boolean;
  organizationRows: SyncOrganizationRow[];
  groupRows: (typeof groups.$inferSelect)[];
  membershipRows: (typeof groupUsers.$inferSelect)[];
  organizationIdByGroupId: Map<string, string>;
}): SyncEnvelope => ({
  cursor: encodeSyncCursor(payload.cursorTime),
  hasMore: false,
  reset: payload.reset,
  organizations: payload.organizationRows,
  users: [],
  groups: payload.groupRows.map(toGroupRow),
  groupUsers: payload.membershipRows.map((row) =>
    toGroupUserRow(row, payload.organizationIdByGroupId.get(row.groupId)!)
  ),
  groupMirrors: [],
  userYearQuotas: [],
  bankHolidays: [],
  vacations: [],
});

/**
 * Everything the caller may see. `cursorTime` is read before the rows are, so
 * a change landing mid-read falls on the next pull's side of the cursor rather
 * than between the two.
 */
export const buildSyncSnapshot = async (
  userId: string,
  cursorTime: Date = new Date()
): Promise<SyncEnvelope> => {
  const scope = splitScope(await getScopeEntries(userId));

  const [groupRows, membershipRows] = await Promise.all([
    getScopedGroups(scope.groupIds),
    getScopedMemberships(scope, userId),
  ]);

  const organizationIdByGroupId = new Map(groupRows.map((row) => [row.id, row.organizationId]));
  const organizationRows = await getOrganizations([...new Set(organizationIdByGroupId.values())]);

  return buildEnvelope({
    cursorTime,
    reset: true,
    organizationRows,
    groupRows,
    membershipRows,
    organizationIdByGroupId,
  });
};

/**
 * What changed since the caller's last pull. `cursorTime` is minted when the
 * pull starts and handed back in the new cursor, so consecutive pulls chain;
 * `previousCursorTime` is the one the client sent, and the rows reach back an
 * overlap window before it.
 *
 * Scope is the snapshot's membership scope, widened to the groups the caller
 * still belongs to that have been soft-deleted, whose tombstone a delta owes
 * the client. It stays keyed on the caller's live membership rows: once their
 * own row goes, the group leaves scope, which is a reset rather than a delta.
 */
export const buildSyncDelta = async (
  userId: string,
  previousCursorTime: Date,
  cursorTime: Date
): Promise<SyncEnvelope> => {
  const since = new Date(previousCursorTime.getTime() - SYNC_OVERLAP_MS);
  const scope = splitScope(await getScopeEntries(userId, { includeDeletedGroups: true }));

  const [groupRows, membershipRows, organizationIdByGroupId] = await Promise.all([
    getGroupsChangedSince(scope.groupIds, since),
    getMembershipsChangedSince(scope, userId, since),
    getOrganizationIdByGroupId(scope.groupIds),
  ]);

  const organizationRows = await getOrganizations([
    ...new Set(groupRows.map((row) => row.organizationId)),
  ]);

  return buildEnvelope({
    cursorTime,
    reset: false,
    organizationRows,
    groupRows,
    membershipRows,
    organizationIdByGroupId,
  });
};
