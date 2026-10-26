import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { alias, type AnyPgColumn } from "drizzle-orm/pg-core";
import { db, type DbTransaction } from "../../db/db.js";
import { user } from "../../db/schema/auth-schema.js";
import {
  contractType,
  directoryProfileHistory,
  directoryProfiles,
  workingTime,
} from "../../db/schema/directory-profile-schema.js";
import {
  directoryAudience,
  directoryPermissionRow as R,
  directoryPermissionValue as V,
} from "../../db/schema/directory-schema.js";
import { employments, workerType } from "../../db/schema/employment-schema.js";
import { refuse } from "../../utils/appError.js";
import { buildUserSummary } from "../../utils/userPresentation.js";
import { getPersonContacts, personName, type PersonColumns } from "../person/personName.js";
import { readDirectoryRoles } from "./directoryRoleServices.js";
import { canReadPermissionTable, type DirectoryViewer } from "./directoryViewer.js";
import type { DirectoryAccess, SectionRow } from "./permissionResolver.js";
import type {
  DirectoryMarker,
  DirectoryPeople,
  DirectoryPerson,
  DirectoryProfile,
  DirectorySectionView,
  FormerDirectoryPerson,
} from "./types.js";

const reportsTo = alias(employments, "reports_to");
const reportsToUser = alias(user, "reports_to_user");

/**
 * The name a record shows: the account's while it is bound, open and not
 * deleted, otherwise the Employment's own copy, which Card writers may edit.
 */
export const recordName = (
  employment: Record<"userId" | "endedAt" | "accountDeletedAt" | "name", AnyPgColumn>,
  person: PersonColumns,
  organizationId: string
) => sql<string>`case
  when ${employment.userId} is not null and ${employment.endedAt} is null
    and ${employment.accountDeletedAt} is null then ${personName(person, { organizationId })}
  else coalesce(${employment.name}, ${personName(person, { organizationId })}, '') end`;

const selectRecords = (organizationId: string, tx?: DbTransaction) => {
  const name = recordName(employments, user, organizationId);
  return {
    name,
    query: (tx ?? db)
      .select({
        id: employments.id,
        userId: employments.userId,
        type: employments.type,
        startedAt: employments.startedAt,
        endedAt: employments.endedAt,
        accountDeletedAt: employments.accountDeletedAt,
        email: employments.email,
        image: user.image,
        name,
        rejoined: sql<boolean>`exists (select 1 from employments later_spell
          where later_spell.organization_id = ${employments.organizationId}
            and later_spell.user_id = ${employments.userId}
            and later_spell.started_at > ${employments.startedAt})`,
        jobTitle: directoryProfiles.jobTitle,
        legalName: directoryProfiles.legalName,
        employeeNumber: directoryProfiles.employeeNumber,
        startDate: directoryProfiles.startDate,
        leavingDate: directoryProfiles.leavingDate,
        probationEndDate: directoryProfiles.probationEndDate,
        contractType: directoryProfiles.contractType,
        workingTime: directoryProfiles.workingTime,
        reportsToId: reportsTo.id,
        reportsToUserId: reportsTo.userId,
        reportsToEndedAt: reportsTo.endedAt,
        reportsToName: sql<
          string | null
        >`case when ${reportsTo.id} is null then null else ${recordName(
          reportsTo,
          reportsToUser,
          organizationId
        )} end`,
      })
      .from(employments)
      .leftJoin(user, eq(employments.userId, user.id))
      .leftJoin(directoryProfiles, eq(directoryProfiles.employmentId, employments.id))
      .leftJoin(reportsTo, eq(reportsTo.id, directoryProfiles.reportsToEmploymentId))
      .leftJoin(reportsToUser, eq(reportsToUser.id, reportsTo.userId))
      .$dynamic(),
  };
};

type RecordRow = Awaited<ReturnType<ReturnType<typeof selectRecords>["query"]["execute"]>>[number];

/** The owner, org admins and HR read a profile's history. */
export const canReadHistory = (viewer: DirectoryViewer) =>
  viewer.standing.owner ||
  viewer.standing.organizationAdmin ||
  viewer.standing.roles.includes("HR");

const accessFor = (viewer: DirectoryViewer, row: RecordRow) =>
  viewer.accessTo({ userId: row.userId, ended: row.endedAt !== null });

const markersOf = (row: RecordRow, access: DirectoryAccess): DirectoryMarker[] => {
  const markers: DirectoryMarker[] = [];
  if (row.type === workerType.External) markers.push("EXTERNAL_WORKER");
  if (!access.restrictedMarkers) return markers;
  if (row.userId === null) markers.push("NO_ACCOUNT");
  if (row.accountDeletedAt !== null) markers.push("ACCOUNT_DELETED");
  if (row.endedAt !== null && row.rejoined) markers.push("REJOINED");
  return markers;
};

