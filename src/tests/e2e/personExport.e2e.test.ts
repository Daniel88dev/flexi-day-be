import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import request from "supertest";
import { v4 as uuidv4 } from "uuid";
import { and, eq, sql } from "drizzle-orm";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { db, pool } from "../../db/db.js";
import { user, session } from "../../db/schema/auth-schema.js";
import { attachments, AttachmentStatus } from "../../db/schema/attachment-schema.js";
import {
  attendanceBreaks,
  attendanceEvents,
  attendanceEventType,
  attendanceSessions,
} from "../../db/schema/attendance-schema.js";
import { employments } from "../../db/schema/employment-schema.js";
import { notifications, notificationType } from "../../db/schema/notification-schema.js";
import { organizationUsers } from "../../db/schema/organization-users-schema.js";
import { personExports, personExportStatus } from "../../db/schema/person-export-schema.js";
import { readLog } from "../../db/schema/read-log-schema.js";
import { vacationEvents, vacationEventType } from "../../db/schema/vacation-event-schema.js";
import { CalendarRecordType } from "../../db/schema/vacation-schema.js";
import { attachmentStore } from "../../services/attachment/attachmentStore.js";
import { syncEmployment } from "../../services/employment/employmentServices.js";
import { ensureOrganizationForUser } from "../../services/organization/organizationServices.js";
import {
  createDiskOrganizationDataStore,
  organizationDataStore,
} from "../../services/organizationData/organizationDataStore.js";
import { buildPersonExport } from "../../services/personExport/personExportBuild.js";
import {
  createPersonExportQueue,
  installPersonExportQueue,
} from "../../services/personExport/personExportQueue.js";
import { startPersonExportQueue } from "../../jobs/personExportQueueJob.js";
import { config } from "../../config.js";
import { authCookieFor } from "./helpers/authHelper.js";
import {
  addChange,
  addLeave,
  addMember,
  addQuota,
  makeGroup,
  makeUser,
  resetReportData,
} from "./helpers/reportFixtures.js";
import { cleanupTestData } from "./helpers/testSetup.js";
import { readZip } from "./helpers/readZip.js";

vi.mock("../../services/email/index.js", () => ({
  emailSender: { sendTemplated: () => Promise.resolve() },
}));

const ATTACHMENT_BYTES = Buffer.from("%PDF-1.4 a doctor's note");

