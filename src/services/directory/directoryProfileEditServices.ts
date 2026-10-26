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
import { assertDirectoryWritable } from "../billing/guards.js";
import { isCountryCode, parsePhone } from "./contactFormat.js";
import {
  EMPTY_CONTACT,
  EMPTY_PERSONAL,
  readSensitiveSection,
  writeSensitiveSections,
  type StoredContact,
  type StoredPersonal,
} from "./sensitiveSections.js";
import { organizationTimeZone } from "../organization/attendanceSettingsServices.js";
import { businessDateInZone } from "../../utils/dateFunc.js";
import { assertAssignableEntry } from "./directoryListServices.js";
import { revokeOpenEmploymentInvite } from "./directoryInviteServices.js";
import { assertEmploymentEmailFree } from "../employment/accountlessClash.js";
import { getPersonContacts } from "../person/personName.js";
import { getDirectoryProfile, nameFromAccount } from "./directoryProfileServices.js";
import { administersPeople, lockRecordInReach, type DirectoryViewer } from "./directoryViewer.js";
import { CARD_COLUMNS, JOB_COLUMNS, WORK_CONTACT_COLUMNS } from "./profileSectionFields.js";
import { recordProfileHistory } from "./profileHistory.js";
import type { SectionRow } from "./permissionResolver.js";
import type { DirectoryProfile, PatchDirectoryProfile, ProfileHistoryEntry } from "./types.js";

type ProfileRow = typeof directoryProfiles.$inferSelect;
type ProfileColumns = Omit<
  ProfileRow,
  "employmentId" | "organizationId" | "createdAt" | "updatedAt"
>;

const EMPTY: ProfileColumns = {
  jobTitle: null,
  reportsToEmploymentId: null,
  departmentId: null,
  locationId: null,
  legalName: null,
  employeeNumber: null,
  startDate: null,
  leavingDate: null,
  probationEndDate: null,
  contractType: null,
  workingTime: null,
  workEmail: null,
  workPhone: null,
};

const setsAValue = (patch: PatchDirectoryProfile) =>
  [patch.card, patch.workContact, patch.job, patch.contact, patch.personal].some(
    (section) =>
      section !== undefined &&
      Object.values(section).some((value) => value !== null && value !== undefined)
  );

type SensitivePatch = {
  contact?: Partial<StoredContact>;
  personal?: Partial<StoredPersonal>;
};

const EARLIEST_DATE_OF_BIRTH = "1900-01-01";

/** Parses phones, checks the country and the date of birth, and returns the values to store. */
const checkSensitivePatch = async (
  patch: PatchDirectoryProfile,
  organizationId: string,
  context: Record<string, unknown>,
  tx: DbTransaction
): Promise<SensitivePatch> => {
  const phoneOrRefuse = (input: string) => {
    const e164 = parsePhone(input);
    if (e164 === null) {
      throw refuse(422, "INVALID_PHONE", "That isn't a valid phone number", context);
    }
    return e164;
  };
  const result: SensitivePatch = {};

  if (patch.contact) {
    const contact: Partial<StoredContact> = {};
    const { privatePhone, privateEmail, emergencyContact1, emergencyContact2 } = patch.contact;
    if (privatePhone !== undefined) {
      contact.privatePhone = privatePhone === null ? null : phoneOrRefuse(privatePhone);
    }
    if (privateEmail !== undefined) contact.privateEmail = privateEmail;
    const slot = (entry: { name: string; phone: string } | null) =>
      entry === null ? null : { name: entry.name, phone: phoneOrRefuse(entry.phone) };
    if (emergencyContact1 !== undefined) contact.emergencyContact1 = slot(emergencyContact1);
    if (emergencyContact2 !== undefined) contact.emergencyContact2 = slot(emergencyContact2);
    result.contact = contact;
  }

  if (patch.personal) {
    const personal: Partial<StoredPersonal> = {};
    const { homeAddress, dateOfBirth } = patch.personal;
    if (homeAddress !== undefined) {
      if (homeAddress !== null && !isCountryCode(homeAddress.country)) {
        throw refuse(422, "INVALID_COUNTRY", "That isn't a country code", context);
      }
      const line = (value: string | null | undefined) => (value ? value : null);
      personal.homeAddress =
        homeAddress === null
          ? null
          : {
              line1: homeAddress.line1,
              line2: line(homeAddress.line2),
              postalCode: line(homeAddress.postalCode),
              city: homeAddress.city,
              region: line(homeAddress.region),
              country: homeAddress.country,
            };
    }
    if (dateOfBirth !== undefined) {
      if (dateOfBirth !== null) {
        const today = businessDateInZone(
          new Date(),
          await organizationTimeZone(organizationId, tx)
        );
        if (dateOfBirth < EARLIEST_DATE_OF_BIRTH || dateOfBirth > today) {
          throw refuse(
            422,
            "DATE_OF_BIRTH_OUT_OF_RANGE",
            "A date of birth lies between 1900-01-01 and today",
            context
          );
        }
      }
      personal.dateOfBirth = dateOfBirth;
    }
    result.personal = personal;
  }
  return result;
};

const changedKeys = (before: object, after: object) =>
  Object.keys(after).filter(
    (key) =>
      JSON.stringify(new Map(Object.entries(before)).get(key) ?? null) !==
      JSON.stringify(new Map(Object.entries(after)).get(key) ?? null)
  );