const toPerson = (row: RecordRow, access: DirectoryAccess): DirectoryPerson => ({
  employmentId: row.id,
  name: row.name,
  jobTitle: row.jobTitle ?? null,
  image: row.image ?? null,
  user: buildUserSummary({ id: row.userId ?? row.id, name: row.name }),
  markers: markersOf(row, access),
});

/** The open Employments whose Card the viewer reads, by name. */
export const listDirectoryPeople = async (
  viewer: DirectoryViewer,
  tx?: DbTransaction
): Promise<DirectoryPeople> => {
  const { name, query } = selectRecords(viewer.organizationId, tx);
  const rows = await query
    .where(and(eq(employments.organizationId, viewer.organizationId), isNull(employments.endedAt)))
    .orderBy(asc(sql`lower(${name})`), asc(employments.id));

  const people: DirectoryPerson[] = [];
  for (const row of rows) {
    const access = accessFor(viewer, row);
    if (access.inReach) people.push(toPerson(row, access));
  }
  return { people, formerList: viewer.formerList, settings: canReadPermissionTable(viewer) };
};

/** One row per ended spell, latest end first. Owner, org admins and HR only. */
export const listFormerDirectoryPeople = async (
  viewer: DirectoryViewer,
  tx?: DbTransaction
): Promise<FormerDirectoryPerson[]> => {
  if (!viewer.formerList) {
    throw refuse(
      403,
      "FORMER_LIST_DENIED",
      "Only the owner, org admins and HR see the Former list",
      {
        organizationId: viewer.organizationId,
        viewerUserId: viewer.standing.userId,
      }
    );
  }
  const { query } = selectRecords(viewer.organizationId, tx);
  const rows = await query
    .where(
      and(eq(employments.organizationId, viewer.organizationId), isNotNull(employments.endedAt))
    )
    .orderBy(desc(employments.endedAt), asc(employments.id));

  const former: FormerDirectoryPerson[] = [];
  for (const row of rows) {
    const access = accessFor(viewer, row);
    if (!access.inReach) continue;
    former.push({ ...toPerson(row, access), startedAt: row.startedAt, endedAt: row.endedAt! });
  }
  return former;
};

/** The name follows a bound, open account that was not deleted. */
export const nameFromAccount = (record: {
  userId: string | null;
  endedAt: Date | null;
  accountDeletedAt: Date | null;
}) => record.userId !== null && record.endedAt === null && record.accountDeletedAt === null;

const sectionsOf = (
  viewer: DirectoryViewer,
  record: RecordRow,
  access: DirectoryAccess
): DirectoryProfile["sections"] => {
  const view = (row: SectionRow): DirectorySectionView | undefined => {
    const level = access.sections[row];
    return level === V.None ? undefined : { level };
  };
  const card = view(R.Card);
  const job = view(R.Job);
  const reachesManager =
    record.reportsToId !== null &&
    viewer.accessTo({ userId: record.reportsToUserId, ended: record.reportsToEndedAt !== null })
      .inReach;
  const sections: DirectoryProfile["sections"] = {
    card: card && {
      ...card,
      jobTitle: record.jobTitle ?? null,
      reportsTo:
        record.reportsToId === null
          ? null
          : {
              employmentId: record.reportsToId,
              name: reachesManager ? record.reportsToName : null,
            },
      nameFromAccount: nameFromAccount(record),
    },
    photo: view(R.Photo),
    workContact: view(R.WorkContact),
    job: job && {
      ...job,
      spell: { startedAt: record.startedAt, endedAt: record.endedAt },
      legalName: record.legalName ?? null,
      employeeNumber: record.employeeNumber ?? null,
      startDate: record.startDate ?? null,
      leavingDate: record.leavingDate ?? null,
      probationEndDate: record.probationEndDate ?? null,
      contractType: record.contractType ?? null,
      workingTime: record.workingTime ?? null,
    },
    contact: view(R.Contact),
    personal: view(R.Personal),
  };
  return Object.fromEntries(
    Object.entries(sections).filter(([, section]) => section !== undefined)
  );
};

/**
 * One profile, with only the Sections the viewer reads. 404 `PERSON_NOT_FOUND`
 * when the record belongs elsewhere or is out of the viewer's reach, so the
 * answer never says whether someone exists.
 */
