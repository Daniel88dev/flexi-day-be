import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "../../db/db.js";
import { attachments, AttachmentStatus } from "../../db/schema/attachment-schema.js";
import {
  attendanceBreaks,
  attendanceEvents,
  attendanceSessions,
} from "../../db/schema/attendance-schema.js";
import { changesSchema } from "../../db/schema/changes-schema.js";
import { employments } from "../../db/schema/employment-schema.js";
import { groups } from "../../db/schema/group-schema.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
import { organizations } from "../../db/schema/organization-schema.js";
import { readLog, readLogAudience } from "../../db/schema/read-log-schema.js";
import { userYearQuotas } from "../../db/schema/user-year-quotas-schema.js";
import { vacationEvents } from "../../db/schema/vacation-event-schema.js";
import { vacation } from "../../db/schema/vacation-schema.js";
import { downloadFileName } from "../attachment/attachmentServices.js";
import { photoKeys, photoPrefix, readyPhotoIds } from "../directory/directoryPhotoServices.js";
import { collectProfileExport } from "../directory/directoryProfileServices.js";
import { getPersonContacts } from "../person/personName.js";

/** The fixed purpose labels the person sees in place of reader names (C-579/21). */
const PURPOSE: Record<readLogAudience, string> = {
  [readLogAudience.Owner]: "owner",
  [readLogAudience.OrganizationAdmin]: "organization administration",
  [readLogAudience.Self]: "self-service",
};

export type BookingStatus = "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";

const bookingStatus = (row: {
  deletedAt: Date | null;
  rejectedAt: Date | null;
  approvedAt: Date | null;
}): BookingStatus =>
  row.deletedAt
    ? "CANCELLED"
    : row.rejectedAt
      ? "REJECTED"
      : row.approvedAt
        ? "APPROVED"
        : "PENDING";

const fix = (latitude: number | null, longitude: number | null, accuracy: number | null) =>
  latitude === null || longitude === null ? null : { latitude, longitude, accuracy };

export const safeFileName = (name: string): string =>
  // eslint-disable-next-line no-control-regex
  name.replace(/[/\\\x00-\x1f]/g, "_").slice(0, 120) || "file";

/** A file the ZIP carries: an attachment, or a Profile photo from the organization-data store. */
export type ExportAttachmentFile = {
  path: string;
  storageKey: string;
  store?: "organizationData";
};

/**
 * Everything one organization holds about one person, across every spell:
 * Organization data only. Account data (login, settings, notifications,
 * Birthday, the account's own name and email) stays out; the person's name
 * and email here are the Employment's own copies.
 */