describe("Person export", () => {
  let server: LoopbackServer;

  beforeAll(async () => {
    await resetReportData();
    await cleanupTestData();
    server = await listenOnLoopback(createServer());
  });

  afterEach(() => {
    installPersonExportQueue(undefined);
  });

  afterAll(async () => {
    await server?.close();
    await resetReportData();
    await cleanupTestData();
  });

  /**
   * Olga owns an organization with two groups. Jana belongs to both and holds
   * a quota, bookings in every state with a timeline, an attachment, an
   * attendance session with a break, an event and a location fix, and a
   * change. Dana is a delegated org admin, Gina manages the second group and
   * Pavel is a plain member. Jana also belongs to a friend's organization,
   * and carries account data that must stay out.
   */
  const setUp = async () => {
    const owner = await makeUser("Olga Owner");
    const member = await makeUser("Jana Nováková");
    const delegate = await makeUser("Dana Delegate");
    const groupManager = await makeUser("Gina Manager");
    const plainMember = await makeUser("Pavel Plain");
    const organizationId = (await ensureOrganizationForUser(owner.id)).id;

    const first = await makeGroup("Support", owner.id, { organizationOwnerId: owner.id });
    const second = await makeGroup("Sales", groupManager.id, { organizationOwnerId: owner.id });
    await addMember(first, owner.id, { adminAccess: true, approverAccess: true, viewAccess: true });
    await addMember(first, member.id, { viewAccess: true });
    await addMember(second, groupManager.id, { adminAccess: true, viewAccess: true });
    await addMember(second, member.id);
    await addMember(first, delegate.id);
    await addMember(second, plainMember.id);
    await db.insert(organizationUsers).values({
      id: uuidv4(),
      organizationId,
      userId: delegate.id,
      grantedByUserId: owner.id,
    });
    for (const id of [owner.id, member.id, delegate.id, groupManager.id, plainMember.id]) {
      await syncEmployment(organizationId, id);
    }
    const [employment] = await db
      .select()
      .from(employments)
      .where(
        and(eq(employments.organizationId, organizationId), eq(employments.userId, member.id))
      );

    await addQuota(first, member.id, 2026, { vacationDays: 25, carriedOverDays: 3 });
    const approved = await addLeave(first, member.id, "2026-03-02", {
      approvedBy: owner.id,
      note: "=cmd|' /C calc'!A0",
    });
    await db.insert(vacationEvents).values([
      {
        id: uuidv4(),
        vacationId: approved,
        eventType: vacationEventType.Created,
        actorUserId: member.id,
      },
      {
        id: uuidv4(),
        vacationId: approved,
        eventType: vacationEventType.Approved,
        actorUserId: owner.id,
      },
    ]);
    const requestId = uuidv4();
    await addLeave(second, member.id, "2026-04-10", {
      rejected: true,
      rejectedBy: groupManager.id,
      rejectionReason: "Team offsite",
      type: CalendarRecordType.HomeOffice,
      requestId,
    });
    const storageKey = `final/${uuidv4()}.pdf`;
    await attachmentStore.putObject(storageKey, ATTACHMENT_BYTES);
    await db.insert(attachments).values({
      id: uuidv4(),
      requestId,
      organizationId,
      ownerUserId: member.id,
      uploadedByUserId: member.id,
      fileName: "note.pdf",
      contentType: "application/pdf",
      size: ATTACHMENT_BYTES.length,
      storageKey,
      status: AttachmentStatus.Ready,
    });
    await addChange(first, member.id, owner.id, "Quota for 2026 set to 25 days");

    const sessionId = uuidv4();
    await db.insert(attendanceSessions).values({
      id: sessionId,
      employmentId: employment!.id,
      businessDate: "2026-03-03",
      startedAt: new Date("2026-03-03T07:00:00Z"),
      endedAt: new Date("2026-03-03T15:30:00Z"),
      timezone: "Europe/Prague",
      startLatitude: 50.0875,
      startLongitude: 14.4214,
      startAccuracy: 12,
    });
    await db.insert(attendanceBreaks).values({
      id: uuidv4(),
      sessionId,
      startedAt: new Date("2026-03-03T11:00:00Z"),
      endedAt: new Date("2026-03-03T11:30:00Z"),
    });
    await db.insert(attendanceEvents).values({
      id: uuidv4(),
      sessionId,
      eventType: attendanceEventType.SessionEdited,
      changedByUserId: owner.id,
      before: { endedAt: "2026-03-03T15:00:00Z" },
      after: { endedAt: "2026-03-03T15:30:00Z" },
    });

    const friend = await makeUser("Fiona Friend");
    const elsewhere = await makeGroup("Elsewhere", friend.id);
    await addMember(elsewhere, member.id);
    const elsewhereOrganizationId = (await ensureOrganizationForUser(friend.id)).id;
    await syncEmployment(elsewhereOrganizationId, member.id);
    await addLeave(elsewhere, member.id, "2026-05-05", { note: "OTHER-ORGANIZATION-MARKER" });

    await db.update(user).set({ image: "ACCOUNT-MARKER-IMAGE" }).where(eq(user.id, member.id));
    await db.insert(notifications).values({
      id: uuidv4(),
      userId: member.id,
      type: notificationType.Comment,
      title: "ACCOUNT-MARKER-NOTICE",
      body: "account data",
    });

    return {
      owner,
      member,
      delegate,
      groupManager,
      plainMember,
      friend,
      organizationId,
      elsewhereOrganizationId,
      employment: employment!,
    };
  };

  const adminRequest = async (callerId: string, employmentId: string) =>
    request(server.url)
      .post(`/api/employment/${employmentId}/export`)
      .set("Cookie", await authCookieFor(callerId));

  const ownRequest = async (callerId: string, organizationId: string) =>
    request(server.url)
      .post("/api/users/me/person-exports")
      .set("Cookie", await authCookieFor(callerId))
      .send({ organizationId });

  const sign = async (callerId: string, exportId: string) =>
    request(server.url)
      .post(`/api/person-exports/${exportId}/download`)
      .set("Cookie", await authCookieFor(callerId));

  const exportRow = async (exportId: string) => {
    const [row] = await db.select().from(personExports).where(eq(personExports.id, exportId));
    return row!;
  };

  const readLogFor = (subjectUserId: string) =>
    db.select().from(readLog).where(eq(readLog.subjectUserId, subjectUserId));

  const download = async (url: string) => {
    const parsed = new URL(url);
    const res = await request(server.url)
      .get(`${parsed.pathname}${parsed.search}`)
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => callback(null, Buffer.concat(chunks)));
      });
    return res;
  };

  const buildNow = async () => {
    const queue = createPersonExportQueue({ retryDelaysMs: [0, 0, 0], busyRetryMs: 0 });
    installPersonExportQueue(queue);
    return queue;
  };

  describe("who may request one", () => {
    it("lets the owner export any Employment and writes one export row to the Read log", async () => {
      const world = await setUp();

      const res = await adminRequest(world.owner.id, world.employment.id);

      expect(res.status).toBe(202);
      expect(res.body).toMatchObject({
        organizationId: world.organizationId,
        subjectUserId: world.member.id,
        status: "PENDING",
        readyAt: null,
      });
      const rows = await readLogFor(world.member.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        kind: "export",
        organizationId: world.organizationId,
        readerUserId: world.owner.id,
        subjectUserId: world.member.id,
        employmentIds: [world.employment.id],
        audience: "OWNER",
        personExportId: res.body.id,
      });

      const again = await adminRequest(world.owner.id, world.employment.id);
      expect(again.status).toBe(202);
      expect(again.body.id).toBe(res.body.id);
      expect(await readLogFor(world.member.id)).toHaveLength(1);
    });

    it("lets a delegated org admin export, and refuses a group manager and a plain member", async () => {
      const world = await setUp();

      const delegated = await adminRequest(world.delegate.id, world.employment.id);
      expect(delegated.status).toBe(202);
      const [row] = await readLogFor(world.member.id);
      expect(row).toMatchObject({
        readerUserId: world.delegate.id,
        audience: "ORGANIZATION_ADMIN",
      });

      expect((await adminRequest(world.groupManager.id, world.employment.id)).status).toBe(403);
      expect((await adminRequest(world.plainMember.id, world.employment.id)).status).toBe(403);
      expect((await adminRequest(world.owner.id, uuidv4())).status).toBe(404);
      expect(await readLogFor(world.member.id)).toHaveLength(1);

      const list = await request(server.url)
        .get(`/api/employment/exports?organizationId=${world.organizationId}`)
        .set("Cookie", await authCookieFor(world.groupManager.id));
      expect(list.status).toBe(403);
    });

    it("lets a person export only organizations where their account is bound", async () => {
      const world = await setUp();

      const own = await ownRequest(world.member.id, world.organizationId);
      expect(own.status).toBe(202);
      expect(own.body).toMatchObject({ subjectUserId: world.member.id, status: "PENDING" });
      const [row] = await readLogFor(world.member.id);
      expect(row).toMatchObject({ readerUserId: world.member.id, audience: "SELF" });

      const stranger = await makeUser("Stan Stranger");
      const refused = await ownRequest(stranger.id, world.organizationId);
      expect(refused.status).toBe(403);
      expect(refused.body.errors[0].context.code).toBe("NOT_EMPLOYED");

      const listed = await request(server.url)
        .get("/api/users/me/person-exports")
        .set("Cookie", await authCookieFor(world.member.id));
      expect(listed.status).toBe(200);
      const byOrganization = new Map(
        (listed.body.organizations as { organizationId: string; export: unknown }[]).map(
          (entry) => [entry.organizationId, entry]
        )
      );
      expect([...byOrganization.keys()].sort()).toEqual(
        [world.organizationId, world.elsewhereOrganizationId].sort()
      );
      expect(byOrganization.get(world.organizationId)).toMatchObject({
        organizationName: expect.any(String),
        employmentId: world.employment.id,
        export: { id: own.body.id, status: "PENDING" },
      });
      expect(byOrganization.get(world.elsewhereOrganizationId)).toMatchObject({ export: null });
    });

    it("keeps an ended Employment exportable, by its admin and by the person", async () => {
      const world = await setUp();
      await db
        .update(employments)
        .set({ endedAt: new Date() })
        .where(eq(employments.id, world.employment.id));

      expect((await adminRequest(world.owner.id, world.employment.id)).status).toBe(202);
      expect((await ownRequest(world.member.id, world.organizationId)).status).toBe(202);
    });
  });

  describe("the build", () => {
    it("builds a ZIP with person.json, the four CSVs and the attachments, and no account data", async () => {
      const world = await setUp();
      const queue = await buildNow();

      const res = await adminRequest(world.owner.id, world.employment.id);
      await queue.drain();

      const row = await exportRow(res.body.id);
      expect(row.status).toBe(personExportStatus.Ready);
      expect(row.storageKey).toBe(`exports/${world.organizationId}/${row.id}.zip`);

      const signed = await sign(world.owner.id, row.id);
      expect(signed.status).toBe(200);
      const file = await download(signed.body.url);
      expect(file.status).toBe(200);
      expect(file.headers["content-type"]).toBe("application/zip");
      const zip = file.body as Buffer;
      const entries = readZip(zip);

      expect([...entries.keys()].sort()).toEqual(
        [
          "attendance-sessions.csv",
          "bookings.csv",
          "changes.csv",
          "person.json",
          "quotas.csv",
          expect.stringMatching(/^attachments\/[0-9a-f]{8}-note\.pdf$/),
        ].sort()
      );
      const attachmentEntry = [...entries.keys()].find((name) => name.startsWith("attachments/"))!;
      expect(entries.get(attachmentEntry)).toEqual(ATTACHMENT_BYTES);

      const person = JSON.parse(entries.get("person.json")!.toString("utf8"));
      expect(person.organization).toMatchObject({ id: world.organizationId });
      expect(person.employments).toEqual([
        expect.objectContaining({ id: world.employment.id, name: "Jana Nováková", endedAt: null }),
      ]);
      expect(person.groups.map((group: { groupName: string }) => group.groupName).sort()).toEqual([
        "Sales",
        "Support",
      ]);
      expect(person.quotas).toEqual([
        expect.objectContaining({
          groupName: "Support",
          year: "2026",
          vacationDays: 25,
          carriedOverDays: 3,
        }),
      ]);
      expect(person.bookings).toEqual([
        expect.objectContaining({
          day: "2026-03-02",
          status: "APPROVED",
          approvedBy: "Olga Owner",
          timeline: [
            expect.objectContaining({ type: "CREATED", by: "Jana Nováková" }),
            expect.objectContaining({ type: "APPROVED", by: "Olga Owner" }),
          ],
        }),
        expect.objectContaining({
          day: "2026-04-10",
          status: "REJECTED",
          rejectedBy: "Gina Manager",
          rejectionReason: "Team offsite",
        }),
      ]);
      expect(person.attachments).toEqual([
        expect.objectContaining({ fileName: "note.pdf", file: attachmentEntry }),
      ]);
      expect(person.attendanceSessions).toEqual([
        expect.objectContaining({
          businessDate: "2026-03-03",
          startLocation: { latitude: 50.0875, longitude: 14.4214, accuracy: 12 },
          endLocation: null,
          breaks: [expect.objectContaining({ startedAt: "2026-03-03T11:00:00.000Z" })],
          events: [expect.objectContaining({ type: "SESSION_EDITED", by: "Olga Owner" })],
        }),
      ]);
      expect(person.changes).toEqual([
        expect.objectContaining({ detail: "Quota for 2026 set to 25 days", by: "Olga Owner" }),
      ]);
      expect(person.readLog).toEqual([
        { at: expect.any(String), kind: "export", purpose: "owner" },
      ]);

      const bookings = entries.get("bookings.csv")!.toString("utf8").split("\r\n");
      expect(bookings[0]).toMatch(/^id,request_id,group,day,type,/);
      expect(bookings).toHaveLength(4);
      expect(bookings[1]).toContain(",'=cmd|' /C calc'!A0,");
      const sessions = entries.get("attendance-sessions.csv")!.toString("utf8").split("\r\n");
      expect(sessions[1]).toContain(",30,");
      expect(entries.get("quotas.csv")!.toString("utf8")).toContain("Support,2026,25,0,0,3");
      expect(entries.get("changes.csv")!.toString("utf8")).toContain(
        "Quota for 2026 set to 25 days,Olga Owner"
      );

      const everything = [...entries.values()].map((bytes) => bytes.toString("utf8")).join("\n");
      expect(everything).not.toContain("ACCOUNT-MARKER-IMAGE");
      expect(everything).not.toContain("ACCOUNT-MARKER-NOTICE");
      expect(everything).not.toContain("OTHER-ORGANIZATION-MARKER");
      const [ownSession] = await db
        .select({ token: session.token })
        .from(session)
        .where(eq(session.userId, world.member.id));
      if (ownSession) expect(everything).not.toContain(ownSession.token);
    });

    it("tells the requester the export is ready, in-app, and lists it as ready", async () => {
      const world = await setUp();
      const queue = await buildNow();

      const res = await adminRequest(world.delegate.id, world.employment.id);
      await queue.drain();

      const notices = await db
        .select()
        .from(notifications)
        .where(eq(notifications.userId, world.delegate.id));
      expect(notices).toEqual([
        expect.objectContaining({
          type: notificationType.ExportReady,
          title: "Your export is ready",
          href: "/organization/",
        }),
      ]);
      expect(notices[0]!.body).toContain("Jana Nováková");

      const list = await request(server.url)
        .get(`/api/employment/exports?organizationId=${world.organizationId}`)
        .set("Cookie", await authCookieFor(world.delegate.id));
      expect(list.body).toEqual([
        expect.objectContaining({
          id: res.body.id,
          status: "READY",
          subjectUserId: world.member.id,
        }),
      ]);
    });

    it("tells a person who exported themselves, with a link to Settings", async () => {
      const world = await setUp();
      const queue = await buildNow();

      await ownRequest(world.member.id, world.organizationId);
      await queue.drain();

      const [notice] = await db
        .select()
        .from(notifications)
        .where(
          and(
            eq(notifications.userId, world.member.id),
            eq(notifications.type, notificationType.ExportReady)
          )
        );
      expect(notice).toMatchObject({ href: "/settings/" });
    });
  });

  describe("a restart", () => {
    it("resumes a build cut off by a restart and finishes it from its row", async () => {
      const world = await setUp();
      const res = await adminRequest(world.owner.id, world.employment.id);
      // The build had started (one attempt) when the process went away.
      await db.update(personExports).set({ attempts: 1 }).where(eq(personExports.id, res.body.id));

      const queue = createPersonExportQueue({ retryDelaysMs: [0, 0, 0] });
      installPersonExportQueue(queue);
      await startPersonExportQueue();
      await queue.drain();

      const row = await exportRow(res.body.id);
      expect(row).toMatchObject({ status: personExportStatus.Ready, attempts: 2 });
      expect(await organizationDataStore!.getObject(row.storageKey!)).toBeDefined();
    });

    it("finishes on the retry when a build fails part-way", async () => {
      const world = await setUp();
      const disk = createDiskOrganizationDataStore(config.organizationData.localDir);
      let calls = 0;
      const flaky = {
        ...disk,
        putFile: async (key: string, filePath: string, contentType: string) => {
          calls += 1;
          if (calls === 1) throw new Error("connection reset");
          return disk.putFile(key, filePath, contentType);
        },
      };
      const queue = createPersonExportQueue({
        run: (id) => buildPersonExport(id, { store: flaky }),
        retryDelaysMs: [0, 0, 0],
      });
      installPersonExportQueue(queue);

      const res = await adminRequest(world.owner.id, world.employment.id);
      await queue.drain();

      expect(await exportRow(res.body.id)).toMatchObject({
        status: personExportStatus.Ready,
        attempts: 2,
      });
    });

    it("marks the export failed once every retry is spent", async () => {
      const world = await setUp();
      const broken = {
        ...createDiskOrganizationDataStore(config.organizationData.localDir),
        putFile: () => Promise.reject(new Error("bucket gone")),
      };
      const queue = createPersonExportQueue({
        run: (id) => buildPersonExport(id, { store: broken }),
        retryDelaysMs: [0, 0, 0],
      });
      installPersonExportQueue(queue);

      const res = await adminRequest(world.owner.id, world.employment.id);
      await queue.drain();

      expect(await exportRow(res.body.id)).toMatchObject({
        status: personExportStatus.Failed,
        attempts: 4,
      });
      expect((await sign(world.owner.id, res.body.id)).status).toBe(409);
    });

    it("leaves a build another instance holds alone", async () => {
      const world = await setUp();
      const res = await adminRequest(world.owner.id, world.employment.id);

      const other = await pool.connect();
      try {
        await other.query("select pg_advisory_lock(hashtextextended($1, 0))", [
          `person-export:${res.body.id as string}`,
        ]);
        expect(await buildPersonExport(res.body.id)).toEqual({ status: "busy" });
        expect(await exportRow(res.body.id)).toMatchObject({
          status: personExportStatus.Pending,
          attempts: 0,
        });
      } finally {
        await other.query("select pg_advisory_unlock_all()");
        other.release();
      }

      expect(await buildPersonExport(res.body.id)).toEqual({ status: "done" });
      expect((await exportRow(res.body.id)).status).toBe(personExportStatus.Ready);
    });
  });

  describe("the download link", () => {
    it("lasts an hour, signs again while the file lives, and is refused after 7 days", async () => {
      const world = await setUp();
      const queue = await buildNow();
      const res = await adminRequest(world.owner.id, world.employment.id);

      expect((await sign(world.owner.id, res.body.id)).body.errors[0].context.code).toBe(
        "EXPORT_NOT_READY"
      );
      await queue.drain();

      const row = await exportRow(res.body.id);
      expect(row.expiresAt!.getTime() - row.readyAt!.getTime()).toBe(7 * 24 * 60 * 60 * 1000);

      const before = Date.now();
      const first = await sign(world.owner.id, res.body.id);
      expect(first.status).toBe(200);
      const lifetime = Date.parse(first.body.expiresAt) - before;
      expect(lifetime).toBeGreaterThan(59 * 60 * 1000);
      expect(lifetime).toBeLessThanOrEqual(60 * 60 * 1000 + 1000);
      expect(new URL(first.body.url).searchParams.get("expires")).toBe(
        Date.parse(first.body.expiresAt).toString()
      );

      // Six days on, the file still lives and the link signs again.
      await db
        .update(personExports)
        .set({ expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) })
        .where(eq(personExports.id, row.id));
      const again = await sign(world.owner.id, res.body.id);
      expect(again.status).toBe(200);
      expect((await download(again.body.url)).status).toBe(200);

      expect((await sign(world.delegate.id, res.body.id)).status).toBe(404);

      await db
        .update(personExports)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(personExports.id, row.id));
      const expired = await sign(world.owner.id, res.body.id);
      expect(expired.status).toBe(410);
      expect(expired.body.errors[0].context.code).toBe("EXPORT_EXPIRED");

      const list = await request(server.url)
        .get(`/api/employment/exports?organizationId=${world.organizationId}`)
        .set("Cookie", await authCookieFor(world.owner.id));
      expect(list.body).toEqual([]);
    });

    it("refuses a tampered or lapsed local link", async () => {
      const world = await setUp();
      const queue = await buildNow();
      const res = await adminRequest(world.owner.id, world.employment.id);
      await queue.drain();
      const { body } = await sign(world.owner.id, res.body.id);

      const tampered = new URL(body.url);
      tampered.searchParams.set("key", `exports/${world.elsewhereOrganizationId}/x.zip`);
      expect((await download(tampered.toString())).status).toBe(403);

      const lapsed = new URL(body.url);
      lapsed.searchParams.set("expires", (Date.now() - 1000).toString());
      expect((await download(lapsed.toString())).status).toBe(403);
    });
  });

  describe("the Read log", () => {
    it("refuses every update to a row", async () => {
      const world = await setUp();
      await adminRequest(world.owner.id, world.employment.id);
      const [row] = await readLogFor(world.member.id);

      await expect(
        db.execute(
          sql`update read_log set reader_user_id = ${world.plainMember.id} where id = ${row!.id}`
        )
      ).rejects.toThrow();
      expect((await readLogFor(world.member.id))[0]).toMatchObject({
        readerUserId: world.owner.id,
      });
    });
  });
});
