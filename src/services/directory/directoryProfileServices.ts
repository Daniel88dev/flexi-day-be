import { and, asc, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { db, type DbTransaction } from "../../db/db.js";
import { user } from "../../db/schema/auth-schema.js";
import {
  directoryPermissionRow as R,
  directoryPermissionValue as V,
} from "../../db/schema/directory-schema.js";
import { employments, workerType } from "../../db/schema/employment-schema.js";
import { refuse } from "../../utils/appError.js";
import { buildUserSummary } from "../../utils/userPresentation.js";
import { personName } from "../person/personName.js";
import type { DirectoryViewer } from "./directoryViewer.js";
import type { DirectoryAccess, SectionRow } from "./permissionResolver.js";
import type {
  DirectoryMarker,
  DirectoryPeople,
  DirectoryPerson,
  DirectoryProfile,
  DirectorySectionView,
  FormerDirectoryPerson,
} from "./types.js";

const selectRecords = (organizationId: string, tx?: DbTransaction) => {
  const name = sql<string>`coalesce(${personName(user, { organizationId })}, ${employments.name}, '')`;
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
      })
      .from(employments)
      .leftJoin(user, eq(employments.userId, user.id))
      .$dynamic(),
  };
};

type RecordRow = Awaited<ReturnType<ReturnType<typeof selectRecords>["query"]["execute"]>>[number];

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
  return { people, formerList: viewer.formerList };
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

const sectionsOf = (record: RecordRow, access: DirectoryAccess): DirectoryProfile["sections"] => {
  const view = (row: SectionRow): DirectorySectionView | undefined => {
    const level = access.sections[row];
    return level === V.None ? undefined : { level };
  };
  const job = view(R.Job);
  const sections: DirectoryProfile["sections"] = {
    card: view(R.Card),
    photo: view(R.Photo),
    workContact: view(R.WorkContact),
    job: job && { ...job, spell: { startedAt: record.startedAt, endedAt: record.endedAt } },
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
    sections: sectionsOf(row, access),
  };
  if (access.accountFacts) {
    profile.account = {
      status:
        row.userId === null ? "NO_ACCOUNT" : row.accountDeletedAt !== null ? "DELETED" : "ACTIVE",
      signInEmail: row.email,
      directoryRoles: [],
    };
  }
  return profile;
};
