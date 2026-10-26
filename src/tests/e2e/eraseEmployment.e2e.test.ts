import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { v4 as uuidv4 } from "uuid";
import { and, eq, inArray } from "drizzle-orm";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { db } from "../../db/db.js";
import { user } from "../../db/schema/auth-schema.js";
import { attachments, AttachmentStatus } from "../../db/schema/attachment-schema.js";
import {
  attendanceBreaks,
  attendanceEvents,
  attendanceEventType,
  attendanceSessions,
} from "../../db/schema/attendance-schema.js";
import { changesSchema } from "../../db/schema/changes-schema.js";
import { employments } from "../../db/schema/employment-schema.js";
import { groupEvents } from "../../db/schema/group-event-schema.js";
import { groups } from "../../db/schema/group-schema.js";
import { groupMirrors } from "../../db/schema/group-mirror-schema.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
import { organizationUsers } from "../../db/schema/organization-users-schema.js";
import {
  personExports,
  personExportScope,
  personExportStatus,
} from "../../db/schema/person-export-schema.js";
import { readLog, readLogAudience, readLogKind } from "../../db/schema/read-log-schema.js";
import { userYearQuotas } from "../../db/schema/user-year-quotas-schema.js";
import { vacation } from "../../db/schema/vacation-schema.js";
import { vacationEvents, vacationEventType } from "../../db/schema/vacation-event-schema.js";
import { attachmentStore } from "../../services/attachment/attachmentStore.js";
import { syncEmployment } from "../../services/employment/employmentServices.js";
import { ensureOrganizationForUser } from "../../services/organization/organizationServices.js";
import { organizationDataStore } from "../../services/organizationData/organizationDataStore.js";
import { exportStorageKey } from "../../services/personExport/personExportBuild.js";
import {
  WEB_TEST_PASSWORD,
  authCookieFor,
  createWebUser,
  webSessionCookieFor,
} from "./helpers/authHelper.js";
import {
  addChange,
  addLeave,
  addMember,
  addMirror,
  addQuota,
  makeGroup,
  makeUser,
  resetReportData,
} from "./helpers/reportFixtures.js";
import { cleanupTestData } from "./helpers/testSetup.js";

vi.mock("../../services/email/index.js", () => ({
  emailSender: { sendTemplated: () => Promise.resolve() },
}));

const MEMBER = "Jana Nováková";
const YEAR = new Date().getUTCFullYear();
const day = (month: number, date: number) =>
  `${YEAR.toString()}-${month.toString().padStart(2, "0")}-${date.toString().padStart(2, "0")}`;

