import { and, asc, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { DbTransaction } from "../../db/db.js";
import {
  directoryPermissionRow,
  directoryPermissionValue,
} from "../../db/schema/directory-schema.js";
import { employments, workerType } from "../../db/schema/employment-schema.js";
import { refuse } from "../../utils/appError.js";
import { groupedUserIds } from "../employment/organizationLinks.js";
import { readRetentionSchedules, retentionSummary } from "./retentionSchedule.js";
import {
  administersOrganization,
  administersPeople,
  createPersonGrantor,
  type DirectoryViewer,
} from "./directoryViewer.js";
import type { DirectoryPeople, DirectoryPerson, FormerDirectoryPerson } from "./types.js";
import { accessFor, photoOf, selectRecords, toPerson } from "./directoryRecords.js";

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
    formerList: administersPeople(viewer),
    settings: administersPeople(viewer),
    noGroupFilter,
    addPerson: createPersonGrantor(viewer) !== null,
  };
};

/** One row per ended spell, latest end first. Owner, org admins and HR only. */
export const listFormerDirectoryPeople = async (
  viewer: DirectoryViewer,
  tx?: DbTransaction
): Promise<FormerDirectoryPerson[]> => {
  if (!administersPeople(viewer)) {
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

  const schedules = await readRetentionSchedules(
    viewer.organizationId,
    rows.map((row) => row.id),
    tx
  );
  const former: FormerDirectoryPerson[] = [];
  for (const row of rows) {
    const access = accessFor(viewer, row);
    if (!access.inReach) continue;
    const readsJob = access.sections[directoryPermissionRow.Job] !== directoryPermissionValue.None;
    former.push({
      ...toPerson(row, access, await photoOf(viewer, row, access)),
      startedAt: readsJob ? row.startedAt : null,
      endedAt: readsJob ? row.endedAt : null,
      ...retentionSummary(schedules.get(row.id), access, row.type === workerType.External),
    });
  }
  return former;
};
