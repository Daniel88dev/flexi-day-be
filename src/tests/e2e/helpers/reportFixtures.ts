import { v4 as uuidv4 } from "uuid";
import { and, eq } from "drizzle-orm";
import { db } from "../../../db/db.js";
import { user } from "../../../db/schema/auth-schema.js";
import { groups } from "../../../db/schema/group-schema.js";
import { groupUsers } from "../../../db/schema/group-users-schema.js";
import { vacation, vacationType } from "../../../db/schema/vacation-schema.js";
import { userYearQuotas } from "../../../db/schema/user-year-quotas-schema.js";
import { changesSchema, changesType } from "../../../db/schema/changes-schema.js";
import { reportExports } from "../../../db/schema/report-export-schema.js";
import { vacationEvents } from "../../../db/schema/vacation-event-schema.js";
import { notifications } from "../../../db/schema/notification-schema.js";
import { session } from "../../../db/schema/auth-schema.js";

/**
 * Fixtures for the report e2e suite. Deliberately independent of
 * `testSetup.ts`'s cached context: these tests need several users with
 * different permissions per case, which a single shared group cannot express.
 */

export async function makeUser(name: string): Promise<{ id: string; name: string }> {
  const id = uuidv4();
  await db.insert(user).values({
    id,
    email: `${id}@report-e2e.test`,
    name,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return { id, name };
}

export async function makeGroup(groupName: string, managerUserId: string): Promise<string> {
  const id = uuidv4();
  await db.insert(groups).values({
    id,
    groupName,
    managerUserId,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

export async function addMember(
  groupId: string,
  userId: string,
  permissions: {
    viewAccess?: boolean;
    adminAccess?: boolean;
    approverAccess?: boolean;
    controlledUser?: boolean;
  } = {}
): Promise<void> {
  await db.insert(groupUsers).values({
    id: uuidv4(),
    groupId,
    userId,
    viewAccess: permissions.viewAccess ?? false,
    adminAccess: permissions.adminAccess ?? false,
    approverAccess: permissions.approverAccess ?? false,
    controlledUser: permissions.controlledUser ?? true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

/** Soft-deletes a membership, as leaving a group does. */
export async function removeMember(groupId: string, userId: string): Promise<void> {
  await db
    .update(groupUsers)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(groupUsers.groupId, groupId), eq(groupUsers.userId, userId)));
}

export async function addQuota(
  groupId: string,
  userId: string,
  year: number,
  values: { vacationDays?: number; homeOfficeDays?: number; carriedOverDays?: number } = {}
): Promise<void> {
  await db.insert(userYearQuotas).values({
    id: uuidv4(),
    userId,
    groupId,
    relatedYear: year.toString(),
    vacationDays: values.vacationDays ?? 20,
    homeOfficeDays: values.homeOfficeDays ?? 0,
    carriedOverDays: values.carriedOverDays ?? 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

export type LeaveOptions = {
  type?: vacationType;
  halfDay?: boolean;
  approved?: boolean;
  rejected?: boolean;
  note?: string | null;
};

/** Books one day. `approved` defaults to true so usage lands in "used". */
export async function addLeave(
  groupId: string,
  userId: string,
  requestedDay: string,
  options: LeaveOptions = {}
): Promise<string> {
  const id = uuidv4();
  await db.insert(vacation).values({
    id,
    userId,
    groupId,
    requestedDay,
    vacationType: options.type ?? vacationType.Vacation,
    halfDay: options.halfDay ?? false,
    approvedAt: options.approved === false ? null : new Date(),
    rejectedAt: options.rejected ? new Date() : null,
    note: options.note ?? null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

export async function addLeaveRange(
  groupId: string,
  userId: string,
  days: string[],
  options: LeaveOptions = {}
): Promise<void> {
  for (const day of days) await addLeave(groupId, userId, day, options);
}

/**
 * `createdAt` is explicit because consecutive inserts otherwise land in the
 * same millisecond, which makes any assertion about ordering a coin flip.
 */
export async function addChange(
  groupId: string,
  userId: string,
  changingUserId: string,
  changeDetail: string,
  createdAt: Date = new Date()
): Promise<void> {
  await db.insert(changesSchema).values({
    id: uuidv4(),
    userId,
    groupId,
    changeType: changesType.UserYearQuotas,
    changeDetail,
    changingUserId,
    createdAt,
    updatedAt: createdAt,
  });
}

/**
 * Wipes every table this suite writes to. `changes.changing_user_id` has no
 * cascade, so it must go before the users it points at.
 */
export async function resetReportData(): Promise<void> {
  await db.delete(reportExports);
  await db.delete(changesSchema);
  await db.delete(vacationEvents);
  await db.delete(vacation);
  await db.delete(userYearQuotas);
  await db.delete(groupUsers);
  await db.delete(notifications);
  await db.delete(session);
  await db.delete(groups);
  await db.delete(user);
}

/** ISO date inside the given year, safe for month/day arithmetic in assertions. */
export const dayIn = (year: number, month: number, day: number): string =>
  `${year.toString()}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