export const getDirectoryProfile = async (
  viewer: DirectoryViewer,
  employmentId: string,
  tx?: DbTransaction
): Promise<DirectoryProfile> => {
  const { query } = selectRecords(viewer.organizationId, tx);
  const [row] = await query
    .where(
      and(eq(employments.organizationId, viewer.organizationId), eq(employments.id, employmentId))
    )
    .limit(1);
  const access = row ? accessFor(viewer, row) : undefined;
  if (!row || !access?.inReach) {
    throw refuse(404, "PERSON_NOT_FOUND", "Person not found", {
      organizationId: viewer.organizationId,
      employmentId,
      viewerUserId: viewer.standing.userId,
    });
  }

  const profile: DirectoryProfile = {
    ...toPerson(row, access),
    organizationId: viewer.organizationId,
    self: row.userId !== null && row.userId === viewer.standing.userId,
    ended: row.endedAt !== null,
    sections: sectionsOf(viewer, row, access),
    canReadHistory: canReadHistory(viewer),
  };
  if (access.accountFacts) {
    profile.account = {
      status:
        row.userId === null ? "NO_ACCOUNT" : row.accountDeletedAt !== null ? "DELETED" : "ACTIVE",
      signInEmail: row.email,
      directoryRoles: (await readDirectoryRoles([row.id], tx)).get(row.id) ?? [],
    };
  }
  return profile;
};

/**
 * The Card and Job fields of the given spells, keyed by Employment id, and
 * their profile history, oldest first, for the Person export. History rows
 * name the actor and the Audience and carry no values.
 */
export type ExportedProfile = {
  jobTitle: string | null;
  reportsTo: { employmentId: string; name: string | null } | null;
  legalName: string | null;
  employeeNumber: string | null;
  startDate: string | null;
  leavingDate: string | null;
  probationEndDate: string | null;
  contractType: contractType | null;
  workingTime: workingTime | null;
};

export type ExportedProfileHistoryEntry = {
  at: Date;
  employmentId: string;
  section: R;
  fields: string[];
  by: string | null;
  audience: directoryAudience;
};

export const collectProfileExport = async (
  organizationId: string,
  employmentIds: string[]
): Promise<{
  profiles: Map<string, ExportedProfile>;
  history: ExportedProfileHistoryEntry[];
}> => {
  if (employmentIds.length === 0) return { profiles: new Map(), history: [] };
  const rows = await db
    .select({
      employmentId: directoryProfiles.employmentId,
      jobTitle: directoryProfiles.jobTitle,
      reportsToId: directoryProfiles.reportsToEmploymentId,
      reportsToName: sql<
        string | null
      >`case when ${reportsTo.id} is null then null else ${recordName(
        reportsTo,
        reportsToUser,
        organizationId
      )} end`,
      legalName: directoryProfiles.legalName,
      employeeNumber: directoryProfiles.employeeNumber,
      startDate: directoryProfiles.startDate,
      leavingDate: directoryProfiles.leavingDate,
      probationEndDate: directoryProfiles.probationEndDate,
      contractType: directoryProfiles.contractType,
      workingTime: directoryProfiles.workingTime,
    })
    .from(directoryProfiles)
    .leftJoin(reportsTo, eq(reportsTo.id, directoryProfiles.reportsToEmploymentId))
    .leftJoin(reportsToUser, eq(reportsToUser.id, reportsTo.userId))
    .where(
      and(
        eq(directoryProfiles.organizationId, organizationId),
        inArray(directoryProfiles.employmentId, employmentIds)
      )
    );
  const profiles = new Map(
    rows.map(({ employmentId, reportsToId, reportsToName, ...fields }) => [
      employmentId,
      {
        jobTitle: fields.jobTitle,
        reportsTo: reportsToId === null ? null : { employmentId: reportsToId, name: reportsToName },
        legalName: fields.legalName,
        employeeNumber: fields.employeeNumber,
        startDate: fields.startDate,
        leavingDate: fields.leavingDate,
        probationEndDate: fields.probationEndDate,
        contractType: fields.contractType,
        workingTime: fields.workingTime,
      },
    ])
  );

  const entries = await db
    .select()
    .from(directoryProfileHistory)
    .where(
      and(
        eq(directoryProfileHistory.organizationId, organizationId),
        inArray(directoryProfileHistory.employmentId, employmentIds)
      )
    )
    .orderBy(asc(directoryProfileHistory.createdAt), asc(directoryProfileHistory.section));
  const actorIds = [
    ...new Set(entries.flatMap((row) => (row.actorUserId ? [row.actorUserId] : []))),
  ];
  const names = new Map(
    (await getPersonContacts(actorIds, { organizationId })).map((row) => [row.id, row.name])
  );
  const history = entries.map((row) => ({
    at: row.createdAt,
    employmentId: row.employmentId,
    section: row.section,
    fields: row.fields,
    by: row.actorUserId ? (names.get(row.actorUserId) ?? null) : null,
    audience: row.audience,
  }));
  return { profiles, history };
};
