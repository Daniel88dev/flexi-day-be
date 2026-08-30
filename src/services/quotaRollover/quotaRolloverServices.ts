import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../../db/db.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
import { groups } from "../../db/schema/group-schema.js";
import { userYearQuotas } from "../../db/schema/user-year-quotas-schema.js";
import { vacation, CalendarRecordType } from "../../db/schema/vacation-schema.js";
import { changesSchema, changesType } from "../../db/schema/changes-schema.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { logger } from "../../middleware/logger.js";
import { computeRolloverRow, describeRollover, type RolloverCandidate } from "./computeRollover.js";

// Arbitrary but fixed: two instances running the job at once must pick the
// same key for `pg_try_advisory_xact_lock` to serialise them.
const ROLLOVER_ADVISORY_LOCK_KEY = 4_812_057;

// Chunk the writes so a tenant with thousands of memberships does not build a
// single statement with tens of thousands of bind parameters.
const INSERT_BATCH_SIZE = 500;

export type RolloverResult = {
  year: number;
  created: number;
  skipped: boolean;
};

/**
 * Every active membership still missing a quota row for `year`, joined to the
 * previous year's row and usage.
 *
 * The `NOT EXISTS` is what makes the whole job idempotent and safe to run on a
 * timer: a membership that already has a row for the year — whether the job or
 * an admin created it — is never returned, so a manual edit is never
 * overwritten.
 */
export const findRolloverCandidates = async (year: number): Promise<RolloverCandidate[]> => {
  const previousYear = year - 1;
  const previousStart = `${previousYear.toString().padStart(4, "0")}-01-01`;
  const previousEnd = `${year.toString().padStart(4, "0")}-01-01`;

  const previousQuota = db
    .select()
    .from(userYearQuotas)
    .where(eq(userYearQuotas.relatedYear, previousYear.toString()))
    .as("previous_quota");

  const previousUsage = db
    .select({
      userId: vacation.userId,
      groupId: vacation.groupId,
      usedDays: sql<string>`
        COALESCE(SUM(CASE WHEN ${vacation.halfDay} THEN 0.5 ELSE 1 END), 0)
      `.as("used_days"),
    })
    .from(vacation)
    .where(
      and(
        eq(vacation.vacationType, CalendarRecordType.Vacation),
        isNull(vacation.deletedAt),
        isNull(vacation.rejectedAt),
        sql`${vacation.requestedDay} >= ${previousStart}`,
        sql`${vacation.requestedDay} < ${previousEnd}`
      )
    )
    .groupBy(vacation.userId, vacation.groupId)
    .as("previous_usage");

  const rows = await db
    .select({
      userId: groupUsers.userId,
      groupId: groupUsers.groupId,
      previousVacationDays: previousQuota.vacationDays,
      previousHomeOfficeDays: previousQuota.homeOfficeDays,
      previousSickDays: previousQuota.sickDays,
      previousCarriedOverDays: previousQuota.carriedOverDays,
      previousUsedDays: previousUsage.usedDays,
      groupDefaultVacationDays: groups.defaultVacationDays,
      groupDefaultHomeOfficeDays: groups.defaultHomeOfficeDays,
      groupDefaultSickDays: groups.defaultSickDays,
    })
    .from(groupUsers)
    .innerJoin(groups, eq(groupUsers.groupId, groups.id))
    .leftJoin(
      previousQuota,
      and(
        eq(previousQuota.userId, groupUsers.userId),
        eq(previousQuota.groupId, groupUsers.groupId)
      )
    )
    .leftJoin(
      previousUsage,
      and(
        eq(previousUsage.userId, groupUsers.userId),
        eq(previousUsage.groupId, groupUsers.groupId)
      )
    )
    .where(
      and(
        isNull(groupUsers.deletedAt),
        isNull(groups.deletedAt),
        sql`NOT EXISTS (
          SELECT 1 FROM ${userYearQuotas}
          WHERE ${userYearQuotas.userId} = ${groupUsers.userId}
            AND ${userYearQuotas.groupId} = ${groupUsers.groupId}
            AND ${userYearQuotas.relatedYear} = ${year.toString()}
        )`
      )
    );

  return rows.map((row) => ({
    userId: row.userId,
    groupId: row.groupId,
    previousVacationDays: row.previousVacationDays,
    previousHomeOfficeDays: row.previousHomeOfficeDays,
    previousSickDays: row.previousSickDays,
    previousCarriedOverDays: row.previousCarriedOverDays,
    previousUsedDays: Number(row.previousUsedDays ?? 0),
    groupDefaultVacationDays: row.groupDefaultVacationDays,
    groupDefaultHomeOfficeDays: row.groupDefaultHomeOfficeDays,
    groupDefaultSickDays: row.groupDefaultSickDays,
  }));
};

const chunk = <T>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

/**
 * Opens the given year for every member who has no allowance row yet, rolling
 * their unused days forward.
 *
 * Runs under a transaction-scoped advisory lock, so when several instances
 * fire the schedule at the same moment exactly one does the work and the rest
 * return `skipped`. The inserts additionally use `onConflictDoNothing`, which
 * makes a concurrent admin edit racing the job a no-op rather than a
 * constraint error.
 */
export const rolloverQuotasForYear = async (year: number): Promise<RolloverResult> => {
  return db.transaction(async (tx) => {
    // node-postgres returns a QueryResult, so the row sits under `.rows`.
    const lockResult = await tx.execute<{ locked: boolean }>(
      sql`SELECT pg_try_advisory_xact_lock(${ROLLOVER_ADVISORY_LOCK_KEY}) AS locked`
    );

    if (!lockResult.rows[0]?.locked) {
      logger.info("Quota rollover already running elsewhere, skipping", { year });
      return { year, created: 0, skipped: true };
    }

    const candidates = await findRolloverCandidates(year);

    if (candidates.length === 0) return { year, created: 0, skipped: false };

    const rows = candidates.map(computeRolloverRow);
    let created = 0;

    for (const batch of chunk(rows, INSERT_BATCH_SIZE)) {
      const inserted = await tx
        .insert(userYearQuotas)
        .values(
          batch.map((row) => ({
            id: generateRandomUUID(),
            userId: row.userId,
            groupId: row.groupId,
            relatedYear: year.toString(),
            vacationDays: row.vacationDays,
            homeOfficeDays: row.homeOfficeDays,
            sickDays: row.sickDays,
            carriedOverDays: row.carriedOverDays,
          }))
        )
        .onConflictDoNothing()
        .returning({ userId: userYearQuotas.userId, groupId: userYearQuotas.groupId });

      // Only audit what actually landed, so a row lost to the conflict clause
      // does not leave a change entry describing a write that never happened.
      const written = new Set(inserted.map((row) => `${row.userId}::${row.groupId}`));
      const auditable = batch.filter((row) => written.has(`${row.userId}::${row.groupId}`));
      created += auditable.length;

      if (auditable.length > 0) {
        await tx.insert(changesSchema).values(
          auditable.map((row) => ({
            id: generateRandomUUID(),
            userId: row.userId,
            groupId: row.groupId,
            changeType: changesType.UserYearQuotas,
            // No actor: this was the scheduler, not a person.
            changingUserId: null,
            changeDetail: describeRollover(year, row),
          }))
        );
      }
    }

    return { year, created, skipped: false };
  });
};
