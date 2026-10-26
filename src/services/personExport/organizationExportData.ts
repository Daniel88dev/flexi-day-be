import { asc, eq, inArray } from "drizzle-orm";
import { db } from "../../db/db.js";
import { attendanceSettingsChanges } from "../../db/schema/attendance-settings-change-schema.js";
import { employments } from "../../db/schema/employment-schema.js";
import { groupEvents } from "../../db/schema/group-event-schema.js";
import { groups } from "../../db/schema/group-schema.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
import { organizationAttendanceSettings } from "../../db/schema/organization-attendance-settings-schema.js";
import { organizations } from "../../db/schema/organization-schema.js";
import { organizationUsers } from "../../db/schema/organization-users-schema.js";
import { getPersonContacts } from "../person/personName.js";
import { safeFileName } from "./personExportData.js";

export type OrganizationExportPerson = { userId: string; name: string; folder: string };

/**
 * What the organization holds about itself, for `organization.json`, and the
 * people whose Person export folders go beside it. Names are the
 * organization's own copies, read through the name helper.
 */
export const collectOrganizationExport = async (organizationId: string) => {
  const [organization] = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      ownerUserId: organizations.ownerUserId,
      billingEmail: organizations.billingEmail,
      sickDayBenefitEnabled: organizations.sickDayBenefitEnabled,
      createdAt: organizations.createdAt,
    })
    .from(organizations)
    .where(eq(organizations.id, organizationId));

  const [attendance] = await db
    .select()
    .from(organizationAttendanceSettings)
    .where(eq(organizationAttendanceSettings.organizationId, organizationId));
  const settingsChanges = await db
    .select()
    .from(attendanceSettingsChanges)
    .where(eq(attendanceSettingsChanges.organizationId, organizationId))
    .orderBy(asc(attendanceSettingsChanges.createdAt));

  const admins = await db
    .select()
    .from(organizationUsers)
    .where(eq(organizationUsers.organizationId, organizationId))
    .orderBy(asc(organizationUsers.createdAt));

  const groupRows = await db
    .select()
    .from(groups)
    .where(eq(groups.organizationId, organizationId))
    .orderBy(asc(groups.createdAt));
  const groupIds = groupRows.map((group) => group.id);
  const groupName = new Map(groupRows.map((group) => [group.id, group.groupName]));

  const memberships =
    groupIds.length === 0
      ? []
      : await db
          .select()
          .from(groupUsers)
          .where(inArray(groupUsers.groupId, groupIds))
          .orderBy(asc(groupUsers.createdAt));
  const events =
    groupIds.length === 0
      ? []
      : await db
          .select()
          .from(groupEvents)
          .where(inArray(groupEvents.groupId, groupIds))
          .orderBy(asc(groupEvents.startDate), asc(groupEvents.createdAt));

  const spells = await db
    .select({
      id: employments.id,
      userId: employments.userId,
      type: employments.type,
      name: employments.name,
      email: employments.email,
      startedAt: employments.startedAt,
      endedAt: employments.endedAt,
      accountDeletedAt: employments.accountDeletedAt,
    })
    .from(employments)
    .where(eq(employments.organizationId, organizationId))
    .orderBy(asc(employments.startedAt), asc(employments.id));
  const bound = spells.flatMap(({ userId, ...spell }) => (userId ? [{ ...spell, userId }] : []));

  const ids = new Set<string>();
  const note = (id: string | null | undefined) => {
    if (id) ids.add(id);
  };
  note(organization?.ownerUserId);
  bound.forEach((row) => note(row.userId));
  admins.forEach((row) => {
    note(row.userId);
    note(row.grantedByUserId);
  });
  groupRows.forEach((row) => {
    note(row.managerUserId);
    note(row.mainApprovalUser);
    note(row.tempApprovalUser);
  });
  memberships.forEach((row) => note(row.userId));
  events.forEach((row) => note(row.createdByUserId));
  settingsChanges.forEach((row) => note(row.changedByUserId));
  const names = new Map(
    (await getPersonContacts([...ids], { organizationId })).map((row) => [row.id, row.name])
  );
  const nameOf = (id: string | null | undefined) => (id ? (names.get(id) ?? null) : null);

  const people: OrganizationExportPerson[] = [];
  const folders = new Set<string>();
  for (const spell of bound) {
    if (people.some((person) => person.userId === spell.userId)) continue;
    const name = nameOf(spell.userId) ?? "";
    let folder = `people/${safeFileName(name)}-${spell.userId.slice(0, 8)}`;
    for (let n = 2; folders.has(folder); n += 1) folder = `${folder}-${n.toString()}`;
    folders.add(folder);
    people.push({ userId: spell.userId, name, folder });
  }

  const document = {
    exportedAt: new Date(),
    organization: organization
      ? {
          id: organization.id,
          name: organization.name,
          owner: nameOf(organization.ownerUserId),
          billingEmail: organization.billingEmail,
          createdAt: organization.createdAt,
        }
      : { id: organizationId, name: null },
    settings: {
      sickDayBenefitEnabled: organization?.sickDayBenefitEnabled ?? null,
      attendance: attendance
        ? {
            attendanceEnabled: attendance.attendanceEnabled,
            locationEnabled: attendance.locationEnabled,
            timezone: attendance.timezone,
            holidayCountry: attendance.holidayCountry,
            workingDays: attendance.workingDays,
            breakMinutes: attendance.breakMinutes,
            breakThresholdMinutes: attendance.breakThresholdMinutes,
            requiredMinutesPerDay: attendance.requiredMinutesPerDay,
            balanceMode: attendance.balanceMode,
            sessionCeilingMinutes: attendance.sessionCeilingMinutes,
            breakCeilingMinutes: attendance.breakCeilingMinutes,
            selfServiceEnabled: attendance.selfServiceEnabled,
            selfServiceDays: attendance.selfServiceDays,
            updatedAt: attendance.updatedAt,
          }
        : null,
      attendanceChanges: settingsChanges.map((row) => ({
        at: row.createdAt,
        by: nameOf(row.changedByUserId),
        before: row.before,
        after: row.after,
      })),
    },
    administrators: admins.map((row) => ({
      userId: row.userId,
      name: nameOf(row.userId),
      grantedBy: nameOf(row.grantedByUserId),
      grantedAt: row.createdAt,
      revokedAt: row.deletedAt,
    })),
    groups: groupRows.map((row) => ({
      id: row.id,
      name: row.groupName,
      manager: nameOf(row.managerUserId),
      mainApprover: nameOf(row.mainApprovalUser),
      tempApprover: nameOf(row.tempApprovalUser),
      defaultVacationDays: row.defaultVacationDays,
      defaultHomeOfficeDays: row.defaultHomeOfficeDays,
      defaultSickDays: row.defaultSickDays,
      workingDays: row.workingDays,
      holidayCountry: row.holidayCountry,
      createdAt: row.createdAt,
      deletedAt: row.deletedAt,
    })),
    memberships: memberships.map((row) => ({
      groupId: row.groupId,
      groupName: groupName.get(row.groupId) ?? null,
      userId: row.userId,
      name: nameOf(row.userId),
      viewAccess: row.viewAccess,
      adminAccess: row.adminAccess,
      approverAccess: row.approverAccess,
      controlledUser: row.controlledUser,
      joinedAt: row.createdAt,
      leftAt: row.deletedAt,
    })),
    groupEvents: events.map((row) => ({
      id: row.id,
      groupId: row.groupId,
      groupName: groupName.get(row.groupId) ?? null,
      title: row.title,
      note: row.note,
      startDate: row.startDate,
      endDate: row.endDate,
      startTime: row.startTime,
      endTime: row.endTime,
      repeat: row.repeatFreq
        ? {
            freq: row.repeatFreq,
            interval: row.repeatInterval,
            weekdays: row.repeatWeekdays,
            monthlyMode: row.repeatMonthlyMode,
            until: row.repeatUntil,
            skippedDates: row.skippedDates,
          }
        : null,
      recurringEventId: row.recurringEventId,
      originalDate: row.originalDate,
      createdBy: nameOf(row.createdByUserId),
      createdAt: row.createdAt,
      deletedAt: row.deletedAt,
    })),
    people: people.map((person) => ({
      userId: person.userId,
      name: person.name,
      folder: `${person.folder}/`,
      employments: bound
        .filter((spell) => spell.userId === person.userId)
        .map((spell) => ({
          id: spell.id,
          type: spell.type,
          startedAt: spell.startedAt,
          endedAt: spell.endedAt,
          accountDeletedAt: spell.accountDeletedAt,
        })),
    })),
    // No account means no Person export folder: the Employment is all there is.
    peopleWithoutAccount: spells
      .filter((spell) => spell.userId === null)
      .map((spell) => ({
        employmentId: spell.id,
        name: spell.name,
        email: spell.email,
        type: spell.type,
        startedAt: spell.startedAt,
        endedAt: spell.endedAt,
      })),
  };

  return { document, people };
};
