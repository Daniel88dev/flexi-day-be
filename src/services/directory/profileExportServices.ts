import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "../../db/db.js";
import {
  contractType,
  directoryProfileHistory,
  directoryProfiles,
  profileHistoryActor,
  workingTime,
} from "../../db/schema/directory-profile-schema.js";
import { directoryAudience, directoryPermissionRow } from "../../db/schema/directory-schema.js";
import { directoryDepartments, directoryLocations } from "../../db/schema/directory-list-schema.js";
import { getActorNames } from "../person/personName.js";
import { reportsTo, reportsToName, reportsToUser } from "./recordName.js";

/**
 * The Card, Work contact and Job fields of the given spells, keyed by Employment id, and
 * their profile history, oldest first, for the Person export. History rows
 * name the actor and the Audience and carry no values.
 */
export type ExportedProfile = {
  jobTitle: string | null;
  department: string | null;
  location: string | null;
  reportsTo: { employmentId: string; name: string | null } | null;
  legalName: string | null;
  employeeNumber: string | null;
  startDate: string | null;
  leavingDate: string | null;
  probationEndDate: string | null;
  contractType: contractType | null;
  workingTime: workingTime | null;
  workEmail: string | null;
  workPhone: string | null;
};

export type ExportedProfileHistoryEntry = {
  at: Date;
  employmentId: string;
  section: directoryPermissionRow;
  fields: string[];
  by: string | null;
  actor: profileHistoryActor;
  audience: directoryAudience | null;
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
      department: directoryDepartments.name,
      location: directoryLocations.name,
      reportsToId: directoryProfiles.reportsToEmploymentId,
      reportsToName: reportsToName(organizationId),
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
    .leftJoin(directoryDepartments, eq(directoryDepartments.id, directoryProfiles.departmentId))
    .leftJoin(directoryLocations, eq(directoryLocations.id, directoryProfiles.locationId))
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
        department: fields.department,
        location: fields.location,
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
  const actorName = await getActorNames(
    entries.map((row) => row.actorUserId),
    { organizationId }
  );
  const history = entries.map((row) => ({
    at: row.createdAt,
    employmentId: row.employmentId,
    section: row.section,
    fields: row.fields,
    by: actorName(row.actorUserId),
    actor: row.actor,
    audience: row.audience,
  }));
  return { profiles, history };
};
