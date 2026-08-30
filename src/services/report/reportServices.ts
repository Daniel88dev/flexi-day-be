import { and, asc, desc, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "../../db/db.js";
import { vacation, CalendarRecordType } from "../../db/schema/vacation-schema.js";
import { groups } from "../../db/schema/group-schema.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
import { user } from "../../db/schema/auth-schema.js";
import { userYearQuotas } from "../../db/schema/user-year-quotas-schema.js";
import { changesSchema } from "../../db/schema/changes-schema.js";
import { reportExports } from "../../db/schema/report-export-schema.js";
import { alias } from "drizzle-orm/pg-core";
import { buildUserSummary } from "../../utils/userPresentation.js";
import { sumDaysWhere } from "../vacation/dayWeight.js";
import { buildScopePredicate } from "./reportScope.js";
import { collapseBookings, type BookingRow } from "./collapseBookings.js";
import type {
  MemberChangeEntry,
  MonthlyUsageRow,
  ReportBooking,
  ReportExportInsertType,
  ReportQuotaRow,
  ReportScope,
  ReportScopeEntry,
  ReportScopeMember,
  ReportUsageSplit,
} from "./types.js";

const yearBounds = (year: number) => ({
  start: `${year.toString().padStart(4, "0")}-01-01`,
  end: `${(year + 1).toString().padStart(4, "0")}-01-01`,
});

const vacationScopeColumns = { userId: vacation.userId, groupId: vacation.groupId };
const quotaScopeColumns = { userId: userYearQuotas.userId, groupId: userYearQuotas.groupId };

/**
 * The groups the caller may pull into a report, and at what depth. View
 * access, admin access, or being the group's manager all open the whole
 * group; a plain membership still lets the member report on themselves.
 */
export const getScopeEntries = async (userId: string): Promise<ReportScopeEntry[]> => {
  const rows = await db
    .select({
      groupId: groups.id,
      groupName: groups.groupName,
      viewAccess: groupUsers.viewAccess,
      adminAccess: groupUsers.adminAccess,
      managerUserId: groups.managerUserId,
    })
    .from(groupUsers)
    .innerJoin(groups, eq(groupUsers.groupId, groups.id))
    .where(
      and(eq(groupUsers.userId, userId), isNull(groupUsers.deletedAt), isNull(groups.deletedAt))
    )
    .orderBy(asc(groups.groupName));

  return rows.map((row) => {
    const isManager = row.managerUserId === userId;
    const canEditQuotas = row.adminAccess || isManager;
    return {
      groupId: row.groupId,
      groupName: row.groupName,
      access: row.viewAccess || canEditQuotas ? ("all" as const) : ("self" as const),
      canEditQuotas,
    };
  });
};

/**
 * Every member the caller can see, one row per (member, group). Takes an
 * already-resolved scope so the overview and export handlers do not re-query
 * the caller's memberships they have just loaded.
 */
export const getScopeMembers = async (
  scope: ReportScopeEntry[],
  callerId: string
): Promise<ReportScopeMember[]> => {
  if (scope.length === 0) return [];

  const fullGroups = scope.filter((e) => e.access === "all").map((e) => e.groupId);
  const selfGroups = scope.filter((e) => e.access === "self").map((e) => e.groupId);

  const rows = await db
    .select({
      groupId: groupUsers.groupId,
      userId: groupUsers.userId,
      userName: user.name,
    })
    .from(groupUsers)
    .innerJoin(user, eq(groupUsers.userId, user.id))
    .where(
      and(
        isNull(groupUsers.deletedAt),
        or(
          fullGroups.length > 0 ? inArray(groupUsers.groupId, fullGroups) : sql`false`,
          selfGroups.length > 0
            ? and(inArray(groupUsers.groupId, selfGroups), eq(groupUsers.userId, callerId))
            : sql`false`
        )
      )
    )
    .orderBy(asc(user.name));

  return rows.map((row) => ({
    groupId: row.groupId,
    ...buildUserSummary({ id: row.userId, name: row.userName }),
  }));
};

/** Scope plus everything the filter controls need: selectable members and years. */
export const getReportScope = async (userId: string): Promise<ReportScope> => {
  const entries = await getScopeEntries(userId);

  if (entries.length === 0) return { groups: [], members: [], years: [new Date().getFullYear()] };

  const [members, years] = await Promise.all([
    getScopeMembers(entries, userId),
    getAvailableYears(entries, userId),
  ]);

  return { groups: entries, members, years };
};

/**
 * Years the caller could meaningfully select: any year with a booking or a
 * quota row in scope, always including the current one so a fresh account
 * still gets a usable filter.
 */
const getAvailableYears = async (
  scope: ReportScopeEntry[],
  callerId: string
): Promise<number[]> => {
  const vacationPredicate = buildScopePredicate(scope, callerId, vacationScopeColumns);
  const quotaPredicate = buildScopePredicate(scope, callerId, quotaScopeColumns);

  const [vacationYears, quotaYears] = await Promise.all([
    vacationPredicate
      ? db
          .selectDistinct({
            year: sql<number>`EXTRACT(YEAR FROM ${vacation.requestedDay})::int`,
          })
          .from(vacation)
          .where(and(vacationPredicate, isNull(vacation.deletedAt)))
      : Promise.resolve([]),
    quotaPredicate
      ? db
          .selectDistinct({ year: sql<number>`${userYearQuotas.relatedYear}::int` })
          .from(userYearQuotas)
          .where(quotaPredicate)
      : Promise.resolve([]),
  ]);

  const years = new Set<number>([new Date().getFullYear()]);
  for (const row of [...vacationYears, ...quotaYears]) years.add(Number(row.year));

  return Array.from(years).sort((a, b) => b - a);
};

type UsageFilters = {
  groupIds?: string[];
  userIds?: string[];
  types?: CalendarRecordType[];
};

const usageWhere = (
  scope: ReportScopeEntry[],
  callerId: string,
  year: number,
  filters: UsageFilters
) => {
  const scoped = buildScopePredicate(scope, callerId, vacationScopeColumns, filters);
  if (!scoped) return null;

  const { start, end } = yearBounds(year);
  const clauses = [
    scoped,
    isNull(vacation.deletedAt),
    gte(vacation.requestedDay, start),
    lt(vacation.requestedDay, end),
  ];
  if (filters.types && filters.types.length > 0) {
    clauses.push(inArray(vacation.vacationType, filters.types));
  }
  return and(...clauses);
};

/** Per member, group, month and record type — the series behind the charts and the table. */
export const aggregateUsageByUserMonth = async (
  scope: ReportScopeEntry[],
  callerId: string,
  year: number,
  filters: UsageFilters = {}
): Promise<MonthlyUsageRow[]> => {
  const where = usageWhere(scope, callerId, year, filters);
  if (!where) return [];

  const month = sql<number>`EXTRACT(MONTH FROM ${vacation.requestedDay})::int`;

  const rows = await db
    .select({
      userId: vacation.userId,
      groupId: vacation.groupId,
      month,
      vacationType: vacation.vacationType,
      used: sumDaysWhere(sql`${vacation.approvedAt} IS NOT NULL`),
      pending: sumDaysWhere(sql`${vacation.approvedAt} IS NULL AND ${vacation.rejectedAt} IS NULL`),
    })
    .from(vacation)
    .where(where)
    .groupBy(vacation.userId, vacation.groupId, month, vacation.vacationType);

  return rows.map((row) => ({
    userId: row.userId,
    groupId: row.groupId,
    month: Number(row.month),
    vacationType: row.vacationType,
    used: Number(row.used),
    pending: Number(row.pending),
  }));
};

/**
 * Splits a year's usage at today: what has already been taken, what is
 * approved but still ahead, and what is awaiting a decision. The export's
 * summary sheet and the report's totals both read from here.
 */
export const aggregateUsageSplit = async (
  scope: ReportScopeEntry[],
  callerId: string,
  year: number,
  filters: UsageFilters = {}
): Promise<
  (ReportUsageSplit & { userId: string; groupId: string; vacationType: CalendarRecordType })[]
> => {
  const where = usageWhere(scope, callerId, year, filters);
  if (!where) return [];

  const rows = await db
    .select({
      userId: vacation.userId,
      groupId: vacation.groupId,
      vacationType: vacation.vacationType,
      usedToDate: sumDaysWhere(
        sql`${vacation.approvedAt} IS NOT NULL AND ${vacation.requestedDay} <= CURRENT_DATE`
      ),
      plannedRemaining: sumDaysWhere(
        sql`${vacation.approvedAt} IS NOT NULL AND ${vacation.requestedDay} > CURRENT_DATE`
      ),
      pending: sumDaysWhere(sql`${vacation.approvedAt} IS NULL AND ${vacation.rejectedAt} IS NULL`),
    })
    .from(vacation)
    .where(where)
    .groupBy(vacation.userId, vacation.groupId, vacation.vacationType);

  return rows.map((row) => ({
    userId: row.userId,
    groupId: row.groupId,
    vacationType: row.vacationType,
    usedToDate: Number(row.usedToDate),
    plannedRemaining: Number(row.plannedRemaining),
    pending: Number(row.pending),
  }));
};

export const getQuotasForScope = async (
  scope: ReportScopeEntry[],
  callerId: string,
  year: number,
  filters: Pick<UsageFilters, "groupIds" | "userIds"> = {}
): Promise<ReportQuotaRow[]> => {
  const scoped = buildScopePredicate(scope, callerId, quotaScopeColumns, filters);
  if (!scoped) return [];

  const rows = await db
    .select({
      userId: userYearQuotas.userId,
      groupId: userYearQuotas.groupId,
      vacationDays: userYearQuotas.vacationDays,
      homeOfficeDays: userYearQuotas.homeOfficeDays,
      sickDays: userYearQuotas.sickDays,
      carriedOverDays: userYearQuotas.carriedOverDays,
    })
    .from(userYearQuotas)
    .where(and(scoped, eq(userYearQuotas.relatedYear, year.toString())));

  return rows;
};

/** Collapsed bookings in scope, ordered so `collapseBookings` can run in one pass. */
export const getBookingsForScope = async (
  scope: ReportScopeEntry[],
  callerId: string,
  year: number,
  filters: UsageFilters = {},
  limit?: number
): Promise<ReportBooking[]> => {
  const where = usageWhere(scope, callerId, year, filters);
  if (!where) return [];

  const query = db
    .select({
      userId: vacation.userId,
      userName: user.name,
      groupId: vacation.groupId,
      groupName: groups.groupName,
      vacationType: vacation.vacationType,
      requestedDay: vacation.requestedDay,
      halfDay: vacation.halfDay,
      approvedAt: vacation.approvedAt,
      rejectedAt: vacation.rejectedAt,
      note: vacation.note,
    })
    .from(vacation)
    .innerJoin(user, eq(vacation.userId, user.id))
    .innerJoin(groups, eq(vacation.groupId, groups.id))
    .where(where)
    .orderBy(
      asc(vacation.userId),
      asc(vacation.groupId),
      asc(vacation.vacationType),
      asc(vacation.requestedDay),
      // A rejected day and the live re-request of it both show up here, so the
      // day alone is no longer a unique sort key. Live row first, so `limit`
      // and the export can't return the two in a different order each run.
      sql`${vacation.rejectedAt} IS NOT NULL`
    );

  const rows: BookingRow[] = await (limit === undefined ? query : query.limit(limit));

  return collapseBookings(rows);
};

/**
 * Which of `groupIds` the member actually belongs to. Callers pass the groups
 * they are allowed to look through, so an empty result means "not visible to
 * you" rather than "no such member".
 */
export const getMemberGroupsInScope = async (
  userId: string,
  groupIds: string[]
): Promise<string[]> => {
  if (groupIds.length === 0) return [];

  const rows = await db
    .select({ groupId: groupUsers.groupId })
    .from(groupUsers)
    .where(
      and(
        eq(groupUsers.userId, userId),
        inArray(groupUsers.groupId, groupIds),
        isNull(groupUsers.deletedAt)
      )
    );

  return rows.map((row) => row.groupId);
};

/** Admin-made quota and limit changes for one member, newest first. */
export const getMemberChanges = async (
  userId: string,
  groupIds: string[],
  year: number
): Promise<MemberChangeEntry[]> => {
  if (groupIds.length === 0) return [];

  const actor = alias(user, "actor");
  const { start, end } = yearBounds(year);

  const rows = await db
    .select({
      id: changesSchema.id,
      groupId: changesSchema.groupId,
      changeType: changesSchema.changeType,
      changeDetail: changesSchema.changeDetail,
      createdAt: changesSchema.createdAt,
      actorId: actor.id,
      actorName: actor.name,
    })
    .from(changesSchema)
    .leftJoin(actor, eq(changesSchema.changingUserId, actor.id))
    .where(
      and(
        eq(changesSchema.userId, userId),
        inArray(changesSchema.groupId, groupIds),
        gte(changesSchema.createdAt, new Date(`${start}T00:00:00Z`)),
        lt(changesSchema.createdAt, new Date(`${end}T00:00:00Z`))
      )
    )
    // Two edits saved in the same millisecond would otherwise come back in
    // arbitrary order, so `id` breaks the tie and keeps the list stable.
    .orderBy(desc(changesSchema.createdAt), desc(changesSchema.id));

  return rows.map((row) => ({
    id: row.id,
    groupId: row.groupId,
    changeType: row.changeType,
    changeDetail: row.changeDetail,
    actor:
      row.actorId && row.actorName
        ? buildUserSummary({ id: row.actorId, name: row.actorName })
        : null,
    createdAt: row.createdAt.toISOString(),
  }));
};

/**
 * Unused allowance from the previous year, offered as the default when an
 * admin sets this year's carry-over. Pending days count as spoken for —
 * suggesting days a member has already requested would over-grant.
 */
export const getCarryOverSuggestion = async (
  userId: string,
  groupId: string,
  year: number
): Promise<{ previousYear: number; allocated: number; used: number; suggestion: number }> => {
  const previousYear = year - 1;
  const { start, end } = yearBounds(previousYear);

  const [quotaRow] = await db
    .select({
      vacationDays: userYearQuotas.vacationDays,
      carriedOverDays: userYearQuotas.carriedOverDays,
    })
    .from(userYearQuotas)
    .where(
      and(
        eq(userYearQuotas.userId, userId),
        eq(userYearQuotas.groupId, groupId),
        eq(userYearQuotas.relatedYear, previousYear.toString())
      )
    );

  const [usageRow] = await db
    .select({
      used: sumDaysWhere(sql`${vacation.rejectedAt} IS NULL`),
    })
    .from(vacation)
    .where(
      and(
        eq(vacation.userId, userId),
        eq(vacation.groupId, groupId),
        eq(vacation.vacationType, CalendarRecordType.Vacation),
        isNull(vacation.deletedAt),
        gte(vacation.requestedDay, start),
        lt(vacation.requestedDay, end)
      )
    );

  const allocated = (quotaRow?.vacationDays ?? 0) + (quotaRow?.carriedOverDays ?? 0);
  const used = Number(usageRow?.used ?? 0);

  return {
    previousYear,
    allocated,
    used,
    suggestion: Math.max(0, Math.floor(allocated - used)),
  };
};

export const recordReportExport = async (record: ReportExportInsertType): Promise<void> => {
  await db.insert(reportExports).values(record);
};
