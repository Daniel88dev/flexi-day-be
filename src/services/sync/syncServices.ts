import {
  and,
  asc,
  eq,
  exists,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { db } from "../../db/db.js";
import { user } from "../../db/schema/auth-schema.js";
import { bankHolidays } from "../../db/schema/bank-holiday-schema.js";
import { groupMirrors } from "../../db/schema/group-mirror-schema.js";
import { groups } from "../../db/schema/group-schema.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
import { organizations } from "../../db/schema/organization-schema.js";
import { userYearQuotas } from "../../db/schema/user-year-quotas-schema.js";
import { vacation } from "../../db/schema/vacation-schema.js";
import { ensureBankHolidays } from "../bankHoliday/bankHolidayServices.js";
import { getScopeEntries } from "../report/reportServices.js";
import type { ReportScopeEntry } from "../report/types.js";
import { encodeSyncCursor, SYNC_OVERLAP_MS } from "./syncCursor.js";
import { sameHistoryWindow, syncBankHolidayWindow, syncHistoryWindow } from "./syncHistory.js";
import { collectSyncPage } from "./syncPage.js";
import type {
  SyncBankHolidayRow,
  SyncBankHolidayWindow,
  SyncCursor,
  SyncEnvelope,
  SyncGroupMirrorRow,
  SyncGroupRow,
  SyncGroupUserRow,
  SyncHistoryWindow,
  SyncKeyset,
  SyncLoop,
  SyncOrganizationRow,
  SyncPage,
  SyncPagePosition,
  SyncTableName,
  SyncTableReader,
  SyncUserRow,
  SyncUserYearQuotaRow,
  SyncVacationRow,
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

/**
 * Every row of a group the caller sees in full, their own rows elsewhere, over
 * any table keyed by (userId, groupId). The `false` branches keep the
 * predicate defined when one half of the scope is empty — dropping them would
 * leave `or()` undefined and widen the `WHERE` to the whole table.
 */
const inGroupScope = (
  scope: SyncScope,
  callerId: string,
  columns: { userId: PgColumn; groupId: PgColumn }
): SQL | undefined =>
  or(
    scope.fullGroupIds.length > 0 ? inArray(columns.groupId, scope.fullGroupIds) : sql`false`,
    scope.selfGroupIds.length > 0
      ? and(inArray(columns.groupId, scope.selfGroupIds), eq(columns.userId, callerId))
      : sql`false`
  );

const inMembershipScope = (scope: SyncScope, callerId: string): SQL | undefined =>
  inGroupScope(scope, callerId, { userId: groupUsers.userId, groupId: groupUsers.groupId });

const inQuotaScope = (scope: SyncScope, callerId: string): SQL | undefined =>
  inGroupScope(scope, callerId, {
    userId: userYearQuotas.userId,
    groupId: userYearQuotas.groupId,
  });

/**
 * A mirror the pull may carry anything from: its owner still belongs to the
 * target group. `getVacationsForGroup` re-checks the same thing before
 * projecting, so somebody who left keeps leaking neither time off nor the
 * mirror row that would label it.
 */
const mirrorOwnerStillInTarget = (): SQL =>
  exists(
    db
      .select({ one: sql`1` })
      .from(groupUsers)
      .where(
        and(
          eq(groupUsers.userId, groupMirrors.userId),
          eq(groupUsers.groupId, groupMirrors.targetGroupId),
          isNull(groupUsers.deletedAt)
        )
      )
  );

/**
 * A mirror projecting into a group the caller sees in full. Callers guard on
 * an empty `fullGroupIds` themselves: `inArray` on an empty list is `false`,
 * which is right here but hides the cheaper "read nothing at all".
 */
const liveMirrorIntoScope = (scope: SyncScope): SQL | undefined =>
  and(
    inArray(groupMirrors.targetGroupId, scope.fullGroupIds),
    isNull(groupMirrors.deletedAt),
    mirrorOwnerStillInTarget()
  );

/** A vacation row a live mirror projects into a group the caller sees in full. */
const mirroredIntoScope = (scope: SyncScope): SQL =>
  scope.fullGroupIds.length === 0
    ? sql`false`
    : exists(
        db
          .select({ one: sql`1` })
          .from(groupMirrors)
          .where(
            and(
              liveMirrorIntoScope(scope),
              eq(groupMirrors.userId, vacation.userId),
              eq(groupMirrors.sourceGroupId, vacation.groupId)
            )
          )
      );

/**
 * Vacations do not follow that split all the way: on top of every row of a
 * group seen in full, the caller's own rows arrive from any group at all,
 * including one they have left, because the personal calendar still shows
 * them, and the rows mirrored into a group seen in full, which belong to
 * another group entirely.
 */
const inVacationScope = (scope: SyncScope, callerId: string): SQL | undefined =>
  or(
    scope.fullGroupIds.length > 0 ? inArray(vacation.groupId, scope.fullGroupIds) : sql`false`,
    eq(vacation.userId, callerId),
    mirroredIntoScope(scope)
  );

const inWindow = (updatedAt: PgColumn, window: SyncWindow): SQL | undefined =>
  and(
    window.since === null ? undefined : gt(updatedAt, window.since),
    lte(updatedAt, window.until)
  );

/** How far back a delta reaches: the cursor time, less the overlap window. */
const deltaWindowStart = (previousCursorTime: Date): Date =>
  new Date(previousCursorTime.getTime() - SYNC_OVERLAP_MS);

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

/** What every reader of one pull shares: whose rows, which windows, and how deep. */
type SyncReadContext = {
  scope: SyncScope;
  callerId: string;
  window: SyncWindow;
  /** How far back the dated tables reach, whatever their `updatedAt` says. */
  history: SyncHistoryWindow;
  /** The three calendar years of bank holidays this pull carries. */
  bankHolidayWindow: SyncBankHolidayWindow;
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
 * A mirror is a row of its target group's pull. A removed one arrives as a
 * tombstone in a delta, the way a membership does, and that tombstone is not
 * held back when its owner has left the target group as well: the client has
 * the row and needs to be told to drop it.
 */
const readMirrorsPage = async (
  context: SyncReadContext,
  organizationIdByGroupId: Map<string, string>,
  after: SyncKeyset | null,
  limit: number
) => {
  if (context.scope.fullGroupIds.length === 0) return [];

  const rows = await db
    .select()
    .from(groupMirrors)
    .where(
      and(
        inArray(groupMirrors.targetGroupId, context.scope.fullGroupIds),
        context.liveOnly
          ? and(isNull(groupMirrors.deletedAt), mirrorOwnerStillInTarget())
          : or(isNotNull(groupMirrors.deletedAt), mirrorOwnerStillInTarget()),
        inWindow(groupMirrors.updatedAt, context.window),
        afterKeyset(groupMirrors.updatedAt, groupMirrors.id, after)
      )
    )
    .orderBy(asc(groupMirrors.updatedAt), asc(groupMirrors.id))
    .limit(limit);

  return rows.map((row) => ({
    key: { updatedAt: row.updatedAt, id: row.id },
    row: {
      id: row.id,
      userId: row.userId,
      sourceGroupId: row.sourceGroupId,
      targetGroupId: row.targetGroupId,
      organizationId: organizationIdByGroupId.get(row.targetGroupId)!,
      deletedAt: toIso(row.deletedAt),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    } satisfies SyncGroupMirrorRow,
  }));
};

/**
 * The groups a live mirror projects from. They are outside the caller's own
 * memberships as often as not, and both the mirror row and the bookings it
 * brings are unlabelled without the group row.
 */
const getMirroredSourceGroupIds = async (context: SyncReadContext): Promise<string[]> => {
  if (context.scope.fullGroupIds.length === 0) return [];

  const rows = await db
    .selectDistinct({ sourceGroupId: groupMirrors.sourceGroupId })
    .from(groupMirrors)
    .where(liveMirrorIntoScope(context.scope));

  return rows.map((row) => row.sourceGroupId);
};

/**
 * Groups the pull must name beyond the caller's memberships: one they have
 * left still owns their own vacation rows, and the client needs the group row
 * to label them. Alongside the source groups above, that is the whole of what
 * widens the set — every other visible row belongs to a group the caller is
 * still in.
 */
const getFormerGroupIds = async (context: SyncReadContext): Promise<string[]> => {
  const rows = await db
    .selectDistinct({ groupId: vacation.groupId })
    .from(vacation)
    .where(
      and(
        eq(vacation.userId, context.callerId),
        gte(vacation.requestedDay, context.history.firstDay)
      )
    );

  const scoped = new Set(context.scope.groupIds);
  return rows.map((row) => row.groupId).filter((groupId) => !scoped.has(groupId));
};

/** Everyone this pull may name, and the subset it owes the client whatever their own row says. */
type SyncUserIds = {
  actors: string[];
  all: string[];
};

/**
 * The people on the vacation rows this pull covers, read from the same scope
 * and window as the vacations reader rather than from the rows one page
 * happened to hold: users are walked before vacations, so a page-by-page count
 * would leave a later page's row without the people on it.
 */
const getVacationActorIds = async (
  context: SyncReadContext,
  window: SyncWindow | null
): Promise<string[]> => {
  const rows = await db
    .selectDistinct({
      userId: vacation.userId,
      approvedBy: vacation.approvedBy,
      rejectedBy: vacation.rejectedBy,
      deletedByUserId: vacation.deletedByUserId,
      createdByUserId: vacation.createdByUserId,
    })
    .from(vacation)
    .where(
      and(
        inVacationScope(context.scope, context.callerId),
        gte(vacation.requestedDay, context.history.firstDay),
        window === null ? undefined : inWindow(vacation.updatedAt, window)
      )
    );

  const ids = new Set<string>();
  for (const row of rows) {
    for (const id of [
      row.userId,
      row.approvedBy,
      row.rejectedBy,
      row.deletedByUserId,
      row.createdByUserId,
    ]) {
      if (id !== null) ids.add(id);
    }
  }
  return [...ids];
};

const getSyncUserIds = async (context: SyncReadContext): Promise<SyncUserIds> => {
  // The people on the rows this pull carries are owed whatever their own row
  // says; the people on every visible row are eligible when their own row
  // changed, or a renamed approver on an old booking would never arrive.
  const actors = new Set(await getVacationActorIds(context, context.window));
  const everyActor =
    context.window.since === null ? [...actors] : await getVacationActorIds(context, null);
  const ids = new Set<string>([context.callerId, ...everyActor]);

  if (context.scope.fullGroupIds.length > 0) {
    const membersWhere = and(
      inArray(groupUsers.groupId, context.scope.fullGroupIds),
      context.liveOnly ? isNull(groupUsers.deletedAt) : undefined
    );
    const [members, changedMembers, managers] = await Promise.all([
      db.select({ userId: groupUsers.userId }).from(groupUsers).where(membersWhere),
      // The membership rows this pull carries name people too, so a member
      // added since the cursor must arrive with their row whatever it says.
      context.window.since === null
        ? []
        : db
            .select({ userId: groupUsers.userId })
            .from(groupUsers)
            .where(and(membersWhere, inWindow(groupUsers.updatedAt, context.window))),
      // A manager holds no membership row of their own in every group, so the
      // group row's own column is what keeps them nameable.
      db
        .select({ managerUserId: groups.managerUserId })
        .from(groups)
        .where(inArray(groups.id, context.scope.fullGroupIds)),
    ]);

    for (const row of members) ids.add(row.userId);
    for (const row of changedMembers) actors.add(row.userId);
    for (const row of managers) ids.add(row.managerUserId);
  }

  return { actors: [...actors], all: [...ids] };
};

/**
 * The users table carries no `deletedAt` and ships no tombstones, so an actor
 * is force-included rather than filtered by its own `updatedAt`: a vacation
 * row must never arrive naming somebody the client cannot resolve.
 */
const readUsersPage = async (
  context: SyncReadContext,
  ids: SyncUserIds,
  after: SyncKeyset | null,
  limit: number
) => {
  const changed = inWindow(user.updatedAt, context.window);
  const rows = await db
    .select({ id: user.id, name: user.name, image: user.image, updatedAt: user.updatedAt })
    .from(user)
    .where(
      and(
        inArray(user.id, ids.all),
        ids.actors.length > 0 ? or(inArray(user.id, ids.actors), changed) : changed,
        afterKeyset(user.updatedAt, user.id, after)
      )
    )
    .orderBy(asc(user.updatedAt), asc(user.id))
    .limit(limit);

  return rows.map((row) => ({
    key: { updatedAt: row.updatedAt, id: row.id },
    row: {
      id: row.id,
      name: row.name,
      image: row.image,
      updatedAt: row.updatedAt.toISOString(),
    } satisfies SyncUserRow,
  }));
};

const readQuotasPage = async (
  context: SyncReadContext,
  organizationIdByGroupId: Map<string, string>,
  after: SyncKeyset | null,
  limit: number
) => {
  if (context.scope.groupIds.length === 0) return [];

  const rows = await db
    .select()
    .from(userYearQuotas)
    .where(
      and(
        inQuotaScope(context.scope, context.callerId),
        gte(userYearQuotas.relatedYear, context.history.firstYear),
        inWindow(userYearQuotas.updatedAt, context.window),
        afterKeyset(userYearQuotas.updatedAt, userYearQuotas.id, after)
      )
    )
    .orderBy(asc(userYearQuotas.updatedAt), asc(userYearQuotas.id))
    .limit(limit);

  return rows.map((row) => ({
    key: { updatedAt: row.updatedAt, id: row.id },
    row: {
      id: row.id,
      userId: row.userId,
      groupId: row.groupId,
      organizationId: organizationIdByGroupId.get(row.groupId)!,
      relatedYear: row.relatedYear,
      vacationDays: row.vacationDays,
      homeOfficeDays: row.homeOfficeDays,
      sickDays: row.sickDays,
      carriedOverDays: row.carriedOverDays,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    } satisfies SyncUserYearQuotaRow,
  }));
};

/**
 * The countries whose bank holidays this pull carries: the holiday country of
 * the live groups the caller belongs to. A group they have left, a soft-deleted
 * one a delta still tombstones, and the source group of a mirror add none —
 * each is carried only so the client can label a row, and none of them is a
 * calendar the phone marks holidays on.
 */
const getScopedHolidayCountries = async (groupIds: string[]): Promise<string[]> => {
  if (groupIds.length === 0) return [];

  const rows = await db
    .selectDistinct({ holidayCountry: groups.holidayCountry })
    .from(groups)
    .where(
      and(inArray(groups.id, groupIds), isNull(groups.deletedAt), isNotNull(groups.holidayCountry))
    );

  return rows.map((row) => row.holidayCountry).filter((country) => country !== null);
};

/**
 * The lazy fill, once per pull: a country the server has never computed would
 * otherwise answer an empty first pull. It runs before any row is read and
 * outside every transaction, one statement per country and year, and it is
 * skipped on a resumed page — the first page of the loop already ran it.
 */
const fillScopedBankHolidays = async (
  countries: () => Promise<string[]>,
  window: SyncBankHolidayWindow,
  resume: SyncPagePosition | null
): Promise<void> => {
  if (resume !== null) return;

  await Promise.all(
    (await countries()).flatMap((country) =>
      window.years.map((year) => ensureBankHolidays(year, country))
    )
  );
};

/**
 * Bank holidays are unpartitioned reference data: no `organizationId`, no
 * `deletedAt` and so no tombstones. Only the lower half of the pull's window
 * applies — the fill writes its rows after the cursor time was minted, so
 * bounding the read by it would hide exactly the rows this pull just created.
 * Those rows sit past the cursor this pull hands back, so the next delta
 * carries them once more; the client upserts, as it does for every row the 60
 * second overlap repeats.
 */
const readBankHolidaysPage = async (
  context: SyncReadContext,
  countries: string[],
  after: SyncKeyset | null,
  limit: number
) => {
  if (countries.length === 0) return [];

  const rows = await db
    .select()
    .from(bankHolidays)
    .where(
      and(
        inArray(bankHolidays.country, countries),
        isNull(bankHolidays.region),
        gte(bankHolidays.date, context.bankHolidayWindow.firstDay),
        lte(bankHolidays.date, context.bankHolidayWindow.lastDay),
        context.window.since === null
          ? undefined
          : gt(bankHolidays.updatedAt, context.window.since),
        afterKeyset(bankHolidays.updatedAt, bankHolidays.id, after)
      )
    )
    .orderBy(asc(bankHolidays.updatedAt), asc(bankHolidays.id))
    .limit(limit);

  return rows.map((row) => ({
    key: { updatedAt: row.updatedAt, id: row.id },
    row: {
      id: row.id,
      date: row.date,
      name: row.name,
      country: row.country,
      region: row.region,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    } satisfies SyncBankHolidayRow,
  }));
};

/**
 * Cancelled rows are not filtered by `liveOnly`: the web calendar keeps a
 * cancelled booking as history, so a snapshot that dropped it would have the
 * client sweep away history it is supposed to hold.
 */
const readVacationsPage = async (
  context: SyncReadContext,
  organizationIdByGroupId: Map<string, string>,
  after: SyncKeyset | null,
  limit: number
) => {
  const rows = await db
    .select()
    .from(vacation)
    .where(
      and(
        inVacationScope(context.scope, context.callerId),
        gte(vacation.requestedDay, context.history.firstDay),
        inWindow(vacation.updatedAt, context.window),
        afterKeyset(vacation.updatedAt, vacation.id, after)
      )
    )
    .orderBy(asc(vacation.updatedAt), asc(vacation.id))
    .limit(limit);

  return rows.map((row) => ({
    key: { updatedAt: row.updatedAt, id: row.id },
    row: {
      id: row.id,
      userId: row.userId,
      groupId: row.groupId,
      organizationId: organizationIdByGroupId.get(row.groupId)!,
      requestId: row.requestId,
      requestedDay: row.requestedDay,
      startTime: row.startTime,
      endTime: row.endTime,
      vacationType: row.vacationType,
      halfDay: row.halfDay,
      approvedAt: toIso(row.approvedAt),
      approvedBy: row.approvedBy,
      rejectedAt: toIso(row.rejectedAt),
      rejectedBy: row.rejectedBy,
      rejectionReason: row.rejectionReason,
      note: row.note,
      createdByUserId: row.createdByUserId,
      deletedAt: toIso(row.deletedAt),
      deletedByUserId: row.deletedByUserId,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    } satisfies SyncVacationRow,
  }));
};

/**
 * One reader per table, in dependency order, each resuming where the last page
 * stopped. `holidayCountries` comes from the caller because the fill that ran
 * before the walk asked the same question; one memo answers both.
 */
const buildReaders = (
  context: SyncReadContext,
  holidayCountries: () => Promise<string[]>
): SyncTableReader[] => {
  const visibleGroupIds = memoize(async () => {
    const [former, mirroredSources] = await Promise.all([
      getFormerGroupIds(context),
      getMirroredSourceGroupIds(context),
    ]);
    return [...new Set([...context.scope.groupIds, ...former, ...mirroredSources])];
  });
  const organizationIds = memoize(async () =>
    getScopedOrganizationIds(await visibleGroupIds(), context.window)
  );
  const organizationIdByGroupId = memoize(async () =>
    getOrganizationIdByGroupId(await visibleGroupIds())
  );
  const userIds = memoize(() => getSyncUserIds(context));

  return [
    {
      table: "organizations",
      read: async (after, limit) => readOrganizationsPage(await organizationIds(), after, limit),
    },
    {
      table: "users",
      read: async (after, limit) => readUsersPage(context, await userIds(), after, limit),
    },
    {
      table: "groups",
      read: async (after, limit) =>
        readGroupsPage(await visibleGroupIds(), context.window, after, limit),
    },
    {
      table: "groupUsers",
      read: async (after, limit) =>
        readMembershipsPage(context, await organizationIdByGroupId(), after, limit),
    },
    {
      table: "groupMirrors",
      read: async (after, limit) =>
        readMirrorsPage(context, await organizationIdByGroupId(), after, limit),
    },
    {
      table: "userYearQuotas",
      read: async (after, limit) =>
        readQuotasPage(context, await organizationIdByGroupId(), after, limit),
    },
    {
      table: "bankHolidays",
      read: async (after, limit) =>
        readBankHolidaysPage(context, await holidayCountries(), after, limit),
    },
    {
      table: "vacations",
      read: async (after, limit) =>
        readVacationsPage(context, await organizationIdByGroupId(), after, limit),
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
  users: rowsOf<SyncUserRow>(payload.page, "users"),
  groups: rowsOf<SyncGroupRow>(payload.page, "groups"),
  groupUsers: rowsOf<SyncGroupUserRow>(payload.page, "groupUsers"),
  groupMirrors: rowsOf<SyncGroupMirrorRow>(payload.page, "groupMirrors"),
  userYearQuotas: rowsOf<SyncUserYearQuotaRow>(payload.page, "userYearQuotas"),
  bankHolidays: rowsOf<SyncBankHolidayRow>(payload.page, "bankHolidays"),
  vacations: rowsOf<SyncVacationRow>(payload.page, "vacations"),
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
  const bankHolidayWindow = syncBankHolidayWindow(cursorTime);
  const holidayCountries = memoize(() => getScopedHolidayCountries(scope.groupIds));
  await fillScopedBankHolidays(holidayCountries, bankHolidayWindow, resume);

  const page = await collectSyncPage(
    buildReaders(
      {
        scope,
        callerId: userId,
        window: { since: null, until: cursorTime },
        history: syncHistoryWindow(cursorTime),
        bankHolidayWindow,
        liveOnly: true,
      },
      holidayCountries
    ),
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
  const since = deltaWindowStart(previousCursorTime);
  const scope = splitScope(await getScopeEntries(userId, { includeDeletedGroups: true }));
  const bankHolidayWindow = syncBankHolidayWindow(cursorTime);
  const holidayCountries = memoize(() => getScopedHolidayCountries(scope.groupIds));
  await fillScopedBankHolidays(holidayCountries, bankHolidayWindow, resume);

  const page = await collectSyncPage(
    buildReaders(
      {
        scope,
        callerId: userId,
        window: { since, until: cursorTime },
        history: syncHistoryWindow(cursorTime),
        bankHolidayWindow,
        liveOnly: false,
      },
      holidayCountries
    ),
    resume
  );

  return buildEnvelope({
    cursorTime,
    loop: { reset: false, previousCursorTime },
    page,
  });
};

/** Whether any row of `table` matching `groupIds` changed inside the window. */
const anyChangedInWindow = async (
  table: typeof groupMirrors | typeof groups,
  groupColumn: PgColumn,
  groupIds: string[],
  window: SyncWindow
): Promise<boolean> => {
  const rows = await db
    .select({ one: sql`1` })
    .from(table)
    .where(and(inArray(groupColumn, groupIds), inWindow(table.updatedAt, window)))
    .limit(1);

  return rows.length > 0;
};

/**
 * Whether what the caller may see changed inside the window a delta covers,
 * which no set of changed rows can express: a membership row of their own in
 * any group, a mirror row targeting one of their groups, or one of those
 * group rows. Soft deletes count, because they bump `updatedAt` like any
 * other write.
 *
 * Membership rows are read whatever their `deletedAt` says: the caller's own
 * removal is the one trigger the live scope can no longer see. The groups
 * checked after it are the ones the caller still belongs to — a group they
 * left since the cursor changed their membership row too, so it has already
 * triggered.
 */
/**
 * A mirror shows only while its owner belongs to the target group, so the
 * owner joining or leaving one of the caller's groups changes what the caller
 * sees without touching the mirror row itself.
 */
const mirrorOwnerMembershipChanged = async (
  groupIds: string[],
  window: SyncWindow
): Promise<boolean> => {
  const rows = await db
    .select({ one: sql`1` })
    .from(groupUsers)
    .innerJoin(
      groupMirrors,
      and(
        eq(groupMirrors.userId, groupUsers.userId),
        eq(groupMirrors.targetGroupId, groupUsers.groupId)
      )
    )
    .where(
      and(
        inArray(groupMirrors.targetGroupId, groupIds),
        isNull(groupMirrors.deletedAt),
        inWindow(groupUsers.updatedAt, window)
      )
    )
    .limit(1);

  return rows.length > 0;
};

const hasSyncResetTrigger = async (callerId: string, window: SyncWindow): Promise<boolean> => {
  const memberships = await db
    .select({
      groupId: groupUsers.groupId,
      deletedAt: groupUsers.deletedAt,
      updatedAt: groupUsers.updatedAt,
    })
    .from(groupUsers)
    .where(eq(groupUsers.userId, callerId));

  const inside = (updatedAt: Date): boolean =>
    (window.since === null || updatedAt > window.since) && updatedAt <= window.until;
  if (memberships.some((row) => inside(row.updatedAt))) return true;

  const groupIds = [
    ...new Set(memberships.filter((row) => row.deletedAt === null).map((row) => row.groupId)),
  ];
  if (groupIds.length === 0) return false;

  const [mirrors, mirrorOwners, scopedGroups] = await Promise.all([
    anyChangedInWindow(groupMirrors, groupMirrors.targetGroupId, groupIds, window),
    mirrorOwnerMembershipChanged(groupIds, window),
    anyChangedInWindow(groups, groups.id, groupIds, window),
  ]);

  return mirrors || mirrorOwners || scopedGroups;
};

/**
 * A delta, unless the caller's scope moved under it since the cursor. The
 * check runs before any reader, and only for a fresh delta: a resumed page
 * stays in the loop it belongs to, whichever kind that is.
 */
const buildFreshSyncPull = async (
  userId: string,
  previousCursorTime: Date,
  cursorTime: Date
): Promise<SyncEnvelope> => {
  const window = { since: deltaWindowStart(previousCursorTime), until: cursorTime };
  return (await hasSyncResetTrigger(userId, window))
    ? buildSyncSnapshot(userId, cursorTime)
    : buildSyncDelta(userId, previousCursorTime, cursorTime);
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
  if (page === null) {
    // The dated tables stop matching last year's oldest rows once the window
    // moves, and a delta has no tombstone for that; a snapshot lets the client
    // sweep them.
    return sameHistoryWindow(cursor.cursorTime, cursorTime)
      ? buildFreshSyncPull(userId, cursor.cursorTime, cursorTime)
      : buildSyncSnapshot(userId, cursorTime);
  }

  return page.reset
    ? buildSyncSnapshot(userId, cursor.cursorTime, page.position)
    : buildSyncDelta(userId, page.previousCursorTime, cursor.cursorTime, page.position);
};
