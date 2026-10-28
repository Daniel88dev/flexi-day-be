import { and, eq, inArray, isNotNull, or, sql, type SQL } from "drizzle-orm";
import { db, type DbTransaction } from "../../db/db.js";
import { directoryPhotos, directoryPhotoStatus } from "../../db/schema/directory-photo-schema.js";
import { directoryProfiles } from "../../db/schema/directory-profile-schema.js";
import {
  directoryRetentionHolds,
  directoryRetentionPeriods,
  retentionPeriod,
} from "../../db/schema/directory-retention-schema.js";
import { directoryPermissionRow } from "../../db/schema/directory-schema.js";
import { directorySensitiveProfiles } from "../../db/schema/directory-sensitive-profile-schema.js";
import { employments } from "../../db/schema/employment-schema.js";
import { logger } from "../../middleware/logger.js";
import { organizationDataStore } from "../organizationData/organizationDataStore.js";
import { employmentPhotosPrefix } from "./photoPrefixes.js";
import { SECTION_ROWS, type SectionRow } from "./permissionResolver.js";
import {
  CARD_COLUMNS,
  CONTACT_FIELDS,
  JOB_COLUMNS,
  PERSONAL_FIELDS,
  PHOTO_FIELDS,
  WORK_CONTACT_COLUMNS,
} from "./profileSectionFields.js";
import { recordProfileHistory, type ProfileHistoryInput } from "./profileHistory.js";
import { RETENTION_DEFAULTS, withDefaultPeriods } from "./retentionPeriods.js";

type Client = typeof db | DbTransaction;
type Cleared = { employmentId: string; organizationId: string };
type ProfileColumn = keyof typeof directoryProfiles.$inferSelect;

/** How a Section is told apart from an empty one, and emptied. Photo goes its own way. */
type ColumnSection = {
  fields: readonly string[];
  holdsData: SQL;
  clear: (employmentIds: string[], tx: DbTransaction) => Promise<Cleared[]>;
};

const profileSection = (columns: Record<string, string>): ColumnSection => {
  const keys = Object.keys(columns) as ProfileColumn[];
  const anyFilled = () => or(...keys.map((key) => isNotNull(directoryProfiles[key])))!;
  return {
    fields: Object.values(columns),
    holdsData: sql`exists (select 1 from ${directoryProfiles} where ${directoryProfiles.employmentId} = ${employments.id} and ${anyFilled()})`,
    clear: (employmentIds, tx) =>
      tx
        .update(directoryProfiles)
        .set({
          ...Object.fromEntries(keys.map((key) => [key, null])),
          updatedAt: new Date(),
        })
        .where(and(inArray(directoryProfiles.employmentId, employmentIds), anyFilled()))
        .returning({
          employmentId: directoryProfiles.employmentId,
          organizationId: directoryProfiles.organizationId,
        }),
  };
};

const sealedSection = (
  column: "contact" | "personal",
  fields: readonly string[]
): ColumnSection => {
  const sealed = directorySensitiveProfiles[column];
  return {
    fields,
    holdsData: sql`exists (select 1 from ${directorySensitiveProfiles} where ${directorySensitiveProfiles.employmentId} = ${employments.id} and ${sealed} is not null)`,
    // No cipher: clearing needs no key.
    clear: (employmentIds, tx) =>
      tx
        .update(directorySensitiveProfiles)
        .set({ [column]: null, updatedAt: new Date() })
        .where(
          and(inArray(directorySensitiveProfiles.employmentId, employmentIds), isNotNull(sealed))
        )
        .returning({
          employmentId: directorySensitiveProfiles.employmentId,
          organizationId: directorySensitiveProfiles.organizationId,
        }),
  };
};

const COLUMN_SECTIONS: Record<
  Exclude<SectionRow, typeof directoryPermissionRow.Photo>,
  ColumnSection
> = {
  [directoryPermissionRow.Card]: profileSection(CARD_COLUMNS),
  [directoryPermissionRow.WorkContact]: profileSection(WORK_CONTACT_COLUMNS),
  [directoryPermissionRow.Job]: profileSection(JOB_COLUMNS),
  [directoryPermissionRow.Contact]: sealedSection("contact", CONTACT_FIELDS),
  [directoryPermissionRow.Personal]: sealedSection("personal", PERSONAL_FIELDS),
};

