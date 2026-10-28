import { and, asc, desc, eq, isNull, ne, sql } from "drizzle-orm";
import { db, type DbTransaction } from "../../db/db.js";
import { user } from "../../db/schema/auth-schema.js";
import {
  directoryProfileHistory,
  directoryProfiles,
} from "../../db/schema/directory-profile-schema.js";
import {
  directoryPermissionRow,
  directoryPermissionValue,
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
import { getActorNames } from "../person/personName.js";
import { getDirectoryProfile } from "./directoryProfileServices.js";
import { isBoundEmployment } from "../employment/boundEmployment.js";
import { administersPeople, lockRecordInReach, type DirectoryViewer } from "./directoryViewer.js";
import {
  CARD_COLUMNS,
  employeesOnly,
  JOB_COLUMNS,
  PERSONAL_EMPLOYEES_ONLY,
  WORK_CONTACT_COLUMNS,
} from "./profileSectionFields.js";
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

type LockedRecord = Awaited<ReturnType<typeof lockRecordInReach>>["record"];
type RecordAccess = Awaited<ReturnType<typeof lockRecordInReach>>["access"];
type Context = Record<string, unknown>;
type ColumnChange = { before: ProfileColumns; after: ProfileColumns };

/** Refuses a patch the viewer may not make on this record, before any value is looked at. */
const assertPatchAllowed = (
  record: LockedRecord,
  access: RecordAccess,
  patch: PatchDirectoryProfile,
  context: Context
) => {
  const touched: [SectionRow, object | undefined][] = [
    [directoryPermissionRow.Card, patch.card],
    [directoryPermissionRow.WorkContact, patch.workContact],
    [directoryPermissionRow.Job, patch.job],
    [directoryPermissionRow.Contact, patch.contact],
    [directoryPermissionRow.Personal, patch.personal],
  ];
  for (const [row, section] of touched) {
    if (section !== undefined && access.sections[row] !== directoryPermissionValue.Write) {
      throw refuse(403, "SECTION_NOT_WRITABLE", "You can't edit this Section", { ...context, row });
    }
  }
  if (patch.card?.name !== undefined && isBoundEmployment(record)) {
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
};

/** The Work contact patch with its phone in E.164. */
const normalizedWorkContact = (
  input: PatchDirectoryProfile["workContact"],
  context: Context
): NonNullable<PatchDirectoryProfile["workContact"]> => {
  const workContact = { ...input };
  if (workContact.workPhone) {
    const e164 = parsePhone(workContact.workPhone);
    if (e164 === null) {
      throw refuse(422, "INVALID_PHONE", "That isn't a valid phone number", context);
    }
    workContact.workPhone = e164;
  }
  return workContact;
};

const readProfileColumns = async (
  employmentId: string,
  tx: DbTransaction
): Promise<ProfileColumns> => {
  const [stored] = await tx
    .select()
    .from(directoryProfiles)
    .where(eq(directoryProfiles.employmentId, employmentId));
  return stored ?? EMPTY;
};

const mergedColumns = (before: ProfileColumns, patch: object): ProfileColumns => {
  const after: ProfileColumns = { ...before };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) (after as Record<string, unknown>)[key] = value;
  }
  return after;
};

/** An open record's employee number is unique in the organization, ignoring case. */
const assertEmployeeNumberFree = async (
  organizationId: string,
  employmentId: string,
  employeeNumber: string,
  context: Context,
  tx: DbTransaction
) => {
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
        sql`lower(${directoryProfiles.employeeNumber}) = lower(${employeeNumber})`
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
};

