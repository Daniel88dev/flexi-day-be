import { and, asc, desc, eq, isNull, ne, sql } from "drizzle-orm";
import { db, type DbTransaction } from "../../db/db.js";
import { user } from "../../db/schema/auth-schema.js";
import {
  directoryProfileHistory,
  directoryProfiles,
} from "../../db/schema/directory-profile-schema.js";
import {
  directoryPermissionRow as R,
  directoryPermissionValue as V,
} from "../../db/schema/directory-schema.js";
import { employments, workerType } from "../../db/schema/employment-schema.js";
import { refuse } from "../../utils/appError.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { assertDirectoryWritable } from "../billing/guards.js";
import { getPersonContacts } from "../person/personName.js";
import {
  canReadHistory,
  getDirectoryProfile,
  nameFromAccount,
} from "./directoryProfileServices.js";
import type { DirectoryViewer } from "./directoryViewer.js";
import type { SectionRow } from "./permissionResolver.js";
import type { DirectoryProfile, PatchDirectoryProfile, ProfileHistoryEntry } from "./types.js";

type ProfileRow = typeof directoryProfiles.$inferSelect;
type ProfileColumns = Omit<
  ProfileRow,
  "employmentId" | "organizationId" | "createdAt" | "updatedAt"
>;

/** Field names as the API and the profile history spell them, per Section. */
const CARD_COLUMNS = { jobTitle: "jobTitle", reportsToEmploymentId: "reportsTo" } as const;
const JOB_COLUMNS = {
  legalName: "legalName",
  employeeNumber: "employeeNumber",
  startDate: "startDate",
  leavingDate: "leavingDate",
  probationEndDate: "probationEndDate",
  contractType: "contractType",
  workingTime: "workingTime",
} as const;

const EMPTY: ProfileColumns = {
  jobTitle: null,
  reportsToEmploymentId: null,
  legalName: null,
  employeeNumber: null,
  startDate: null,
  leavingDate: null,
  probationEndDate: null,
  contractType: null,
  workingTime: null,
};

const setsAValue = (patch: PatchDirectoryProfile) =>
  [patch.card, patch.job].some(
    (section) =>
      section !== undefined &&
      Object.values(section).some((value) => value !== null && value !== undefined)
  );

/**
 * Writes the Card and Job fields of one profile, and the frozen or
 * account-less name, then records one profile history row per Section it
 * changed. A value needs the directory plan; a clear never does. Former
 * records stay editable for correction.
 */