const photoHoldsData = sql`exists (select 1 from ${directoryPhotos} where ${directoryPhotos.employmentId} = ${employments.id})`;

export const holdsData = (section: SectionRow): SQL =>
  section === directoryPermissionRow.Photo ? photoHoldsData : COLUMN_SECTIONS[section].holdsData;

const retentionHistory = (section: SectionRow, cleared: Cleared[]): ProfileHistoryInput[] =>
  cleared.map((row) => ({
    organizationId: row.organizationId,
    employmentId: row.employmentId,
    section,
    fields:
      section === directoryPermissionRow.Photo ? PHOTO_FIELDS : COLUMN_SECTIONS[section].fields,
    retention: true,
  }));

/** The later of the end date and the moment the ending was written. */
export const clockStart = sql`greatest(${employments.endedAt}, coalesce(${employments.endRecordedAt}, ${employments.endedAt}))`;

export const intervalOf = (period: SQL) => sql`(case ${period}
  when ${retentionPeriod.AtEnd} then interval '0'
  when ${retentionPeriod.Days30} then interval '30 days'
  when ${retentionPeriod.Months6} then interval '6 months'
  when ${retentionPeriod.Year1} then interval '1 year'
  when ${retentionPeriod.Years3} then interval '3 years'
  when ${retentionPeriod.Years5} then interval '5 years'
  when ${retentionPeriod.Years10} then interval '10 years'
end)`;

/** Until erased has no interval, so the comparison is null and never due. */
const dueBy = (period: SQL, at: Date) =>
  sql`${clockStart} + ${intervalOf(period)} <= ${at.toISOString()}::timestamptz`;

export const storedPeriod = (section: SectionRow) =>
  sql`coalesce((select ${directoryRetentionPeriods.period} from ${directoryRetentionPeriods} where ${directoryRetentionPeriods.organizationId} = ${employments.organizationId} and ${directoryRetentionPeriods.section} = ${section}), ${RETENTION_DEFAULTS[section]}::directory_retention_period)::text`;

const notHeld = sql`not exists (select 1 from ${directoryRetentionHolds} where ${directoryRetentionHolds.employmentId} = ${employments.id})`;

const dueEmployments = (client: Client, section: SectionRow, period: SQL, at: Date, where?: SQL) =>
  client
    .select({
      employmentId: employments.id,
      organizationId: employments.organizationId,
      userId: employments.userId,
      email: employments.email,
    })
    .from(employments)
    .where(
      and(isNotNull(employments.endedAt), notHeld, holdsData(section), dueBy(period, at), where)
    );

/**
 * How many people a Retention period would remove at the run at `at`: ended
 * Employments that still hold the Section and are past the period by then,
 * counted once per account, or per email for spells without one.
 */
export const countDueUnder = async (
  input: { organizationId: string; section: SectionRow; period: retentionPeriod; at: Date },
  tx?: DbTransaction
): Promise<number> => {
  const due = await dueEmployments(
    tx ?? db,
    input.section,
    sql`${input.period}::text`,
    input.at,
    eq(employments.organizationId, input.organizationId)
  );
  return new Set(
    due.map((row) => row.userId ?? `email:${row.email?.toLowerCase() ?? row.employmentId}`)
  ).size;
};

const purgePhotos = async (due: Cleared[]): Promise<number> => {
  let purged = 0;
  for (const row of due) {
    try {
      // Bytes first: a store failure leaves the rows, so the next night tries again.
      await organizationDataStore?.deletePrefix(
        employmentPhotosPrefix(row.organizationId, row.employmentId)
      );
    } catch (error) {
      logger.error("retention_purge.photo_delete_failed", {
        employmentId: row.employmentId,
        error,
      });
      continue;
    }
    purged += await db.transaction(async (tx) => {
      const removed = await tx
        .delete(directoryPhotos)
        .where(eq(directoryPhotos.employmentId, row.employmentId))
        .returning({ status: directoryPhotos.status });
      if (!removed.some((photo) => photo.status === directoryPhotoStatus.Ready)) return 0;
      await recordProfileHistory(retentionHistory(directoryPermissionRow.Photo, [row]), tx);
      return 1;
    });
  }
  return purged;
};