/** Checks the Card, Work contact and Job values the patch leaves the record with. */
const assertProfileColumns = async (
  organizationId: string,
  record: LockedRecord,
  { before, after }: ColumnChange,
  job: NonNullable<PatchDirectoryProfile["job"]>,
  context: Context,
  tx: DbTransaction
) => {
  if (
    record.type === workerType.External &&
    [job.contractType, job.workingTime, job.probationEndDate].some((value) => value != null)
  ) {
    throw employeesOnly(
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
    await assertEmployeeNumberFree(organizationId, record.id, after.employeeNumber, context, tx);
  }
};

/** Stores the profile columns when any changed, and returns the fields changed per Section. */
const writeProfileColumns = async (
  organizationId: string,
  employmentId: string,
  { before, after }: ColumnChange,
  tx: DbTransaction
) => {
  const changed = (columns: Record<string, string>) =>
    Object.entries(columns)
      .filter(([column]) => {
        const key = column as keyof ProfileColumns;
        return before[key] !== after[key];
      })
      .map(([, field]) => field);
  const changes = {
    card: changed(CARD_COLUMNS),
    workContact: changed(WORK_CONTACT_COLUMNS),
    job: changed(JOB_COLUMNS),
  };
  if (changes.card.length + changes.workContact.length + changes.job.length > 0) {
    await tx
      .insert(directoryProfiles)
      .values({ employmentId, organizationId, ...after })
      .onConflictDoUpdate({ target: directoryProfiles.employmentId, set: after });
  }
  return changes;
};

/**
 * Writes the record's own name copy and a new email, and says which of the
 * two changed. `email` is undefined unless it differs from the stored one.
 */
const writeRecordNameAndEmail = async (
  record: LockedRecord,
  { name, email }: { name: string | undefined; email: string | null | undefined },
  tx: DbTransaction
): Promise<{ name: boolean; email: boolean }> => {
  const changed = { name: false, email: false };
  if (name !== undefined && name !== record.name) {
    await tx.update(employments).set({ name }).where(eq(employments.id, record.id));
    // The phone's users keyset runs on user.updated_at, so a Deleted account's new name reaches it.
    if (record.userId) {
      await tx.update(user).set({ updatedAt: new Date() }).where(eq(user.id, record.userId));
    }
    changed.name = true;
  }
  if (email !== undefined) {
    await tx.update(employments).set({ email }).where(eq(employments.id, record.id));
    // The invite went to the old address, which no longer claims this record.
    await revokeOpenEmploymentInvite(record.id, tx);
    changed.email = true;
  }
  return changed;
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

  assertPatchAllowed(record, access, patch, context);
  const workContact = normalizedWorkContact(patch.workContact, context);
  if (patch.personal !== undefined && record.type === workerType.External) {
    throw employeesOnly(PERSONAL_EMPLOYEES_ONLY, context);
  }
  const sensitivePatch =
    patch.contact === undefined && patch.personal === undefined
      ? undefined
      : await checkSensitivePatch(patch, organizationId, context, tx);
  if (setsAValue(patch)) await assertDirectoryWritable(organizationId, tx);

  const before = await readProfileColumns(employmentId, tx);
  const { name, email, ...cardFields } = patch.card ?? {};
  const newEmail = email !== record.email ? email : undefined;
  if (newEmail !== undefined && newEmail !== null) {
    await assertEmploymentEmailFree(organizationId, newEmail, context, tx, employmentId);
  }
  const after = mergedColumns(before, { ...cardFields, ...workContact, ...patch.job });
  await assertProfileColumns(
    organizationId,
    record,
    { before, after },
    patch.job ?? {},
    context,
    tx
  );

  const columnChanges = await writeProfileColumns(
    organizationId,
    employmentId,
    { before, after },
    tx
  );
  const identity = await writeRecordNameAndEmail(record, { name, email: newEmail }, tx);
  const sensitiveChanges = sensitivePatch
    ? await writeSensitivePatch(organizationId, employmentId, sensitivePatch, tx)
    : { contact: [], personal: [] };

  const history = (
    [
      [
        directoryPermissionRow.Card,
        [
          ...(identity.name ? ["name"] : []),
          ...columnChanges.card,
          ...(identity.email ? ["email"] : []),
        ],
      ],
      [directoryPermissionRow.WorkContact, columnChanges.workContact],
      [directoryPermissionRow.Job, columnChanges.job],
      [directoryPermissionRow.Contact, sensitiveChanges.contact],
      [directoryPermissionRow.Personal, sensitiveChanges.personal],
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

  const actorName = await getActorNames(
    rows.map((row) => row.actorUserId),
    { organizationId: viewer.organizationId },
    tx
  );
  return rows.map((row) => ({
    id: row.id,
    at: row.createdAt,
    actorName: actorName(row.actorUserId),
    section: row.section,
    fields: row.fields,
    actor: row.actor,
    audience: row.audience,
  }));
};