export const updateDirectoryProfile = async (
  viewer: DirectoryViewer,
  employmentId: string,
  patch: PatchDirectoryProfile,
  tx: DbTransaction
): Promise<DirectoryProfile> => {
  const { organizationId } = viewer;
  const context = { organizationId, employmentId, viewerUserId: viewer.standing.userId };

  const [record] = await tx
    .select({
      id: employments.id,
      userId: employments.userId,
      type: employments.type,
      name: employments.name,
      endedAt: employments.endedAt,
      accountDeletedAt: employments.accountDeletedAt,
    })
    .from(employments)
    .where(and(eq(employments.organizationId, organizationId), eq(employments.id, employmentId)))
    .for("update");
  const access =
    record && viewer.accessTo({ userId: record.userId, ended: record.endedAt !== null });
  if (!record || !access?.inReach) {
    throw refuse(404, "PERSON_NOT_FOUND", "Person not found", context);
  }

  const touched: [SectionRow, object | undefined][] = [
    [R.Card, patch.card],
    [R.Job, patch.job],
  ];
  for (const [row, section] of touched) {
    if (section !== undefined && access.sections[row] !== V.Write) {
      throw refuse(403, "SECTION_NOT_WRITABLE", "You can't edit this Section", { ...context, row });
    }
  }
  if (patch.card?.name !== undefined && nameFromAccount(record)) {
    throw refuse(403, "NAME_FROM_ACCOUNT", "The name follows the person's account", context);
  }

  if (setsAValue(patch)) await assertDirectoryWritable(organizationId, tx);

  const [stored] = await tx
    .select()
    .from(directoryProfiles)
    .where(eq(directoryProfiles.employmentId, employmentId));
  const before: ProfileColumns = stored ?? EMPTY;
  const { name, ...cardFields } = patch.card ?? {};
  const after: ProfileColumns = { ...before };
  for (const [key, value] of Object.entries({ ...cardFields, ...patch.job })) {
    if (value !== undefined) (after as Record<string, unknown>)[key] = value;
  }

  const job = patch.job ?? {};
  if (
    record.type === workerType.External &&
    [job.contractType, job.workingTime, job.probationEndDate].some((value) => value != null)
  ) {
    throw refuse(
      422,
      "EMPLOYEES_ONLY",
      "Contract type, working time and probation end apply to employees only",
      context
    );
  }
  if (after.startDate && after.probationEndDate && after.probationEndDate < after.startDate) {
    throw refuse(422, "PROBATION_BEFORE_START", "Probation can't end before the start", context);
  }

  if (after.reportsToEmploymentId && after.reportsToEmploymentId !== before.reportsToEmploymentId) {
    const [manager] = await tx
      .select({ id: employments.id, userId: employments.userId })
      .from(employments)
      .where(
        and(
          eq(employments.organizationId, organizationId),
          eq(employments.id, after.reportsToEmploymentId),
          isNull(employments.endedAt)
        )
      );
    if (!manager) {
      throw refuse(422, "REPORTS_TO_NOT_FOUND", "Reports to must be an open Employment", context);
    }
    if (manager.id === record.id || (record.userId !== null && manager.userId === record.userId)) {
      throw refuse(422, "REPORTS_TO_SELF", "Nobody reports to themself", context);
    }
  }

  if (
    after.employeeNumber &&
    after.employeeNumber !== before.employeeNumber &&
    record.endedAt === null
  ) {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`employee-number:${organizationId}`}, 0))`
    );
    const [clash] = await tx
      .select({ id: directoryProfiles.employmentId })
      .from(directoryProfiles)
      .innerJoin(employments, eq(employments.id, directoryProfiles.employmentId))
      .where(
        and(
          eq(directoryProfiles.organizationId, organizationId),
          ne(directoryProfiles.employmentId, employmentId),
          isNull(employments.endedAt),
          sql`lower(${directoryProfiles.employeeNumber}) = lower(${after.employeeNumber})`
        )
      )
      .limit(1);
    if (clash) {
      throw refuse(
        409,
        "EMPLOYEE_NUMBER_TAKEN",
        "Another open Employment holds this employee number",
        context
      );
    }
  }

  const changed = (columns: Record<string, string>) =>
    Object.entries(columns)
      .filter(([column]) => {
        const key = column as keyof ProfileColumns;
        return before[key] !== after[key];
      })
      .map(([, field]) => field);
  const cardChanges = changed(CARD_COLUMNS);
  const jobChanges = changed(JOB_COLUMNS);

  if (cardChanges.length + jobChanges.length > 0) {
    await tx
      .insert(directoryProfiles)
      .values({ employmentId, organizationId, ...after })
      .onConflictDoUpdate({ target: directoryProfiles.employmentId, set: after });
  }

  if (name !== undefined && name !== record.name) {
    await tx.update(employments).set({ name }).where(eq(employments.id, employmentId));
    // The phone's users keyset runs on user.updated_at, so a Deleted account's new name reaches it.
    if (record.userId) {
      await tx.update(user).set({ updatedAt: new Date() }).where(eq(user.id, record.userId));
    }
    cardChanges.unshift("name");
  }

  const history = (
    [
      [R.Card, cardChanges],
      [R.Job, jobChanges],
    ] as const
  )
    .filter(([, fields]) => fields.length > 0)
    .map(([row, fields]) => ({
      id: generateRandomUUID(),
      organizationId,
      employmentId,
      actorUserId: viewer.standing.userId,
      section: row,
      fields: [...fields],
      audience: access.grantedBy[row]!,
    }));
  if (history.length > 0) await tx.insert(directoryProfileHistory).values(history);

  return getDirectoryProfile(viewer, employmentId, tx);
};

/**
 * A profile's history, newest first: who changed which fields of which
 * Section, and through which Audience. Never the values. The owner, org
 * admins and HR only.
 */
export const listProfileHistory = async (
  viewer: DirectoryViewer,
  employmentId: string,
  tx?: DbTransaction
): Promise<ProfileHistoryEntry[]> => {
  const context = {
    organizationId: viewer.organizationId,
    employmentId,
    viewerUserId: viewer.standing.userId,
  };
  if (!canReadHistory(viewer)) {
    throw refuse(
      403,
      "HISTORY_DENIED",
      "Only the owner, org admins and HR read profile history",
      context
    );
  }
  await getDirectoryProfile(viewer, employmentId, tx);

  const rows = await (tx ?? db)
    .select()
    .from(directoryProfileHistory)
    .where(
      and(
        eq(directoryProfileHistory.organizationId, viewer.organizationId),
        eq(directoryProfileHistory.employmentId, employmentId)
      )
    )
    .orderBy(desc(directoryProfileHistory.createdAt), asc(directoryProfileHistory.section));

  const actorIds = [...new Set(rows.flatMap((row) => (row.actorUserId ? [row.actorUserId] : [])))];
  const names = new Map(
    (await getPersonContacts(actorIds, { organizationId: viewer.organizationId }, tx)).map(
      (contact) => [contact.id, contact.name]
    )
  );
  return rows.map((row) => ({
    id: row.id,
    at: row.createdAt,
    actorName: row.actorUserId ? (names.get(row.actorUserId) ?? null) : null,
    section: row.section,
    fields: row.fields,
    audience: row.audience,
  }));
};
