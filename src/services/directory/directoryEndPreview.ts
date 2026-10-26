import { and, asc, count, eq, gt, inArray, isNull, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db, type DbTransaction } from "../../db/db.js";
import { user } from "../../db/schema/auth-schema.js";
import { directoryProfiles } from "../../db/schema/directory-profile-schema.js";
import { directoryPermissionRow as R } from "../../db/schema/directory-schema.js";
import { employments } from "../../db/schema/employment-schema.js";
import { groups } from "../../db/schema/group-schema.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
import { organizationUsers } from "../../db/schema/organization-users-schema.js";
import { vacation } from "../../db/schema/vacation-schema.js";
import { refuse } from "../../utils/appError.js";
import { businessDateInZone, type DateString } from "../../utils/dateFunc.js";
import { organizationTimeZone } from "../organization/attendanceSettingsServices.js";
import { profileActions } from "./directoryEndingServices.js";
import { recordName } from "./directoryProfileServices.js";
import { readDirectoryRoles } from "./directoryRoleServices.js";
import type { DirectoryViewer } from "./directoryViewer.js";
import type { SectionRow } from "./permissionResolver.js";
import { atEndSectionsHeld } from "./retentionPurge.js";

export type EndPreview = {
  employmentId: string;
  /** Today in the organization's zone: the latest date End accepts. */
  today: DateString;
  /** The spell's first day: the earliest date End accepts. */
  startedOn: DateString;
  /** The Leaving date when it is today or earlier, else today. */
  suggestedEndedOn: DateString;
  /** Open records whose Reports to names this person and will be cleared. */
  reportees: { employmentId: string; name: string }[];
  groups: { id: string; name: string }[];
  /** While any is listed, End is refused. */
  managedGroups: { id: string; name: string }[];
  /** Booked days that End cancels: pending ones and approved ones after today. */
  cancelledBookings: number;
  /** A delegated org-admin row End drops. */
  organizationAdmin: boolean;
  directoryRoles: ("HR" | "LEADERSHIP")[];
  /** Sections whose Retention period is "at end" and that hold something End empties. */
  atEndSections: SectionRow[];
};

const reportee = alias(employments, "reportee");
const reporteeUser = alias(user, "reportee_user");

/**
 * What ending this open Employment would do, for the End dialog. Only a
 * viewer whose End cell allows it (403 `END_DENIED`); 409 `EMPLOYMENT_ENDED`
 * once it has ended.
 */
export const endPreview = async (
  viewer: DirectoryViewer,
  employmentId: string,
  tx?: DbTransaction
): Promise<EndPreview> => {
  const client = tx ?? db;
  const { organizationId } = viewer;
  const context = { organizationId, employmentId, viewerUserId: viewer.standing.userId };
  const [record] = await client
    .select()
    .from(employments)
    .where(and(eq(employments.id, employmentId), eq(employments.organizationId, organizationId)));
  if (!record) throw refuse(404, "PERSON_NOT_FOUND", "Person not found", context);
  const access = viewer.accessTo({ userId: record.userId, ended: record.endedAt !== null });
  if (!profileActions(viewer, record, access).end) {
    if (record.endedAt !== null && access.acts[R.EndEmployment]) {
      throw refuse(409, "EMPLOYMENT_ENDED", "This employment has already ended", context);
    }
    throw refuse(403, "END_DENIED", "You may not end this employment", context);
  }

  const zone = await organizationTimeZone(organizationId, tx);
  const today = businessDateInZone(new Date(), zone);
  const [profile] = await client
    .select({ leavingDate: directoryProfiles.leavingDate })
    .from(directoryProfiles)
    .where(eq(directoryProfiles.employmentId, employmentId));
  const leavingDate = profile?.leavingDate ?? null;

  const reportees = await client
    .select({
      employmentId: reportee.id,
      name: recordName(reportee, reporteeUser, organizationId),
    })
    .from(directoryProfiles)
    .innerJoin(reportee, eq(reportee.id, directoryProfiles.employmentId))
    .leftJoin(reporteeUser, eq(reporteeUser.id, reportee.userId))
    .where(and(eq(directoryProfiles.reportsToEmploymentId, employmentId), isNull(reportee.endedAt)))
    .orderBy(asc(reportee.name), asc(reportee.id));

  const preview: EndPreview = {
    employmentId,
    today,
    startedOn: businessDateInZone(record.startedAt, zone),
    suggestedEndedOn: leavingDate !== null && leavingDate <= today ? leavingDate : today,
    reportees,
    groups: [],
    managedGroups: [],
    cancelledBookings: 0,
    organizationAdmin: false,
    directoryRoles: (await readDirectoryRoles([employmentId], tx)).get(employmentId) ?? [],
    atEndSections: await atEndSectionsHeld(record, tx),
  };
  const { userId } = record;
  if (userId === null) return preview;

  const liveGroups = and(eq(groups.organizationId, organizationId), isNull(groups.deletedAt));
  preview.groups = await client
    .selectDistinct({ id: groups.id, name: groups.groupName })
    .from(groupUsers)
    .innerJoin(groups, eq(groups.id, groupUsers.groupId))
    .where(and(liveGroups, eq(groupUsers.userId, userId), isNull(groupUsers.deletedAt)))
    .orderBy(asc(groups.groupName));
  preview.managedGroups = await client
    .select({ id: groups.id, name: groups.groupName })
    .from(groups)
    .where(and(liveGroups, eq(groups.managerUserId, userId)))
    .orderBy(asc(groups.groupName));

  const organizationGroupIds = client.select({ id: groups.id }).from(groups).where(liveGroups);
  // The same rows `cancelBookingsOnDeparture` cancels.
  const [bookings] = await client
    .select({ value: count() })
    .from(vacation)
    .where(
      and(
        eq(vacation.userId, userId),
        inArray(vacation.groupId, organizationGroupIds),
        isNull(vacation.deletedAt),
        isNull(vacation.rejectedAt),
        or(isNull(vacation.approvedAt), gt(vacation.requestedDay, today))
      )
    );
  preview.cancelledBookings = Number(bookings?.value ?? 0);

  const [grant] = await client
    .select({ id: organizationUsers.id })
    .from(organizationUsers)
    .where(
      and(
        eq(organizationUsers.organizationId, organizationId),
        eq(organizationUsers.userId, userId),
        isNull(organizationUsers.deletedAt)
      )
    )
    .limit(1);
  preview.organizationAdmin = grant !== undefined;
  return preview;
};
