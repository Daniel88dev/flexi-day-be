import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { DbTransaction } from "../../db/db.js";
import { employments } from "../../db/schema/employment-schema.js";
import { groups } from "../../db/schema/group-schema.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
import { organizationUsers } from "../../db/schema/organization-users-schema.js";
import { refuse } from "../../utils/appError.js";
import { businessDateInZone, type DateString } from "../../utils/dateFunc.js";
import { organizationTimeZone } from "../organization/attendanceSettingsServices.js";
import { isOrganizationAdmin, lockOrganization } from "../organization/organizationServices.js";
import {
  cancelBookingsOnDeparture,
  EMPLOYMENT_ENDED_REASON,
} from "../vacation/departureCancellation.js";
import type { VacationType } from "../vacation/types.js";
import type { EmploymentType } from "./types.js";
import { roleChangeReason } from "../../db/schema/directory-role-schema.js";
import { endDirectoryRoles } from "../directory/directoryRoleServices.js";
import { isDirectoryOrganization } from "../directory/directorySettingsServices.js";
import { loadDirectoryViewer } from "../directory/directoryViewer.js";
import {
  directoryProfileHistory,
  directoryProfiles,
} from "../../db/schema/directory-profile-schema.js";
import { directoryAudience, directoryPermissionRow } from "../../db/schema/directory-schema.js";
import { organizations } from "../../db/schema/organization-schema.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { clearAtEndSections } from "../directory/retentionPurge.js";

/**
 * The shared opening of End employment and Erase: 404 for no such row, 403
 * unless the actor administers its organization, then the organization lock
 * and the row `FOR UPDATE`. Every path that adds someone to the organization
 * takes the same lock, so no membership lands between the caller's reads and
 * its writes.
 */
export const lockEmploymentForAdmin = async (
  input: { employmentId: string; actorUserId: string },
  tx: DbTransaction
): Promise<typeof employments.$inferSelect> => {
  const context = { userId: input.actorUserId, employmentId: input.employmentId };

  const [found] = await tx
    .select({ organizationId: employments.organizationId })
    .from(employments)
    .where(eq(employments.id, input.employmentId));
  if (!found) throw refuse(404, "NOT_FOUND", "Employment not found", context);

  if (!(await isOrganizationAdmin(input.actorUserId, found.organizationId, tx))) {
    throw refuse(403, "FORBIDDEN", "No permission for related organization", context);
  }

  await lockOrganization(found.organizationId, tx);
  const [employment] = await tx
    .select()
    .from(employments)
    .where(eq(employments.id, input.employmentId))
    .for("update");
  if (!employment) throw refuse(404, "NOT_FOUND", "Employment not found", context);
  return employment;
};

/**
 * Who may end this Employment, and through which Audience. In a Directory
 * organization the End act cell decides (Owner, HR and Org admin by default),
 * on any plan; elsewhere the owner and org admins. 403 otherwise.
 */
const authorizeEnd = async (
  actorUserId: string,
  employment: Pick<EmploymentType, "id" | "organizationId" | "userId" | "endedAt">,
  tx: DbTransaction
): Promise<directoryAudience> => {
  const { organizationId } = employment;
  const context = { userId: actorUserId, employmentId: employment.id };
  const forbidden = () => refuse(403, "FORBIDDEN", "No permission to end this employment", context);

  if (await isDirectoryOrganization(organizationId, tx)) {
    const viewer = await loadDirectoryViewer(actorUserId, organizationId, tx).catch(() => {
      throw forbidden();
    });
    const access = viewer.accessTo({
      userId: employment.userId,
      ended: employment.endedAt !== null,
    });
    const audience = access.actGrantedBy[directoryPermissionRow.EndEmployment];
    if (!audience) throw forbidden();
    return audience;
  }

  if (!(await isOrganizationAdmin(actorUserId, organizationId, tx))) throw forbidden();
  return adminAudience(actorUserId, organizationId, tx);
};

/** The Audience an owner or org admin acts through, for the Profile history. */
export const adminAudience = async (
  actorUserId: string,
  organizationId: string,
  tx: DbTransaction
): Promise<directoryAudience> => {
  const [organization] = await tx
    .select({ ownerUserId: organizations.ownerUserId })
    .from(organizations)
    .where(eq(organizations.id, organizationId));
  return organization?.ownerUserId === actorUserId
    ? directoryAudience.Owner
    : directoryAudience.OrganizationAdmin;
};

export type EndedEmployment = {
  employment: EmploymentType;
  cancelled: VacationType[];
  /** Photo folders an "at end" Photo Section left behind, to delete after the commit. */
  photoPrefixes: string[];
};

/**
 * End employment: the person leaves every group of the organization, loses a
 * delegated admin row and their Directory roles, has pending requests and
 * bookings after today cancelled, open records stop naming them in Reports
 * to, Sections whose Retention period is "at end" are emptied, and the
 * Employment ends on `endedOn` (today or earlier, in the
 * organization's time zone). Never plan-gated. A live account, a Deleted
 * account and a person without an account end the same way; the owner's own
 * Employment can't, because owning the organization is a link End can't
 * remove.
 *
 * Runs no `syncEmployment`: it would end the row at `now()` instead of on the
 * chosen date.
 */
export const endEmployment = async (
  input: { employmentId: string; endedOn: DateString; actorUserId: string },
  tx: DbTransaction
): Promise<EndedEmployment> => {
  const context = { userId: input.actorUserId, employmentId: input.employmentId };
  const [found] = await tx.select().from(employments).where(eq(employments.id, input.employmentId));
  if (!found) throw refuse(404, "NOT_FOUND", "Employment not found", context);
  const audience = await authorizeEnd(input.actorUserId, found, tx);

  await lockOrganization(found.organizationId, tx);
  const [employment] = await tx
    .select()
    .from(employments)
    .where(eq(employments.id, input.employmentId))
    .for("update");
  if (!employment) throw refuse(404, "NOT_FOUND", "Employment not found", context);

  return endLockedEmployment(
    employment,
    { endedOn: input.endedOn, actorUserId: input.actorUserId, audience },
    tx
  );
};

