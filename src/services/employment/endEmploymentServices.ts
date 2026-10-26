import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { DbTransaction } from "../../db/db.js";
import { employments } from "../../db/schema/employment-schema.js";
import { groups } from "../../db/schema/group-schema.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
import { organizationUsers } from "../../db/schema/organization-users-schema.js";
import AppError from "../../utils/appError.js";
import { businessDateInZone, type DateString } from "../../utils/dateFunc.js";
import { organizationTimeZone } from "../organization/attendanceSettingsServices.js";
import { isOrganizationAdmin, lockOrganization } from "../organization/organizationServices.js";
import {
  cancelBookingsOnDeparture,
  EMPLOYMENT_ENDED_REASON,
} from "../vacation/departureCancellation.js";
import type { VacationType } from "../vacation/types.js";
import type { EmploymentType } from "./types.js";

const refuse = (code: number, publicCode: string, message: string, context: object) =>
  new AppError({ code, message, logging: true, context, publicContext: { code: publicCode } });

/**
 * End employment: the person leaves every group of the organization, loses a
 * delegated admin row, has pending requests and bookings after today
 * cancelled, and the Employment ends on `endedOn` (today or earlier, in the
 * organization's time zone). Owner and org admins only, on any plan.
 *
 * Only a Deleted account can be ended for now. Employments are one row per
 * organization until spells land, so ending a live person and adding them to
 * a group again would reopen the row and overwrite the spell just ended.
 *
 * Runs no `syncEmployment`: it would end the row at `now()` instead of on the
 * chosen date.
 */
export const endEmployment = async (
  input: { employmentId: string; endedOn: DateString; actorUserId: string },
  tx: DbTransaction
): Promise<{ employment: EmploymentType; cancelled: VacationType[] }> => {
  const context = { userId: input.actorUserId, employmentId: input.employmentId };

  const [found] = await tx
    .select({ organizationId: employments.organizationId })
    .from(employments)
    .where(eq(employments.id, input.employmentId));
  if (!found) throw refuse(404, "NOT_FOUND", "Employment not found", context);

  const { organizationId } = found;
  if (!(await isOrganizationAdmin(input.actorUserId, organizationId, tx))) {
    throw refuse(403, "FORBIDDEN", "No permission for related organization", context);
  }

  // Every path that adds someone to the organization takes this lock, so no
  // membership can land between the reads below and the end.
  await lockOrganization(organizationId, tx);
  const [employment] = await tx
    .select()
    .from(employments)
    .where(eq(employments.id, input.employmentId))
    .for("update");
  if (!employment) throw refuse(404, "NOT_FOUND", "Employment not found", context);

  if (employment.endedAt !== null) {
    throw refuse(409, "EMPLOYMENT_ENDED", "This employment has already ended", context);
  }
  if (employment.accountDeletedAt === null) {
    throw refuse(
      422,
      "ACCOUNT_NOT_DELETED",
      "Only the employment of a deleted account can be ended here",
      context
    );
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

  const userId = employment.userId;
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
  const now = new Date();

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

  const cancelled = await cancelBookingsOnDeparture(
    { userId, groupIds, today, actorUserId: input.actorUserId, reason: EMPLOYMENT_ENDED_REASON },
    tx
  );

  // An earlier date ends at that day's last instant in the organization's
  // zone, so attendance reads it as the last day of the spell.
  const endedAt =
    input.endedOn === today
      ? now
      : sql`((${input.endedOn}::date + 1)::timestamp at time zone ${timeZone}) - interval '1 millisecond'`;

  const [ended] = await tx
    .update(employments)
    .set({ endedAt, updatedAt: now })
    .where(eq(employments.id, employment.id))
    .returning();

  return { employment: ended!, cancelled };
};