/** Merges the patch into the sealed Sections and returns the fields each one changed. */
const writeSensitivePatch = async (
  organizationId: string,
  employmentId: string,
  patch: SensitivePatch,
  tx: DbTransaction
): Promise<{ contact: string[]; personal: string[] }> => {
  const stored = await readSensitiveSection(organizationId, employmentId, tx);
  const before = {
    contact: stored.contact ?? EMPTY_CONTACT,
    personal: stored.personal ?? EMPTY_PERSONAL,
  };
  const after = {
    contact: { ...before.contact, ...patch.contact },
    personal: { ...before.personal, ...patch.personal },
  };
  const changes = {
    contact: changedKeys(before.contact, after.contact),
    personal: changedKeys(before.personal, after.personal),
  };
  if (changes.contact.length + changes.personal.length > 0) {
    await writeSensitiveSections(organizationId, employmentId, after, tx);
  }
  return changes;
};

/** Reports to names another open Employment of the organization, never another spell of the person. */
export const assertReportsTo = async (
  organizationId: string,
  record: { id: string; userId: string | null },
  reportsToEmploymentId: string,
  context: Record<string, unknown>,
  tx: DbTransaction
): Promise<void> => {
  const [manager] = await tx
    .select({ id: employments.id, userId: employments.userId })
    .from(employments)
    .where(
      and(
        eq(employments.organizationId, organizationId),
        eq(employments.id, reportsToEmploymentId),
        isNull(employments.endedAt)
      )
    );
  if (!manager) {
    throw refuse(422, "REPORTS_TO_NOT_FOUND", "Reports to must be an open Employment", context);
  }
  if (manager.id === record.id || (record.userId !== null && manager.userId === record.userId)) {
    throw refuse(422, "REPORTS_TO_SELF", "Nobody reports to themself", context);
  }
};

/**
 * Writes the Card, Work contact and Job fields of one profile, and the frozen or
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
  const { record, access, context } = await lockRecordInReach(viewer, employmentId, tx);

  const touched: [SectionRow, object | undefined][] = [
    [R.Card, patch.card],
    [R.WorkContact, patch.workContact],
    [R.Job, patch.job],
    [R.Contact, patch.contact],
    [R.Personal, patch.personal],
  ];
  for (const [row, section] of touched) {
    if (section !== undefined && access.sections[row] !== V.Write) {
      throw refuse(403, "SECTION_NOT_WRITABLE", "You can't edit this Section", { ...context, row });
    }
  }
  if (patch.card?.name !== undefined && nameFromAccount(record)) {
    throw refuse(403, "NAME_FROM_ACCOUNT", "The name follows the person's account", context);
  }
  if (patch.card?.email !== undefined && (record.userId !== null || record.endedAt !== null)) {
    throw refuse(
      422,
      "EMAIL_FROM_ACCOUNT",
      "Only an open record without an account takes an email here",
      context
    );
  }

  const workContact = { ...patch.workContact };
  if (workContact.workPhone) {
    const e164 = parsePhone(workContact.workPhone);
    if (e164 === null) {
      throw refuse(422, "INVALID_PHONE", "That isn't a valid phone number", context);
    }
    workContact.workPhone = e164;
  }

  if (patch.personal !== undefined && record.type === workerType.External) {
    throw refuse(422, "EMPLOYEES_ONLY", "The Personal Section applies to employees only", context);
  }
  const sensitivePatch =
    patch.contact === undefined && patch.personal === undefined
      ? undefined
      : await checkSensitivePatch(patch, organizationId, context, tx);

  if (setsAValue(patch)) await assertDirectoryWritable(organizationId, tx);

  const [stored] = await tx
    .select()
    .from(directoryProfiles)
    .where(eq(directoryProfiles.employmentId, employmentId));
  const before: ProfileColumns = stored ?? EMPTY;
  const { name, email, ...cardFields } = patch.card ?? {};
  const emailChanges = email !== undefined && email !== record.email;
  if (emailChanges && email !== null) {
    await assertEmploymentEmailFree(organizationId, email, context, tx, employmentId);
  }
  const after: ProfileColumns = { ...before };
  for (const [key, value] of Object.entries({ ...cardFields, ...workContact, ...patch.job })) {
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

  for (const [kind, key] of [
    ["departments", "departmentId"],
    ["locations", "locationId"],
  ] as const) {
    const entryId = after[key];
    if (entryId && entryId !== before[key]) {
      await assertAssignableEntry(kind, organizationId, entryId, context, tx);
    }
  }

  if (after.reportsToEmploymentId && after.reportsToEmploymentId !== before.reportsToEmploymentId) {
    await assertReportsTo(organizationId, record, after.reportsToEmploymentId, context, tx);
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
  const workContactChanges = changed(WORK_CONTACT_COLUMNS);
  const jobChanges = changed(JOB_COLUMNS);

  if (cardChanges.length + workContactChanges.length + jobChanges.length > 0) {
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

  if (emailChanges) {
    await tx.update(employments).set({ email }).where(eq(employments.id, employmentId));
    // The invite went to the old address, which no longer claims this record.
    await revokeOpenEmploymentInvite(employmentId, tx);
    cardChanges.push("email");
  }

  const sensitiveChanges = sensitivePatch
    ? await writeSensitivePatch(organizationId, employmentId, sensitivePatch, tx)
    : { contact: [], personal: [] };

  const history = (
    [
      [R.Card, cardChanges],
      [R.WorkContact, workContactChanges],
      [R.Job, jobChanges],
      [R.Contact, sensitiveChanges.contact],
      [R.Personal, sensitiveChanges.personal],
    ] as const
  )
    .filter(([, fields]) => fields.length > 0)
    .map(([row, fields]) => ({
      organizationId,
      employmentId,
      actorUserId: viewer.standing.userId,
      section: row,
      fields,
      audience: access.grantedBy[row]!,
    }));
  await recordProfileHistory(history, tx);

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
  if (!administersPeople(viewer)) {
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
    actor: row.actor,
    audience: row.audience,
  }));
};