/**
 * The ending itself, for a caller that already holds the organization lock
 * and the row `FOR UPDATE` and has authorized the actor: End employment, and
 * Erase before it deletes.
 */
export const endLockedEmployment = async (
  employment: EmploymentType,
  input: { endedOn: DateString; actorUserId: string; audience: directoryAudience },
  tx: DbTransaction
): Promise<EndedEmployment> => {
  const context = { userId: input.actorUserId, employmentId: employment.id };
  const { organizationId, userId } = employment;

  if (employment.endedAt !== null) {
    throw refuse(409, "EMPLOYMENT_ENDED", "This employment has already ended", context);
  }

  const timeZone = await organizationTimeZone(organizationId, tx);
  const today = businessDateInZone(new Date(), timeZone);
  if (input.endedOn > today) {
    throw refuse(422, "END_DATE_IN_FUTURE", "The end date cannot be in the future", context);
  }
  if (input.endedOn < businessDateInZone(employment.startedAt, timeZone)) {
    throw refuse(
      422,
      "END_DATE_BEFORE_START",
      "The end date cannot be before the employment started",
      context
    );
  }

  const [organization] = await tx
    .select({ ownerUserId: organizations.ownerUserId })
    .from(organizations)
    .where(eq(organizations.id, organizationId));
  if (userId !== null && organization?.ownerUserId === userId) {
    throw refuse(409, "OWNER_EMPLOYMENT", "The owner's employment can't be ended", context);
  }

  const now = new Date();
  let cancelled: VacationType[] = [];
  if (userId !== null) {
    const organizationGroups = await tx
      .select({ id: groups.id, managerUserId: groups.managerUserId })
      .from(groups)
      .where(and(eq(groups.organizationId, organizationId), isNull(groups.deletedAt)));

    if (organizationGroups.some((group) => group.managerUserId === userId)) {
      throw refuse(
        409,
        "MANAGES_GROUP",
        "This person manages a group. Give the group another manager first",
        context
      );
    }

    const groupIds = organizationGroups.map((group) => group.id);
    if (groupIds.length > 0) {
      await tx
        .update(groupUsers)
        .set({ deletedAt: now })
        .where(
          and(
            eq(groupUsers.userId, userId),
            inArray(groupUsers.groupId, groupIds),
            isNull(groupUsers.deletedAt)
          )
        );
      await tx
        .update(groups)
        .set({ mainApprovalUser: sql`${groups.managerUserId}` })
        .where(and(inArray(groups.id, groupIds), eq(groups.mainApprovalUser, userId)));
      await tx
        .update(groups)
        .set({ tempApprovalUser: null })
        .where(and(inArray(groups.id, groupIds), eq(groups.tempApprovalUser, userId)));
    }

    await tx
      .update(organizationUsers)
      .set({ deletedAt: now })
      .where(
        and(
          eq(organizationUsers.organizationId, organizationId),
          eq(organizationUsers.userId, userId),
          isNull(organizationUsers.deletedAt)
        )
      );

    cancelled = await cancelBookingsOnDeparture(
      { userId, groupIds, today, actorUserId: input.actorUserId, reason: EMPLOYMENT_ENDED_REASON },
      tx
    );
  }

  // An earlier date ends at that day's last instant in the organization's
  // zone, so attendance reads it as the last day of the spell.
  const endedAt =
    input.endedOn === today
      ? now
      : sql`((${input.endedOn}::date + 1)::timestamp at time zone ${timeZone}) - interval '1 millisecond'`;

  const [ended] = await tx
    .update(employments)
    .set({ endedAt, endRecordedAt: now, updatedAt: now })
    .where(eq(employments.id, employment.id))
    .returning();
  await endDirectoryRoles(
    {
      employmentIds: [employment.id],
      reason: roleChangeReason.EmploymentEnded,
      actorUserId: input.actorUserId,
    },
    tx
  );
  await clearReportsTo(
    { employmentId: employment.id, actorUserId: input.actorUserId, audience: input.audience },
    tx
  );
  const atEnd = await clearAtEndSections(employment, tx);

  return { employment: ended!, cancelled, photoPrefixes: atEnd.photoPrefixes };
};

/**
 * Open records that named the ended Employment in Reports to stop naming it,
 * each with a Profile history entry. Ended records keep theirs as they were.
 */
const clearReportsTo = async (
  input: { employmentId: string; actorUserId: string; audience: directoryAudience },
  tx: DbTransaction
): Promise<void> => {
  const cleared = await tx
    .update(directoryProfiles)
    .set({ reportsToEmploymentId: null, updatedAt: new Date() })
    .where(
      and(
        eq(directoryProfiles.reportsToEmploymentId, input.employmentId),
        inArray(
          directoryProfiles.employmentId,
          tx.select({ id: employments.id }).from(employments).where(isNull(employments.endedAt))
        )
      )
    )
    .returning({
      employmentId: directoryProfiles.employmentId,
      organizationId: directoryProfiles.organizationId,
    });
  if (cleared.length === 0) return;
  await tx.insert(directoryProfileHistory).values(
    cleared.map((row) => ({
      id: generateRandomUUID(),
      organizationId: row.organizationId,
      employmentId: row.employmentId,
      actorUserId: input.actorUserId,
      section: directoryPermissionRow.Card,
      fields: ["reportsTo"],
      audience: input.audience,
    }))
  );
};