/**
 * The nightly Retention purge: every ended Employment whose Section is past
 * the organization's current Retention period has that Section emptied, with
 * a Profile history row naming the Section and `RETENTION`. No due date is
 * stored, so it can run any number of times. Never plan-gated and blind to the
 * directory toggle. Returns how many Sections it emptied.
 */
export const purgeRetention = async (now = new Date()): Promise<number> => {
  let purged = 0;
  for (const section of SECTION_ROWS) {
    const due = await dueEmployments(db, section, storedPeriod(section), now);
    if (due.length === 0) continue;
    if (section === directoryPermissionRow.Photo) {
      purged += await purgePhotos(due);
      continue;
    }
    purged += await db.transaction(async (tx) => {
      const cleared = await COLUMN_SECTIONS[section].clear(
        due.map((row) => row.employmentId),
        tx
      );
      if (cleared.length > 0) {
        await recordProfileHistory(retentionHistory(section, cleared), tx);
      }
      return cleared.length;
    });
  }
  return purged;
};

/** The organization's Retention periods, each Section it never set at the product default. */
export const readRetentionPeriods = async (organizationId: string, tx?: DbTransaction) =>
  withDefaultPeriods(
    await (tx ?? db)
      .select({
        section: directoryRetentionPeriods.section,
        period: directoryRetentionPeriods.period,
      })
      .from(directoryRetentionPeriods)
      .where(eq(directoryRetentionPeriods.organizationId, organizationId))
  );

/** The Sections set to "at end" that this Employment still holds, for the End dialog. */
export const atEndSectionsHeld = async (
  employment: { id: string; organizationId: string },
  tx?: DbTransaction
): Promise<SectionRow[]> => {
  const client = tx ?? db;
  const periods = await readRetentionPeriods(employment.organizationId, tx);
  const held: SectionRow[] = [];
  for (const section of SECTION_ROWS) {
    if (periods[section] !== retentionPeriod.AtEnd) continue;
    const [row] = await client
      .select({ id: employments.id })
      .from(employments)
      .where(and(eq(employments.id, employment.id), holdsData(section)));
    if (row) held.push(section);
  }
  return held;
};

/**
 * Empties the Sections set to "at end", inside the transaction that ends the
 * Employment. Returns the photo folders to delete after the commit. A caller
 * that can't delete them after its commit passes `keepPhoto`, and the next
 * nightly run takes the photo, bytes first.
 */
export const clearAtEndSections = async (
  employment: { id: string; organizationId: string },
  tx: DbTransaction,
  options: { keepPhoto?: boolean } = {}
): Promise<{ sections: SectionRow[]; photoPrefixes: string[] }> => {
  const periods = await readRetentionPeriods(employment.organizationId, tx);
  const sections: SectionRow[] = [];
  const photoPrefixes: string[] = [];
  const row = { employmentId: employment.id, organizationId: employment.organizationId };
  for (const section of SECTION_ROWS) {
    if (periods[section] !== retentionPeriod.AtEnd) continue;
    if (section === directoryPermissionRow.Photo) {
      if (options.keepPhoto) continue;
      const removed = await tx
        .delete(directoryPhotos)
        .where(eq(directoryPhotos.employmentId, employment.id))
        .returning({ status: directoryPhotos.status });
      if (removed.length > 0) {
        photoPrefixes.push(employmentPhotosPrefix(employment.organizationId, employment.id));
      }
      if (!removed.some((photo) => photo.status === directoryPhotoStatus.Ready)) continue;
      await recordProfileHistory(retentionHistory(section, [row]), tx);
      sections.push(section);
      continue;
    }
    const cleared = await COLUMN_SECTIONS[section].clear([employment.id], tx);
    if (cleared.length === 0) continue;
    await recordProfileHistory(retentionHistory(section, cleared), tx);
    sections.push(section);
  }
  return { sections, photoPrefixes };
};
