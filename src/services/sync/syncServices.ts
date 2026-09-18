import { and, asc, eq, gt, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { db } from "../../db/db.js";
import { groups } from "../../db/schema/group-schema.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
import { organizations } from "../../db/schema/organization-schema.js";
import { getScopeEntries } from "../report/reportServices.js";
import type { ReportScopeEntry } from "../report/types.js";
import { encodeSyncCursor, SYNC_OVERLAP_MS } from "./syncCursor.js";
import { collectSyncPage } from "./syncPage.js";
import type {
  SyncCursor,
  SyncEnvelope,
  SyncGroupRow,
  SyncGroupUserRow,
  SyncKeyset,
  SyncLoop,
  SyncOrganizationRow,
  SyncPage,
  SyncPagePosition,
  SyncTableName,
  SyncTableReader,
} from "./types.js";

/** The caller's groups split by how much of each they see. */
type SyncScope = {
  fullGroupIds: string[];
  selfGroupIds: string[];
  groupIds: string[];
};

/**
 * The slice of `updatedAt` one pull covers. `until` is the cursor time, so a
 * row that changes mid-loop leaves the window rather than being chased into a
 * later page; the next delta re-covers it, because the cursor time does not
 * advance inside the loop.
 */
type SyncWindow = {
  since: Date | null;
  until: Date;
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

const inWindow = (updatedAt: PgColumn, window: SyncWindow): SQL | undefined =>
  and(
    window.since === null ? undefined : gt(updatedAt, window.since),
    lte(updatedAt, window.until)
  );

/** The predicate that resumes a table ordered by id alone where the last page stopped. */
const afterId = (id: PgColumn, after: SyncKeyset | null): SQL | undefined =>
  after === null ? undefined : gt(id, after.id);

/** The same, for a table ordered by `updatedAt, id`. */
const afterKeyset = (
  updatedAt: PgColumn,
  id: PgColumn,
  after: SyncKeyset | null
): SQL | undefined => {
  if (after === null || after.updatedAt === null) return afterId(id, after);
  return or(gt(updatedAt, after.updatedAt), and(eq(updatedAt, after.updatedAt), gt(id, after.id)));
};

const memoize = <T>(load: () => Promise<T>): (() => Promise<T>) => {
  let pending: Promise<T> | undefined;
  return () => (pending ??= load());
};

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

/** The organizations of every group this pull covers, so a page can name the owner of its rows. */
const getScopedOrganizationIds = async (
  groupIds: string[],
  window: SyncWindow
): Promise<string[]> => {
  if (groupIds.length === 0) return [];

  const rows = await db
    .selectDistinct({ organizationId: groups.organizationId })
    .from(groups)
    .where(and(inArray(groups.id, groupIds), inWindow(groups.updatedAt, window)));

  return rows.map((row) => row.organizationId);
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

/** Ordered by id alone: an organization row carries no `updatedAt` of its own. */
const readOrganizationsPage = async (
  organizationIds: string[],
  after: SyncKeyset | null,
  limit: number
) => {
  if (organizationIds.length === 0) return [];

  const rows = await db
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(and(inArray(organizations.id, organizationIds), afterId(organizations.id, after)))
    .orderBy(asc(organizations.id))
    .limit(limit);

  return rows.map((row) => ({ key: { updatedAt: null, id: row.id }, row }));
};

const readGroupsPage = async (
  groupIds: string[],
  window: SyncWindow,
  after: SyncKeyset | null,
  limit: number
) => {
  if (groupIds.length === 0) return [];

  const rows = await db
    .select()
    .from(groups)
    .where(
      and(
        inArray(groups.id, groupIds),
        inWindow(groups.updatedAt, window),
        afterKeyset(groups.updatedAt, groups.id, after)
      )
    )
    .orderBy(asc(groups.updatedAt), asc(groups.id))
    .limit(limit);

  return rows.map((row) => ({
    key: { updatedAt: row.updatedAt, id: row.id },
    row: toGroupRow(row),
  }));
};

/** What every reader of one pull shares: whose rows, which window, and how deep. */
type SyncReadContext = {
  scope: SyncScope;
  callerId: string;
  window: SyncWindow;
  /** A snapshot holds live membership rows only; a delta keeps the tombstones. */
  liveOnly: boolean;
};

const readMembershipsPage = async (
  context: SyncReadContext,
  organizationIdByGroupId: Map<string, string>,
  after: SyncKeyset | null,
  limit: number
) => {
  if (context.scope.groupIds.length === 0) return [];

  const rows = await db
    .select()
    .from(groupUsers)
    .where(
      and(
        context.liveOnly ? isNull(groupUsers.deletedAt) : undefined,
        inMembershipScope(context.scope, context.callerId),
        inWindow(groupUsers.updatedAt, context.window),
        afterKeyset(groupUsers.updatedAt, groupUsers.id, after)
      )
    )
    .orderBy(asc(groupUsers.updatedAt), asc(groupUsers.id))
    .limit(limit);

  return rows.map((row) => ({
    key: { updatedAt: row.updatedAt, id: row.id },
    row: toGroupUserRow(row, organizationIdByGroupId.get(row.groupId)!),
  }));
};

/**
 * One reader per table the endpoint fills, in dependency order. The tables
 * still to come have no reader yet and ship empty; adding one here is all the
 * paging walk needs to start splitting it.
 */
const buildReaders = (context: SyncReadContext): SyncTableReader[] => {
  const organizationIds = memoize(() =>
    getScopedOrganizationIds(context.scope.groupIds, context.window)
  );
  const organizationIdByGroupId = memoize(() => getOrganizationIdByGroupId(context.scope.groupIds));

  return [
    {
      table: "organizations",
      read: async (after, limit) => readOrganizationsPage(await organizationIds(), after, limit),
    },
    {
      table: "groups",
      read: (after, limit) => readGroupsPage(context.scope.groupIds, context.window, after, limit),
    },
    {
      table: "groupUsers",
      read: async (after, limit) =>
        readMembershipsPage(context, await organizationIdByGroupId(), after, limit),
    },
  ];
};

const rowsOf = <Row>(page: SyncPage, table: SyncTableName): Row[] =>
  (page.rows.get(table) ?? []) as Row[];

/**
 * The one place `cursor` and `hasMore` are set. A page that stopped mid-pull
 * hands back a cursor carrying where it stopped and whether the loop is a
 * snapshot; the last page of a loop hands back the bare cursor time, which is
 * the position the next pull starts from.
 */
const buildEnvelope = (payload: {
  cursorTime: Date;
  loop: SyncLoop;
  page: SyncPage;
}): SyncEnvelope => ({
  cursor: encodeSyncCursor(
    payload.cursorTime,
    payload.page.next === null ? null : { ...payload.loop, position: payload.page.next }
  ),
  hasMore: payload.page.hasMore,
  reset: payload.loop.reset,
  organizations: rowsOf<SyncOrganizationRow>(payload.page, "organizations"),
  users: rowsOf(payload.page, "users"),
  groups: rowsOf<SyncGroupRow>(payload.page, "groups"),
  groupUsers: rowsOf<SyncGroupUserRow>(payload.page, "groupUsers"),
  groupMirrors: rowsOf(payload.page, "groupMirrors"),
  userYearQuotas: rowsOf(payload.page, "userYearQuotas"),
  bankHolidays: rowsOf(payload.page, "bankHolidays"),
  vacations: rowsOf(payload.page, "vacations"),
});

/**
 * Everything the caller may see, one page at a time. `cursorTime` is read
 * before the rows are, so a change landing mid-read falls on the next pull's
 * side of the cursor rather than between the two, and `resume` continues a
 * snapshot that did not fit in one page — the same cursor time throughout.
 */
const buildSyncSnapshot = async (
  userId: string,
  cursorTime: Date = new Date(),
  resume: SyncPagePosition | null = null
): Promise<SyncEnvelope> => {
  const scope = splitScope(await getScopeEntries(userId));

  const page = await collectSyncPage(
    buildReaders({
      scope,
      callerId: userId,
      window: { since: null, until: cursorTime },
      liveOnly: true,
    }),
    resume
  );

  return buildEnvelope({
    cursorTime,
    loop: { reset: true, previousCursorTime: null },
    page,
  });
};

/**
 * What changed since the caller's last pull. `cursorTime` is minted when the
 * pull starts and handed back in the new cursor, so consecutive pulls chain;
 * `previousCursorTime` is the one the client sent, and the rows reach back an
 * overlap window before it. Both are carried unchanged through a paged loop,
 * so every page of the loop reads the same window.
 *
 * Scope is the snapshot's membership scope, widened to the groups the caller
 * still belongs to that have been soft-deleted, whose tombstone a delta owes
 * the client. It stays keyed on the caller's live membership rows: once their
 * own row goes, the group leaves scope, which is a reset rather than a delta.
 */
const buildSyncDelta = async (
  userId: string,
  previousCursorTime: Date,
  cursorTime: Date,
  resume: SyncPagePosition | null = null
): Promise<SyncEnvelope> => {
  const since = new Date(previousCursorTime.getTime() - SYNC_OVERLAP_MS);
  const scope = splitScope(await getScopeEntries(userId, { includeDeletedGroups: true }));

  const page = await collectSyncPage(
    buildReaders({
      scope,
      callerId: userId,
      window: { since, until: cursorTime },
      liveOnly: false,
    }),
    resume
  );

  return buildEnvelope({
    cursorTime,
    loop: { reset: false, previousCursorTime },
    page,
  });
};

/**
 * Which pull a request is. A cursor carrying page state continues the loop it
 * belongs to, reusing the cursor time it was minted with, so the window does
 * not move under the client and `reset` answers the same on every page of that
 * loop. A cursor the server could not read is a snapshot, like no cursor.
 */
export const buildSyncPull = (
  userId: string,
  cursor: SyncCursor | null,
  cursorTime: Date
): Promise<SyncEnvelope> => {
  if (cursor === null) return buildSyncSnapshot(userId, cursorTime);

  const page = cursor.page;
  if (page === null) return buildSyncDelta(userId, cursor.cursorTime, cursorTime);

  return page.reset
    ? buildSyncSnapshot(userId, cursor.cursorTime, page.position)
    : buildSyncDelta(userId, page.previousCursorTime, cursor.cursorTime, page.position);
};
