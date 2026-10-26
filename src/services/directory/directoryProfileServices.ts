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
import { directoryPhotos, directoryPhotoStatus } from "../../db/schema/directory-photo-schema.js";
import { employments, workerType } from "../../db/schema/employment-schema.js";
import { refuse } from "../../utils/appError.js";
import { buildUserSummary } from "../../utils/userPresentation.js";
import { getPersonContacts, personName, type PersonColumns } from "../person/personName.js";
import { countryView, phoneCountryDefault, phoneView } from "./contactFormat.js";
import { readDirectoryRoles } from "./directoryRoleServices.js";
import {
  administersOrganization,
  groupedUserIds,
  profileActions,
} from "./directoryEndingServices.js";
import { photoView, type ProfilePhotoView } from "./directoryPhotoServices.js";
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
        workEmail: directoryProfiles.workEmail,
        workPhone: directoryProfiles.workPhone,
        photoId: directoryPhotos.id,
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
      .leftJoin(
        directoryPhotos,
        and(
          eq(directoryPhotos.employmentId, employments.id),
          eq(directoryPhotos.status, directoryPhotoStatus.Ready)
        )
      )
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

/** The Profile photo's links, only for a viewer who reads the Photo Section. */
const photoOf = async (
  viewer: DirectoryViewer,
  row: RecordRow,
  access: DirectoryAccess
): Promise<ProfilePhotoView | null> => {
  if (row.photoId === null || access.sections[R.Photo] === V.None) return null;
  return (
    (await photoView({
      id: row.photoId,
      organizationId: viewer.organizationId,
      employmentId: row.id,
    })) ?? null
  );
};

const toPerson = (
  row: RecordRow,
  access: DirectoryAccess,
  photo: ProfilePhotoView | null
): DirectoryPerson => ({
  employmentId: row.id,
  name: row.name,
  jobTitle: row.jobTitle ?? null,
  image: row.image ?? null,
  photoUrl: photo?.smallUrl ?? null,
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

  const noGroupFilter = administersOrganization(viewer);
  const grouped = noGroupFilter ? await groupedUserIds(viewer.organizationId, tx) : null;
  const people: DirectoryPerson[] = [];
  for (const row of rows) {
    const access = accessFor(viewer, row);
    if (!access.inReach) continue;
    const person = toPerson(row, access, await photoOf(viewer, row, access));
    if (grouped) person.noGroup = row.userId === null || !grouped.has(row.userId);
    people.push(person);
  }
  return {
    people,
    formerList: viewer.formerList,
    settings: canReadPermissionTable(viewer),
    noGroupFilter,
  };
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
    former.push({
      ...toPerson(row, access, await photoOf(viewer, row, access)),
      startedAt: row.startedAt,
      endedAt: row.endedAt!,
    });
  }
  return former;
};

/** The name follows a bound, open account that was not deleted. */
export const nameFromAccount = (record: {
  userId: string | null;
  endedAt: Date | null;
  accountDeletedAt: Date | null;
}) => record.userId !== null && record.endedAt === null && record.accountDeletedAt === null;

/** Locations (T-501) will pass the record's Location country here. */
const phoneCountryView = (viewer: DirectoryViewer) => {
  const code = phoneCountryDefault({ locationCountry: null, language: viewer.language });
  return code === null ? null : countryView(code, viewer.language);
};

const sectionsOf = (
  viewer: DirectoryViewer,
  record: RecordRow,
  access: DirectoryAccess,
  photo: ProfilePhotoView | null
): DirectoryProfile["sections"] => {
  const view = (row: SectionRow): DirectorySectionView | undefined => {
    const level = access.sections[row];
    return level === V.None ? undefined : { level };
  };
  const card = view(R.Card);
  const job = view(R.Job);
  const workContact = view(R.WorkContact);
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
    photo: (() => {
      const section = view(R.Photo);
      return section && { ...section, photo };
    })(),
    workContact: workContact && {
      ...workContact,
      workEmail: record.workEmail ?? null,
      workPhone: record.workPhone ? phoneView(record.workPhone, viewer.language) : null,
      ...(access.sections[R.WorkContact] === V.Write && {
        phoneCountryDefault: phoneCountryView(viewer),
      }),
    },
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

  const photo = await photoOf(viewer, row, access);
  const profile: DirectoryProfile = {
    ...toPerson(row, access, photo),
    organizationId: viewer.organizationId,
    self: row.userId !== null && row.userId === viewer.standing.userId,
    ended: row.endedAt !== null,
    sections: sectionsOf(viewer, row, access, photo),
    canReadHistory: canReadHistory(viewer),
    actions: profileActions(viewer, row, access),
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
 * The Card, Work contact and Job fields of the given spells, keyed by Employment id, and
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
  workEmail: string | null;
  /** E.164. */
  workPhone: string | null;
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
      workEmail: directoryProfiles.workEmail,
      workPhone: directoryProfiles.workPhone,
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
        workEmail: fields.workEmail,
        workPhone: fields.workPhone,
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