describe("erasing a person's organization data", () => {
  let server: LoopbackServer;
  let scratch: string;

  beforeAll(async () => {
    await resetReportData();
    await cleanupTestData();
    server = await listenOnLoopback(createServer());
    scratch = await mkdtemp(path.join(os.tmpdir(), "erase-e2e-"));
  });

  afterAll(async () => {
    await server?.close();
    await resetReportData();
    await cleanupTestData();
    await rm(scratch, { recursive: true, force: true });
  });

  const deleteAccount = async (email: string) => {
    const cookie = await webSessionCookieFor(server.url, email);
    const res = await request(server.url)
      .post("/api/users/me/delete")
      .set("Cookie", cookie)
      .send({ password: WEB_TEST_PASSWORD });
    expect(res.status).toBe(204);
  };

  const employmentsOf = (organizationId: string, userId: string) =>
    db
      .select()
      .from(employments)
      .where(and(eq(employments.organizationId, organizationId), eq(employments.userId, userId)));

  /**
   * Olga owns an organization with two groups. Jana belongs to both, approves
   * in the first, and holds a quota, bookings with a timeline and an
   * attachment, an attendance session with a break and an event, a mirror, a
   * change about her, a delegated admin row and a ready Person export. She
   * approved and created a booking for Pavel, changed his quota and created a
   * group event. Dana is a delegated org admin, Gina manages the second group.
   * Jana also belongs to a friend's organization. Then she deletes her account.
   */
  const setUp = async (options: { deleteMember?: boolean } = {}) => {
    const owner = await makeUser("Olga Owner");
    const member = await createWebUser(MEMBER);
    const delegate = await makeUser("Dana Delegate");
    const groupManager = await makeUser("Gina Manager");
    const colleague = await makeUser("Pavel Plain");
    const organizationId = (await ensureOrganizationForUser(owner.id)).id;

    const first = await makeGroup("Support", owner.id, { organizationOwnerId: owner.id });
    const second = await makeGroup("Sales", groupManager.id, { organizationOwnerId: owner.id });
    await addMember(first, owner.id, { adminAccess: true, approverAccess: true, viewAccess: true });
    await addMember(first, member.id, { approverAccess: true, viewAccess: true });
    await addMember(second, groupManager.id, { adminAccess: true, viewAccess: true });
    await addMember(second, member.id);
    await addMember(first, delegate.id);
    await addMember(first, colleague.id);
    await db.insert(organizationUsers).values([
      { id: uuidv4(), organizationId, userId: delegate.id, grantedByUserId: owner.id },
      { id: uuidv4(), organizationId, userId: member.id, grantedByUserId: owner.id },
    ]);
    for (const id of [owner.id, member.id, delegate.id, groupManager.id, colleague.id]) {
      await syncEmployment(organizationId, id);
    }
    const [employment] = await employmentsOf(organizationId, member.id);

    await addQuota(first, member.id, YEAR, { vacationDays: 25 });
    const ownBooking = await addLeave(first, member.id, day(1, 5), { approvedBy: owner.id });
    await db.insert(vacationEvents).values({
      id: uuidv4(),
      vacationId: ownBooking,
      eventType: vacationEventType.Approved,
      actorUserId: owner.id,
    });
    const requestId = uuidv4();
    const sickDay = await addLeave(second, member.id, day(1, 6), {
      approvedBy: groupManager.id,
      requestId,
    });
    const attachmentKey = `final/${uuidv4()}.pdf`;
    await attachmentStore.putObject(attachmentKey, Buffer.from("%PDF-1.4 a note"));
    const attachmentId = uuidv4();
    await db.insert(attachments).values({
      id: attachmentId,
      requestId,
      organizationId,
      ownerUserId: member.id,
      uploadedByUserId: member.id,
      fileName: "note.pdf",
      contentType: "application/pdf",
      size: 15,
      storageKey: attachmentKey,
      status: AttachmentStatus.Ready,
    });
    await addChange(first, member.id, owner.id, "Quota set to 25 days");
    const mirrorId = await addMirror(member.id, first, second);

    const sessionId = uuidv4();
    await db.insert(attendanceSessions).values({
      id: sessionId,
      employmentId: employment!.id,
      businessDate: day(1, 7),
      startedAt: new Date(`${day(1, 7)}T07:00:00Z`),
      endedAt: new Date(`${day(1, 7)}T15:00:00Z`),
      timezone: "Europe/Prague",
    });
    await db.insert(attendanceBreaks).values({
      id: uuidv4(),
      sessionId,
      startedAt: new Date(`${day(1, 7)}T11:00:00Z`),
      endedAt: new Date(`${day(1, 7)}T11:30:00Z`),
    });
    await db.insert(attendanceEvents).values({
      id: uuidv4(),
      sessionId,
      eventType: attendanceEventType.SessionEdited,
      changedByUserId: owner.id,
      before: {},
      after: {},
    });

    const colleagueBooking = await addLeave(first, colleague.id, day(1, 8), {
      approvedBy: member.id,
      createdByUserId: member.id,
    });
    await db.insert(vacationEvents).values({
      id: uuidv4(),
      vacationId: colleagueBooking,
      eventType: vacationEventType.Approved,
      actorUserId: member.id,
    });
    await addChange(first, colleague.id, member.id, "Quota set to 22 days");
    const groupEventId = uuidv4();
    await db.insert(groupEvents).values({
      id: groupEventId,
      groupId: first,
      createdByUserId: member.id,
      title: "Team lunch",
      startDate: day(1, 9),
      endDate: day(1, 9),
    });

    const exportId = uuidv4();
    const exportKey = exportStorageKey(organizationId, exportId);
    const zip = path.join(scratch, `${exportId}.zip`);
    await writeFile(zip, "PK fake zip");
    await organizationDataStore!.putFile(exportKey, zip, "application/zip");
    await db.insert(personExports).values({
      id: exportId,
      organizationId,
      subjectUserId: member.id,
      requestedByUserId: owner.id,
      status: personExportStatus.Ready,
      storageKey: exportKey,
      readyAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const storeExport = async (row: { scope: personExportScope; subjectUserId: string | null }) => {
      const id = uuidv4();
      const key = exportStorageKey(organizationId, id);
      const file = path.join(scratch, `${id}.zip`);
      await writeFile(file, "PK fake zip");
      await organizationDataStore!.putFile(key, file, "application/zip");
      await db.insert(personExports).values({
        id,
        organizationId,
        ...row,
        requestedByUserId: owner.id,
        status: personExportStatus.Ready,
        storageKey: key,
        readyAt: new Date(),
        expiresAt: new Date(Date.now() + 86_400_000),
      });
      return { id, key };
    };
    const organizationExport = await storeExport({
      scope: personExportScope.Organization,
      subjectUserId: null,
    });
    const colleagueExport = await storeExport({
      scope: personExportScope.Person,
      subjectUserId: colleague.id,
    });
    const readLogId = uuidv4();
    await db.insert(readLog).values({
      id: readLogId,
      organizationId,
      kind: readLogKind.Export,
      readerUserId: owner.id,
      subjectUserId: member.id,
      employmentIds: [employment!.id],
      audience: readLogAudience.Owner,
      personExportId: exportId,
    });

    const friend = await makeUser("Fiona Friend");
    const elsewhere = await makeGroup("Elsewhere", friend.id);
    const elsewhereTwo = await makeGroup("Elsewhere Two", friend.id);
    await addMember(elsewhere, member.id);
    await addMember(elsewhereTwo, member.id);
    const elsewhereOrganizationId = (await ensureOrganizationForUser(friend.id)).id;
    await syncEmployment(elsewhereOrganizationId, member.id);
    await addQuota(elsewhere, member.id, YEAR);
    const elsewhereBooking = await addLeave(elsewhere, member.id, day(1, 12), {
      approvedBy: friend.id,
    });
    await addChange(elsewhere, member.id, friend.id, "Elsewhere quota");
    const elsewhereMirror = await addMirror(member.id, elsewhere, elsewhereTwo);

    if (options.deleteMember !== false) await deleteAccount(member.email);

    return {
      owner,
      member,
      delegate,
      groupManager,
      colleague,
      friend,
      organizationId,
      elsewhereOrganizationId,
      first,
      second,
      employment: employment!,
      ownBooking,
      sickDay,
      attachmentId,
      attachmentKey,
      mirrorId,
      sessionId,
      colleagueBooking,
      groupEventId,
      exportId,
      exportKey,
      readLogId,
      organizationExport,
      colleagueExport,
      elsewhere,
      elsewhereBooking,
      elsewhereMirror,
    };
  };

  const erase = async (callerId: string, employmentId: string, confirmName: string) =>
    request(server.url)
      .post(`/api/employment/${employmentId}/erase`)
      .set("Cookie", await authCookieFor(callerId))
      .send({ confirmName });

  const countWhere = async <T>(rows: Promise<T[]>) => (await rows).length;

  describe("on a Deleted account", () => {
    it("removes everything the organization holds about the person, and the stored files after the commit", async () => {
      const world = await setUp();
      await db
        .update(employments)
        .set({ endedAt: new Date() })
        .where(eq(employments.id, world.employment.id));

      const res = await erase(world.owner.id, world.employment.id, MEMBER);
      expect(res.status).toBe(204);

      const userId = world.member.id;
      const groupIds = [world.first, world.second];
      expect(await employmentsOf(world.organizationId, userId)).toEqual([]);
      expect(
        await countWhere(
          db
            .select()
            .from(vacation)
            .where(and(eq(vacation.userId, userId), inArray(vacation.groupId, groupIds)))
        )
      ).toBe(0);
      expect(
        await countWhere(
          db.select().from(vacationEvents).where(eq(vacationEvents.vacationId, world.ownBooking))
        )
      ).toBe(0);
      expect(
        await countWhere(
          db.select().from(attachments).where(eq(attachments.id, world.attachmentId))
        )
      ).toBe(0);
      expect(await attachmentStore.getObject(world.attachmentKey)).toBeUndefined();
      expect(
        await countWhere(
          db
            .select()
            .from(userYearQuotas)
            .where(
              and(eq(userYearQuotas.userId, userId), inArray(userYearQuotas.groupId, groupIds))
            )
        )
      ).toBe(0);
      expect(
        await countWhere(
          db.select().from(attendanceSessions).where(eq(attendanceSessions.id, world.sessionId))
        )
      ).toBe(0);
      expect(
        await countWhere(
          db.select().from(attendanceBreaks).where(eq(attendanceBreaks.sessionId, world.sessionId))
        )
      ).toBe(0);
      expect(
        await countWhere(
          db
            .select()
            .from(groupUsers)
            .where(and(eq(groupUsers.userId, userId), inArray(groupUsers.groupId, groupIds)))
        )
      ).toBe(0);
      expect(
        await countWhere(
          db
            .select()
            .from(organizationUsers)
            .where(
              and(
                eq(organizationUsers.userId, userId),
                eq(organizationUsers.organizationId, world.organizationId)
              )
            )
        )
      ).toBe(0);
      expect(
        await countWhere(db.select().from(groupMirrors).where(eq(groupMirrors.id, world.mirrorId)))
      ).toBe(0);
      expect(
        await countWhere(
          db
            .select()
            .from(changesSchema)
            .where(and(eq(changesSchema.userId, userId), inArray(changesSchema.groupId, groupIds)))
        )
      ).toBe(0);
      expect(
        await countWhere(
          db.select().from(personExports).where(eq(personExports.id, world.exportId))
        )
      ).toBe(0);
      expect(await organizationDataStore!.getObject(world.exportKey)).toBeUndefined();
      expect(
        await countWhere(
          db.select().from(personExports).where(eq(personExports.id, world.organizationExport.id))
        )
      ).toBe(0);
      expect(await organizationDataStore!.getObject(world.organizationExport.key)).toBeUndefined();
      expect(
        await countWhere(
          db.select().from(personExports).where(eq(personExports.id, world.colleagueExport.id))
        )
      ).toBe(1);
      expect(await organizationDataStore!.getObject(world.colleagueExport.key)).toBeDefined();
    });
    it("ends an open Employment first, then erases it", async () => {
      const world = await setUp();
      expect(world.employment.endedAt).toBeNull();
      const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
      await addLeave(world.first, world.member.id, tomorrow, { approvedBy: world.owner.id });

      const res = await erase(world.delegate.id, world.employment.id, "  jana   NOVÁKOVÁ ");

      expect(res.status).toBe(204);
      expect(await employmentsOf(world.organizationId, world.member.id)).toEqual([]);
      expect(
        await countWhere(db.select().from(vacation).where(eq(vacation.userId, world.member.id)))
      ).toBe(1);
    });

    it("leaves another organization's records, the user row and the Read log alone", async () => {
      const world = await setUp();

      expect((await erase(world.owner.id, world.employment.id, MEMBER)).status).toBe(204);

      const [elsewhere] = await employmentsOf(world.elsewhereOrganizationId, world.member.id);
      expect(elsewhere).toMatchObject({ endedAt: null, name: MEMBER });
      const [booking] = await db
        .select()
        .from(vacation)
        .where(eq(vacation.id, world.elsewhereBooking));
      expect(booking!.deletedAt).toBeNull();
      expect(
        await countWhere(
          db
            .select()
            .from(userYearQuotas)
            .where(
              and(
                eq(userYearQuotas.userId, world.member.id),
                eq(userYearQuotas.groupId, world.elsewhere)
              )
            )
        )
      ).toBe(1);
      expect(
        await countWhere(
          db
            .select()
            .from(changesSchema)
            .where(
              and(
                eq(changesSchema.userId, world.member.id),
                eq(changesSchema.groupId, world.elsewhere)
              )
            )
        )
      ).toBe(1);
      expect(
        await countWhere(
          db.select().from(groupMirrors).where(eq(groupMirrors.id, world.elsewhereMirror))
        )
      ).toBe(1);
      expect(
        await countWhere(
          db
            .select()
            .from(groupUsers)
            .where(
              and(eq(groupUsers.userId, world.member.id), eq(groupUsers.groupId, world.elsewhere))
            )
        )
      ).toBe(1);

      const [stripped] = await db.select().from(user).where(eq(user.id, world.member.id));
      expect(stripped).toMatchObject({ name: "" });
      expect(stripped!.deletedAt).not.toBeNull();
      expect(
        await countWhere(db.select().from(readLog).where(eq(readLog.id, world.readLogId)))
      ).toBe(1);
    });

    it("names the person Deleted account in other people's records", async () => {
      const world = await setUp();
      const asOwner = async (route: string) =>
        request(server.url)
          .get(route)
          .set("Cookie", await authCookieFor(world.owner.id))
          .expect(200);

      const before = await asOwner(`/api/vacation/${world.colleagueBooking}`);
      expect(before.body.approvedByUser.name).toBe(MEMBER);

      expect((await erase(world.owner.id, world.employment.id, MEMBER)).status).toBe(204);

      const detail = await asOwner(`/api/vacation/${world.colleagueBooking}`);
      expect(detail.body.approvedByUser).toMatchObject({
        id: world.member.id,
        name: "Deleted account",
      });
      expect(detail.body.createdByUser.name).toBe("Deleted account");
      expect(detail.body.history[0].actor).toMatchObject({
        id: world.member.id,
        name: "Deleted account",
      });

      const report = await asOwner(
        `/api/reports/members/${world.colleague.id}?year=${YEAR.toString()}`
      );
      expect(report.body.changes[0].actor).toMatchObject({
        id: world.member.id,
        name: "Deleted account",
      });

      const events = await asOwner(
        `/api/group-events?year=${YEAR.toString()}&month=1&groupId=${world.first}`
      );
      expect(
        (events.body as { id: string; createdBy: { name: string } }[]).find(
          (event) => event.id === world.groupEventId
        )?.createdBy
      ).toMatchObject({ id: world.member.id, name: "Deleted account" });
    });
  });

  describe("refusals", () => {
    it("refuses while the open Employment cannot end, because the person manages a group", async () => {
      const world = await setUp();
      await db
        .update(groups)
        .set({ managerUserId: world.member.id })
        .where(eq(groups.id, world.second));

      const res = await erase(world.owner.id, world.employment.id, MEMBER);

      expect(res.status).toBe(409);
      expect(res.body.errors[0].context.code).toBe("MANAGES_GROUP");
      expect(await employmentsOf(world.organizationId, world.member.id)).toHaveLength(1);
    });

    it("refuses a name that is not the person's, and changes nothing", async () => {
      const world = await setUp();

      const res = await erase(world.owner.id, world.employment.id, "Jana Novak");

      expect(res.status).toBe(422);
      expect(res.body.errors[0].context.code).toBe("NAME_MISMATCH");
      expect(await employmentsOf(world.organizationId, world.member.id)).toHaveLength(1);
      expect(await attachmentStore.getObject(world.attachmentKey)).toBeDefined();
      expect(await organizationDataStore!.getObject(world.exportKey)).toBeDefined();
    });

    it("refuses a group's manager and a plain member, and answers 404 for no such Employment", async () => {
      const world = await setUp();

      expect((await erase(world.groupManager.id, world.employment.id, MEMBER)).status).toBe(403);
      expect((await erase(world.colleague.id, world.employment.id, MEMBER)).status).toBe(403);
      expect((await erase(world.owner.id, uuidv4(), MEMBER)).status).toBe(404);
      expect(await employmentsOf(world.organizationId, world.member.id)).toHaveLength(1);
    });

    it("refuses an account that was not deleted", async () => {
      const world = await setUp({ deleteMember: false });

      const res = await erase(world.owner.id, world.employment.id, MEMBER);

      expect(res.status).toBe(422);
      expect(res.body.errors[0].context.code).toBe("ACCOUNT_NOT_DELETED");
      expect(await employmentsOf(world.organizationId, world.member.id)).toHaveLength(1);
    });
  });
});
