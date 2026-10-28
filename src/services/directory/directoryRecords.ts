import { and, eq, sql } from "drizzle-orm";
import { db, type DbTransaction } from "../../db/db.js";
import { user } from "../../db/schema/auth-schema.js";
import { directoryProfiles } from "../../db/schema/directory-profile-schema.js";
import {
  directoryPermissionRow,
  directoryPermissionValue,
} from "../../db/schema/directory-schema.js";
import { directoryPhotos, directoryPhotoStatus } from "../../db/schema/directory-photo-schema.js";
import { directoryDepartments, directoryLocations } from "../../db/schema/directory-list-schema.js";
import { employments, workerType } from "../../db/schema/employment-schema.js";
import { buildUserSummary } from "../../utils/userPresentation.js";
import { photoView, type ProfilePhotoView } from "./directoryPhotoServices.js";
import type { DirectoryViewer } from "./directoryViewer.js";
import type { DirectoryAccess } from "./permissionResolver.js";
import type { DirectoryEntryRef, DirectoryMarker, DirectoryPerson } from "./types.js";
import { recordName, reportsTo, reportsToName, reportsToUser } from "./recordName.js";

export const selectRecords = (organizationId: string, tx?: DbTransaction) => {
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
        inviteSent: sql<boolean>`exists (select 1 from invite_link open_invite
          where open_invite.employment_id = ${employments.id}
            and open_invite.used_at is null and open_invite.revoked_at is null
            and open_invite.expires_at > now())`,
        jobTitle: directoryProfiles.jobTitle,
        departmentId: directoryDepartments.id,
        departmentName: directoryDepartments.name,
        departmentArchivedAt: directoryDepartments.archivedAt,
        locationId: directoryLocations.id,
        locationName: directoryLocations.name,
        locationArchivedAt: directoryLocations.archivedAt,
        locationCountry: directoryLocations.country,
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
        reportsToName: reportsToName(organizationId),
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
      .leftJoin(directoryDepartments, eq(directoryDepartments.id, directoryProfiles.departmentId))
      .leftJoin(directoryLocations, eq(directoryLocations.id, directoryProfiles.locationId))
      .$dynamic(),
  };
};

export type RecordRow = Awaited<
  ReturnType<ReturnType<typeof selectRecords>["query"]["execute"]>
>[number];

export const accessFor = (viewer: DirectoryViewer, row: RecordRow) =>
  viewer.accessTo({ userId: row.userId, ended: row.endedAt !== null });

export const markersOf = (row: RecordRow, access: DirectoryAccess): DirectoryMarker[] => {
  const markers: DirectoryMarker[] = [];
  if (row.type === workerType.External) markers.push("EXTERNAL_WORKER");
  if (!access.restrictedMarkers) return markers;
  if (row.userId === null) markers.push("NO_ACCOUNT");
  if (row.accountDeletedAt !== null) markers.push("ACCOUNT_DELETED");
  if (row.endedAt !== null && row.rejoined) markers.push("REJOINED");
  if (row.userId === null && row.endedAt === null && row.inviteSent) markers.push("INVITE_SENT");
  return markers;
};

/** The Profile photo's links, only for a viewer who reads the Photo Section. */
export const photoOf = async (
  viewer: DirectoryViewer,
  row: RecordRow,
  access: DirectoryAccess
): Promise<ProfilePhotoView | null> => {
  if (
    row.photoId === null ||
    access.sections[directoryPermissionRow.Photo] === directoryPermissionValue.None
  )
    return null;
  return (
    (await photoView({
      id: row.photoId,
      organizationId: viewer.organizationId,
      employmentId: row.id,
    })) ?? null
  );
};

const entryRef = (
  id: string | null,
  name: string | null,
  archivedAt: Date | null
): DirectoryEntryRef | null =>
  id === null ? null : { id, name: name ?? "", archived: archivedAt !== null };

export const departmentOf = (row: RecordRow) =>
  entryRef(row.departmentId, row.departmentName, row.departmentArchivedAt);
export const locationOf = (row: RecordRow) =>
  entryRef(row.locationId, row.locationName, row.locationArchivedAt);

export const toPerson = (
  row: RecordRow,
  access: DirectoryAccess,
  photo: ProfilePhotoView | null
): DirectoryPerson => ({
  employmentId: row.id,
  name: row.name,
  jobTitle: row.jobTitle ?? null,
  department: departmentOf(row),
  location: locationOf(row),
  image: row.image ?? null,
  photoUrl: photo?.smallUrl ?? null,
  user: { ...buildUserSummary({ id: row.userId ?? row.id, name: row.name }), id: row.userId },
  markers: markersOf(row, access),
});