export const collectPersonExport = async (organizationId: string, subjectUserId: string) => {
  const [organization] = await db
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, organizationId));

  const spells = await db
    .select({
      id: employments.id,
      startedAt: employments.startedAt,
      endedAt: employments.endedAt,
      name: employments.name,
      email: employments.email,
      requiredMinutesPerDay: employments.requiredMinutesPerDay,
      accountDeletedAt: employments.accountDeletedAt,
    })
    .from(employments)
    .where(
      and(eq(employments.organizationId, organizationId), eq(employments.userId, subjectUserId))
    )
    .orderBy(asc(employments.startedAt));
  const employmentIds = spells.map((spell) => spell.id);
  const profile = await collectProfileExport(organizationId, employmentIds);
  const photos = await readyPhotoIds(employmentIds);

  const organizationGroups = await db
    .select({
      id: groups.id,
      name: groups.groupName,
      managerUserId: groups.managerUserId,
      deletedAt: groups.deletedAt,
    })
    .from(groups)
    .where(eq(groups.organizationId, organizationId));
  const groupIds = organizationGroups.map((group) => group.id);
  const groupName = new Map(organizationGroups.map((group) => [group.id, group.name]));

  const inGroups = <T>(rows: () => Promise<T[]>) =>
    groupIds.length === 0 ? Promise.resolve([] as T[]) : rows();

  const memberships = await inGroups(() =>
    db
      .select({
        groupId: groupUsers.groupId,
        viewAccess: groupUsers.viewAccess,
        adminAccess: groupUsers.adminAccess,
        approverAccess: groupUsers.approverAccess,
        controlledUser: groupUsers.controlledUser,
        createdAt: groupUsers.createdAt,
        deletedAt: groupUsers.deletedAt,
      })
      .from(groupUsers)
      .where(and(eq(groupUsers.userId, subjectUserId), inArray(groupUsers.groupId, groupIds)))
      .orderBy(asc(groupUsers.createdAt))
  );

  const quotas = await inGroups(() =>
    db
      .select({
        groupId: userYearQuotas.groupId,
        year: userYearQuotas.relatedYear,
        vacationDays: userYearQuotas.vacationDays,
        homeOfficeDays: userYearQuotas.homeOfficeDays,
        sickDays: userYearQuotas.sickDays,
        carriedOverDays: userYearQuotas.carriedOverDays,
        updatedAt: userYearQuotas.updatedAt,
      })
      .from(userYearQuotas)
      .where(
        and(eq(userYearQuotas.userId, subjectUserId), inArray(userYearQuotas.groupId, groupIds))
      )
      .orderBy(asc(userYearQuotas.relatedYear))
  );

  const bookingRows = await inGroups(() =>
    db
      .select()
      .from(vacation)
      .where(and(eq(vacation.userId, subjectUserId), inArray(vacation.groupId, groupIds)))
      .orderBy(asc(vacation.requestedDay), asc(vacation.createdAt))
  );
  const bookingIds = bookingRows.map((row) => row.id);
  const timeline =
    bookingIds.length === 0
      ? []
      : await db
          .select()
          .from(vacationEvents)
          .where(inArray(vacationEvents.vacationId, bookingIds))
          .orderBy(asc(vacationEvents.createdAt));

  const attachmentRows = await db
    .select()
    .from(attachments)
    .where(
      and(
        eq(attachments.organizationId, organizationId),
        eq(attachments.ownerUserId, subjectUserId)
      )
    )
    .orderBy(asc(attachments.createdAt));

  const sessions =
    employmentIds.length === 0
      ? []
      : await db
          .select()
          .from(attendanceSessions)
          .where(inArray(attendanceSessions.employmentId, employmentIds))
          .orderBy(asc(attendanceSessions.businessDate), asc(attendanceSessions.startedAt));
  const sessionIds = sessions.map((row) => row.id);
  const breaks =
    sessionIds.length === 0
      ? []
      : await db
          .select()
          .from(attendanceBreaks)
          .where(inArray(attendanceBreaks.sessionId, sessionIds))
          .orderBy(asc(attendanceBreaks.startedAt));
  const sessionEvents =
    sessionIds.length === 0
      ? []
      : await db
          .select()
          .from(attendanceEvents)
          .where(inArray(attendanceEvents.sessionId, sessionIds))
          .orderBy(asc(attendanceEvents.createdAt));

  const changeRows = await inGroups(() =>
    db
      .select()
      .from(changesSchema)
      .where(and(eq(changesSchema.userId, subjectUserId), inArray(changesSchema.groupId, groupIds)))
      .orderBy(asc(changesSchema.createdAt))
  );

  const reads = await db
    .select({ at: readLog.createdAt, kind: readLog.kind, audience: readLog.audience })
    .from(readLog)
    .where(
      and(eq(readLog.organizationId, organizationId), eq(readLog.subjectUserId, subjectUserId))
    )
    .orderBy(asc(readLog.createdAt));

  const actorIds = new Set<string>();
  const note = (id: string | null) => {
    if (id) actorIds.add(id);
  };
  for (const row of bookingRows) {
    note(row.approvedBy);
    note(row.rejectedBy);
    note(row.createdByUserId);
    note(row.deletedByUserId);
  }
  timeline.forEach((row) => note(row.actorUserId));
  attachmentRows.forEach((row) => note(row.uploadedByUserId));
  sessions.forEach((row) => note(row.deletedByUserId));
  sessionEvents.forEach((row) => note(row.changedByUserId));
  changeRows.forEach((row) => note(row.changingUserId));
  const names = new Map(
    (await getPersonContacts([...actorIds], { organizationId })).map((row) => [row.id, row.name])
  );
  const nameOf = (id: string | null) => (id ? (names.get(id) ?? null) : null);

  const files: ExportAttachmentFile[] = [];
  const attachmentEntries = attachmentRows.map((row) => {
    const held = row.status === AttachmentStatus.Ready && row.deletedAt === null;
    const path = held
      ? `attachments/${row.id.slice(0, 8)}-${safeFileName(downloadFileName(row))}`
      : null;
    if (path) files.push({ path, storageKey: row.storageKey });
    return {
      id: row.id,
      requestId: row.requestId,
      fileName: row.fileName,
      contentType: row.contentType,
      size: row.size,
      status: row.status,
      uploadedAt: row.createdAt,
      uploadedBy: nameOf(row.uploadedByUserId),
      deletedAt: row.deletedAt,
      file: path,
    };
  });

  const bookings = bookingRows.map((row) => ({
    id: row.id,
    requestId: row.requestId,
    groupId: row.groupId,
    groupName: groupName.get(row.groupId) ?? null,
    day: row.requestedDay,
    type: row.vacationType,
    halfDay: row.halfDay,
    startTime: row.startTime,
    endTime: row.endTime,
    status: bookingStatus(row),
    note: row.note,
    rejectionReason: row.rejectionReason,
    createdAt: row.createdAt,
    createdBy: nameOf(row.createdByUserId),
    approvedAt: row.approvedAt,
    approvedBy: nameOf(row.approvedBy),
    rejectedAt: row.rejectedAt,
    rejectedBy: nameOf(row.rejectedBy),
    cancelledAt: row.deletedAt,
    cancelledBy: nameOf(row.deletedByUserId),
    timeline: timeline
      .filter((event) => event.vacationId === row.id)
      .map((event) => ({
        type: event.eventType,
        at: event.createdAt,
        by: nameOf(event.actorUserId),
        reason: event.reason,
      })),
  }));

  const attendance = sessions.map((row) => ({
    id: row.id,
    employmentId: row.employmentId,
    businessDate: row.businessDate,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    timezone: row.timezone,
    origin: row.origin,
    closedBy: row.closedBy,
    changedAfterDay: row.changedAfterDay,
    deletedAt: row.deletedAt,
    deletedBy: nameOf(row.deletedByUserId),
    startLocation: fix(row.startLatitude, row.startLongitude, row.startAccuracy),
    endLocation: fix(row.endLatitude, row.endLongitude, row.endAccuracy),
    breaks: breaks
      .filter((entry) => entry.sessionId === row.id)
      .map((entry) => ({
        startedAt: entry.startedAt,
        endedAt: entry.endedAt,
        autoClosed: entry.autoClosed,
      })),
    events: sessionEvents
      .filter((event) => event.sessionId === row.id)
      .map((event) => ({
        type: event.eventType,
        at: event.createdAt,
        by: nameOf(event.changedByUserId),
        before: event.before,
        after: event.after,
      })),
  }));

  const photoOfSpell = (employmentId: string) => {
    const photo = photos.get(employmentId);
    if (!photo) return null;
    const path = `profile-photos/${employmentId}.jpg`;
    files.push({
      path,
      storageKey: photoKeys(photoPrefix({ ...photo, employmentId })).full,
      store: "organizationData",
    });
    return { file: path, uploadedAt: photo.readyAt };
  };

  const person = {
    exportedAt: new Date(),
    organization: organization ?? { id: organizationId, name: null },
    employments: spells.map((spell) => ({
      ...spell,
      profile: profile.profiles.get(spell.id) ?? null,
      photo: photoOfSpell(spell.id),
    })),
    groups: memberships.map((row) => ({
      groupId: row.groupId,
      groupName: groupName.get(row.groupId) ?? null,
      joinedAt: row.createdAt,
      leftAt: row.deletedAt,
      viewAccess: row.viewAccess,
      adminAccess: row.adminAccess,
      approverAccess: row.approverAccess,
      controlledUser: row.controlledUser,
    })),
    managedGroups: organizationGroups
      .filter((group) => group.managerUserId === subjectUserId)
      .map((group) => ({ groupId: group.id, groupName: group.name, deletedAt: group.deletedAt })),
    quotas: quotas.map((row) => ({ ...row, groupName: groupName.get(row.groupId) ?? null })),
    bookings,
    attachments: attachmentEntries,
    attendanceSessions: attendance,
    changes: changeRows.map((row) => ({
      id: row.id,
      at: row.createdAt,
      groupId: row.groupId,
      groupName: groupName.get(row.groupId) ?? null,
      type: row.changeType,
      detail: row.changeDetail,
      by: nameOf(row.changingUserId),
    })),
    profileHistory: profile.history,
    readLog: reads.map((row) => ({ at: row.at, kind: row.kind, purpose: PURPOSE[row.audience] })),
  };

  return { person, files, employmentIds };
};

export type PersonExportContent = Awaited<ReturnType<typeof collectPersonExport>>;
