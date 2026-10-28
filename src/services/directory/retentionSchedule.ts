import { and, eq, inArray, max, sql } from "drizzle-orm";
import { config } from "../../config.js";
import { db, type DbTransaction } from "../../db/db.js";
import {
  directoryProfileHistory,
  profileHistoryActor,
} from "../../db/schema/directory-profile-schema.js";
import { retentionPeriod } from "../../db/schema/directory-retention-schema.js";
import {
  directoryPermissionRow,
  directoryPermissionValue,
} from "../../db/schema/directory-schema.js";
import { employments, workerType } from "../../db/schema/employment-schema.js";
import { loadDirectoryViewer } from "./directoryViewer.js";
import { SECTION_ROWS, type DirectoryAccess, type SectionRow } from "./permissionResolver.js";
import { readRetentionHolds } from "./retentionHoldServices.js";
import { businessDateInZone } from "../../utils/dateFunc.js";
import { removalDay } from "./retentionPeriods.js";
import {
  clockStart,
  holdsData,
  intervalOf,
  readRetentionPeriods,
  storedPeriod,
} from "./retentionPurge.js";
import type { ProfileRetention, RetentionHoldView, SectionRetention } from "./types.js";
import { SECTION_KEYS, type ProfileSectionKey } from "./sectionKeys.js";

type SectionState = {
  holds: boolean;
  /** Null under until erased. */
  dueAt: Date | null;
  untilErased: boolean;
  /** The day of the latest Retention purge of the Section, if any. */
  removedOn: string | null;
};

export type RetentionSchedule = {
  hold: RetentionHoldView | null;
  sections: Record<SectionRow, SectionState>;
};

const asDate = (value: unknown): Date | null =>
  value === null || value === undefined ? null : new Date(value as string | Date);

/**
 * Where each Section of the given ended Employments stands: whether it holds
 * data, when its current period runs out, and when a purge last emptied it.
 * Worked out from the clock and the organization's current periods, like the
 * purge itself, so nothing is stored.
 */
export const readRetentionSchedules = async (
  organizationId: string,
  employmentIds: string[],
  tx?: DbTransaction
): Promise<Map<string, RetentionSchedule>> => {
  if (employmentIds.length === 0) return new Map();
  const client = tx ?? db;
  const columns = Object.fromEntries(
    SECTION_ROWS.flatMap((section) => [
      [`holds_${section}`, sql<boolean>`${holdsData(section)}`],
      [`due_${section}`, sql<unknown>`${clockStart} + ${intervalOf(storedPeriod(section))}`],
    ])
  );
  const rows = (await client
    .select({ id: employments.id, ...columns })
    .from(employments)
    .where(
      and(eq(employments.organizationId, organizationId), inArray(employments.id, employmentIds))
    )) as ({ id: string } & Record<string, unknown>)[];

  const purges = await client
    .select({
      employmentId: directoryProfileHistory.employmentId,
      section: directoryProfileHistory.section,
      at: max(directoryProfileHistory.createdAt),
    })
    .from(directoryProfileHistory)
    .where(
      and(
        eq(directoryProfileHistory.actor, profileHistoryActor.Retention),
        inArray(directoryProfileHistory.employmentId, employmentIds)
      )
    )
    .groupBy(directoryProfileHistory.employmentId, directoryProfileHistory.section);
  const removed = new Map(
    purges.map((row) => [`${row.employmentId}:${row.section}`, asDate(row.at)])
  );

  const periods = await readRetentionPeriods(organizationId, tx);
  const holds = await readRetentionHolds(organizationId, employmentIds, tx);
  const { timezone } = config.quotaRollover;
  return new Map(
    rows.map((row) => {
      const sections = Object.fromEntries(
        SECTION_ROWS.map((section) => {
          const removedAt = removed.get(`${row.id}:${section}`) ?? null;
          return [
            section,
            {
              holds: row[`holds_${section}`] === true,
              dueAt: asDate(row[`due_${section}`]),
              untilErased: periods[section] === retentionPeriod.UntilErased,
              removedOn: removedAt && businessDateInZone(removedAt, timezone),
            },
          ];
        })
      ) as Record<SectionRow, SectionState>;
      return [row.id, { hold: holds.get(row.id) ?? null, sections }];
    })
  );
};

const sectionRetention = (
  state: SectionState,
  held: boolean,
  now: Date
): SectionRetention | null => {
  if (state.holds) {
    if (state.untilErased || state.dueAt === null) return { status: "KEPT_UNTIL_ERASED" };
    if (held) return { status: "ON_HOLD" };
    return { status: "REMOVES_ON", date: removalDay(state.dueAt, now, config.quotaRollover) };
  }
  if (state.removedOn !== null) return { status: "REMOVED_ON", date: state.removedOn };
  return state.untilErased ? { status: "KEPT_UNTIL_ERASED" } : null;
};

/** The Sections the viewer reads; Personal never on an External worker's record. */
const readableSections = (access: DirectoryAccess, external: boolean) =>
  SECTION_ROWS.filter(
    (section) =>
      access.sections[section] !== directoryPermissionValue.None &&
      !(external && section === directoryPermissionRow.Personal)
  );

/** The `retention` block of an ended profile. */
export const profileRetention = (
  schedule: RetentionSchedule,
  access: DirectoryAccess,
  external: boolean,
  now = new Date()
): ProfileRetention => {
  const sections: ProfileRetention["sections"] = {};
  for (const section of readableSections(access, external)) {
    const retention = sectionRetention(schedule.sections[section], schedule.hold !== null, now);
    if (retention) sections[SECTION_KEYS[section]] = retention;
  }
  return { hold: schedule.hold, sections };
};

/** The earliest coming removal among the Sections the viewer reads; null under a hold. */
export const nextRemoval = (
  schedule: RetentionSchedule,
  access: DirectoryAccess,
  external: boolean,
  now = new Date()
): { section: ProfileSectionKey; date: string } | null => {
  let next: { section: ProfileSectionKey; date: string } | null = null;
  for (const section of readableSections(access, external)) {
    const retention = sectionRetention(schedule.sections[section], schedule.hold !== null, now);
    if (retention?.status !== "REMOVES_ON") continue;
    if (next === null || retention.date < next.date) {
      next = { section: SECTION_KEYS[section], date: retention.date };
    }
  }
  return next;
};

export type RetentionSummary = {
  nextRemoval: { section: ProfileSectionKey; date: string } | null;
  hold: boolean;
};

/** What a list row shows of an ended record's Retention. */
export const retentionSummary = (
  schedule: RetentionSchedule | undefined,
  access: DirectoryAccess,
  external: boolean
): RetentionSummary => ({
  nextRemoval: schedule ? nextRemoval(schedule, access, external) : null,
  hold: schedule?.hold != null,
});

/** Each ended Employment's Retention summary as the owner or an org admin reads it, directory on or off. */
export const readEndedRetention = async (
  viewerUserId: string,
  organizationId: string,
  records: { id: string; userId: string | null; type: workerType; ended: boolean }[],
  tx?: DbTransaction
): Promise<Map<string, RetentionSummary>> => {
  const ended = records.filter((record) => record.ended);
  if (ended.length === 0) return new Map();
  const viewer = await loadDirectoryViewer(viewerUserId, organizationId, tx, { whileOff: true });
  const schedules = await readRetentionSchedules(
    organizationId,
    ended.map((record) => record.id),
    tx
  );
  return new Map(
    ended.map((record) => [
      record.id,
      retentionSummary(
        schedules.get(record.id),
        viewer.accessTo({ userId: record.userId, ended: true }),
        record.type === workerType.External
      ),
    ])
  );
};
