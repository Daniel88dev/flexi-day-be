import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { v4 as uuidv4 } from "uuid";
import { eq } from "drizzle-orm";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { db } from "../../db/db.js";
import { attachments, AttachmentStatus } from "../../db/schema/attachment-schema.js";
import { groupEvents } from "../../db/schema/group-event-schema.js";
import { notifications, notificationType } from "../../db/schema/notification-schema.js";
import { organizationAttendanceSettings } from "../../db/schema/organization-attendance-settings-schema.js";
import { organizations } from "../../db/schema/organization-schema.js";
import { organizationUsers } from "../../db/schema/organization-users-schema.js";
import { personExports, personExportStatus } from "../../db/schema/person-export-schema.js";
import { employments } from "../../db/schema/employment-schema.js";
import { readLog } from "../../db/schema/read-log-schema.js";
import { attachmentStore } from "../../services/attachment/attachmentStore.js";
import {
  organizationDataStore,
  type OrganizationDataStore,
} from "../../services/organizationData/organizationDataStore.js";
import { buildPersonExport } from "../../services/personExport/personExportBuild.js";
import { syncEmployment } from "../../services/employment/employmentServices.js";
import { ensureOrganizationForUser } from "../../services/organization/organizationServices.js";
import {
  createPersonExportQueue,
  installPersonExportQueue,
} from "../../services/personExport/personExportQueue.js";
import {
  authCookieFor,
  createWebUser,
  webSessionCookieFor,
  WEB_TEST_PASSWORD,
} from "./helpers/authHelper.js";
import {
  addLeave,
  addMember,
  makeGroup,
  makeUser,
  resetReportData,
} from "./helpers/reportFixtures.js";
import { cleanupTestData } from "./helpers/testSetup.js";
import { readZip } from "./helpers/readZip.js";

const ATTACHMENT_BYTES = Buffer.from("%PDF-1.4 a doctor's note");

const writeTempFile = async (text: string) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "organization-export-e2e-"));
  const file = path.join(directory, "file.zip");
  await writeFile(file, text);
  return file;
};

vi.mock("../../services/email/index.js", () => ({
  emailSender: { sendTemplated: () => Promise.resolve() },
}));

describe("Organization export", () => {
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

  const deleteAccount = async (email: string) => {
    const cookie = await webSessionCookieFor(server.url, email);
    return request(server.url)
      .post("/api/users/me/delete")
      .set("Cookie", cookie)
      .send({ password: WEB_TEST_PASSWORD });
  };

  /**
   * Olga owns an organization with two groups. Jana is in Support, Dana is a
   * delegated org admin, Gina manages Sales, and Alice was in Support until she
   * deleted her account.
   */
  const setUp = async () => {
    const owner = await createWebUser("Olga Owner");
    const member = await makeUser("Jana Nováková");
    const delegate = await makeUser("Dana Delegate");
    const groupManager = await makeUser("Gina Manager");
    const leaver = await createWebUser("Alice Leaver");
    const organizationId = (await ensureOrganizationForUser(owner.id)).id;

    const support = await makeGroup("Support", owner.id, { organizationOwnerId: owner.id });
    const sales = await makeGroup("Sales", groupManager.id, { organizationOwnerId: owner.id });
    await addMember(support, owner.id, {
      adminAccess: true,
      approverAccess: true,
      viewAccess: true,
    });
    await addMember(support, member.id, { viewAccess: true });
    await addMember(support, leaver.id);
    await addMember(sales, groupManager.id, { adminAccess: true, viewAccess: true });
    await addMember(sales, delegate.id);
    await db.insert(organizationUsers).values({
      id: uuidv4(),
      organizationId,
      userId: delegate.id,
      grantedByUserId: owner.id,
    });
    for (const id of [owner.id, member.id, delegate.id, groupManager.id, leaver.id]) {
      await syncEmployment(organizationId, id);
    }
    await addLeave(support, member.id, "2026-03-02", { approvedBy: owner.id });
    await addLeave(support, leaver.id, "2026-02-16", { approvedBy: owner.id });
    const requestId = uuidv4();
    await addLeave(support, member.id, "2026-04-10", { requestId });
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
    await db.insert(groupEvents).values({
      id: uuidv4(),
      groupId: support,
      createdByUserId: owner.id,
      title: "Team offsite",
      startDate: "2026-06-12",
      endDate: "2026-06-12",
    });
    await db.insert(organizationAttendanceSettings).values({
      organizationId,
      attendanceEnabled: true,
      timezone: "Europe/Prague",
    });
    await db.insert(notifications).values({
      id: uuidv4(),
      userId: member.id,
      type: notificationType.Comment,
      title: "ACCOUNT-MARKER-NOTICE",
      body: "account data",
    });
    expect((await deleteAccount(leaver.email)).status).toBe(204);

    return { owner, member, delegate, groupManager, leaver, organizationId, support, sales };
  };

  const requestExport = async (callerId: string, organizationId: string) =>
    request(server.url)
      .post(`/api/organization/export?organizationId=${organizationId}`)
      .set("Cookie", await authCookieFor(callerId));

  const buildNow = () => {
    const queue = createPersonExportQueue({ retryDelaysMs: [0, 0, 0], busyRetryMs: 0 });
    installPersonExportQueue(queue);
    return queue;
  };

  const download = async (callerId: string, exportId: string) => {
    const signed = await request(server.url)
      .post(`/api/person-exports/${exportId}/download`)
      .set("Cookie", await authCookieFor(callerId));
    expect(signed.status).toBe(200);
    const parsed = new URL(signed.body.url as string);
    const file = await request(server.url)
      .get(`${parsed.pathname}${parsed.search}`)
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => callback(null, Buffer.concat(chunks)));
      });
    expect(file.status).toBe(200);
    return { disposition: file.headers["content-disposition"] as string, zip: file.body as Buffer };
  };

  const readLogOf = (exportId: string) =>
    db.select().from(readLog).where(eq(readLog.personExportId, exportId));

  describe("who may request it", () => {
    it("lets the owner request it and writes one export row per person to the Read log", async () => {
      const world = await setUp();

      const res = await requestExport(world.owner.id, world.organizationId);

      expect(res.status).toBe(202);
      expect(res.body).toMatchObject({
        organizationId: world.organizationId,
        scope: "ORGANIZATION",
        subjectUserId: null,
        status: "PENDING",
      });
      const rows = await readLogOf(res.body.id);
      expect(rows.map((row) => row.subjectUserId).sort()).toEqual(
        [
          world.owner.id,
          world.member.id,
          world.delegate.id,
          world.groupManager.id,
          world.leaver.id,
        ].sort()
      );
      for (const row of rows) {
        expect(row).toMatchObject({
          kind: "export",
          organizationId: world.organizationId,
          readerUserId: world.owner.id,
          audience: "OWNER",
        });
        expect(row.employmentIds).toHaveLength(1);
      }

      const again = await requestExport(world.owner.id, world.organizationId);
      expect(again.status).toBe(202);
      expect(again.body.id).toBe(res.body.id);
      expect(await readLogOf(res.body.id)).toHaveLength(5);
    });

    it("refuses a delegated org admin and a group manager", async () => {
      const world = await setUp();

      const delegated = await requestExport(world.delegate.id, world.organizationId);
      expect(delegated.status).toBe(403);
      expect(delegated.body.errors[0].context.code).toBe("OWNER_ONLY");
      expect((await requestExport(world.groupManager.id, world.organizationId)).status).toBe(403);
      expect(
        await db.select().from(readLog).where(eq(readLog.organizationId, world.organizationId))
      ).toHaveLength(0);

      const listed = await request(server.url)
        .get(`/api/organization/export?organizationId=${world.organizationId}`)
        .set("Cookie", await authCookieFor(world.delegate.id));
      expect(listed.status).toBe(403);
    });
  });

  describe("the build", () => {
    it("holds organization.json and one Person export folder per person, and no account data", async () => {
      const world = await setUp();
      const queue = buildNow();

      const res = await requestExport(world.owner.id, world.organizationId);
      await queue.drain();

      const [row] = await db.select().from(personExports).where(eq(personExports.id, res.body.id));
      expect(row).toMatchObject({
        status: personExportStatus.Ready,
        storageKey: `exports/${world.organizationId}/${res.body.id}.zip`,
      });
      const { disposition, zip } = await download(world.owner.id, res.body.id);
      expect(disposition).toContain("flexi-day-organization-export-");
      const entries = readZip(zip);

      const organization = JSON.parse(entries.get("organization.json")!.toString("utf8"));
      expect(organization.organization).toMatchObject({
        id: world.organizationId,
        owner: "Olga Owner",
      });
      expect(organization.settings.attendance).toMatchObject({
        attendanceEnabled: true,
        timezone: "Europe/Prague",
      });
      expect(organization.groups.map((group: { name: string }) => group.name).sort()).toEqual([
        "Sales",
        "Support",
      ]);
      expect(organization.groups).toContainEqual(
        expect.objectContaining({ name: "Sales", manager: "Gina Manager" })
      );
      expect(organization.memberships).toContainEqual(
        expect.objectContaining({ groupId: world.support, name: "Alice Leaver" })
      );
      expect(organization.memberships).toHaveLength(5);
      expect(organization.administrators).toEqual([
        expect.objectContaining({ name: "Dana Delegate", grantedBy: "Olga Owner" }),
      ]);
      expect(organization.groupEvents).toEqual([
        expect.objectContaining({
          title: "Team offsite",
          groupName: "Support",
          createdBy: "Olga Owner",
        }),
      ]);

      const people = organization.people as { userId: string; name: string; folder: string }[];
      expect(people.map((person) => person.name).sort()).toEqual([
        "Alice Leaver",
        "Dana Delegate",
        "Gina Manager",
        "Jana Nováková",
        "Olga Owner",
      ]);
      for (const person of people) {
        expect(person.folder).toMatch(/^people\/.+-[A-Za-z0-9]{8}\/$/);
        for (const name of [
          "person.json",
          "bookings.csv",
          "attendance-sessions.csv",
          "quotas.csv",
          "changes.csv",
        ]) {
          expect(entries.has(`${person.folder}${name}`)).toBe(true);
        }
      }

      const jana = people.find((person) => person.userId === world.member.id)!;
      const janaJson = JSON.parse(entries.get(`${jana.folder}person.json`)!.toString("utf8"));
      expect(janaJson.bookings.map((booking: { day: string }) => booking.day)).toEqual([
        "2026-03-02",
        "2026-04-10",
      ]);
      const attachment = [...entries.keys()].find((name) =>
        name.startsWith(`${jana.folder}attachments/`)
      );
      expect(attachment).toMatch(/note\.pdf$/);
      expect(entries.get(attachment!)).toEqual(ATTACHMENT_BYTES);

      const alice = people.find((person) => person.userId === world.leaver.id)!;
      const aliceJson = JSON.parse(entries.get(`${alice.folder}person.json`)!.toString("utf8"));
      expect(aliceJson.employments).toEqual([
        expect.objectContaining({ name: "Alice Leaver", accountDeletedAt: expect.any(String) }),
      ]);
      expect(aliceJson.bookings).toHaveLength(1);

      const everything = [...entries.values()].map((bytes) => bytes.toString("utf8")).join("\n");
      expect(everything).not.toContain("ACCOUNT-MARKER-NOTICE");
    });

    it("tells the owner the export is ready and lists it as ready", async () => {
      const world = await setUp();
      const queue = buildNow();

      const res = await requestExport(world.owner.id, world.organizationId);
      await queue.drain();

      const notices = await db
        .select()
        .from(notifications)
        .where(eq(notifications.userId, world.owner.id));
      expect(notices).toContainEqual(
        expect.objectContaining({
          type: notificationType.ExportReady,
          href: "/organization/",
          body: expect.stringContaining("is ready to download for 7 days"),
        })
      );
      const latest = await request(server.url)
        .get(`/api/organization/export?organizationId=${world.organizationId}`)
        .set("Cookie", await authCookieFor(world.owner.id));
      expect(latest.status).toBe(200);
      expect(latest.body.export).toMatchObject({ id: res.body.id, status: "READY" });

      const people = await request(server.url)
        .get(`/api/employment/exports?organizationId=${world.organizationId}`)
        .set("Cookie", await authCookieFor(world.owner.id));
      expect(people.body).toEqual([]);
    });

    it("refuses to sign once the requester no longer owns the organization", async () => {
      const world = await setUp();
      const queue = buildNow();
      const res = await requestExport(world.owner.id, world.organizationId);
      await queue.drain();

      await db
        .update(organizations)
        .set({ ownerUserId: world.delegate.id })
        .where(eq(organizations.id, world.organizationId));

      const refused = await request(server.url)
        .post(`/api/person-exports/${res.body.id}/download`)
        .set("Cookie", await authCookieFor(world.owner.id));
      expect(refused.status).toBe(403);
      expect(refused.body.errors[0].context.code).toBe("FORBIDDEN");
    });
  });

  describe("deleting the organization", () => {
    /** Oscar owns a small organization whose only other person, Lena, deleted her account. */
    const setUpLeaving = async () => {
      const owner = await createWebUser("Oscar Owner");
      const leaver = await createWebUser("Lena Leaver");
      const organizationId = (await ensureOrganizationForUser(owner.id)).id;
      const group = await makeGroup("Workshop", owner.id, { organizationOwnerId: owner.id });
      await addMember(group, owner.id, { adminAccess: true, viewAccess: true });
      await addMember(group, leaver.id);
      await syncEmployment(organizationId, owner.id);
      await syncEmployment(organizationId, leaver.id);
      expect((await deleteAccount(leaver.email)).status).toBe(204);
      return { owner, leaver, organizationId };
    };

    it("lists the Deleted accounts that go with each owned organization", async () => {
      const world = await setUpLeaving();

      const res = await request(server.url)
        .get("/api/users/me/deletion")
        .set("Cookie", await authCookieFor(world.owner.id));

      expect(res.status).toBe(200);
      expect(res.body.canDelete).toBe(true);
      expect(res.body.ownedOrganizations).toEqual([
        {
          organizationId: world.organizationId,
          organizationName: expect.any(String),
          deletedAccounts: [{ userId: world.leaver.id, name: "Lena Leaver" }],
        },
      ]);

      const member = await request(server.url)
        .get("/api/users/me/deletion")
        .set("Cookie", await authCookieFor((await makeUser("Mo Member")).id));
      expect(member.body.ownedOrganizations).toEqual([]);
    });

    it("removes every object under the organization's exports/", async () => {
      const world = await setUpLeaving();
      const other = await setUp();
      const queue = buildNow();
      const store = organizationDataStore!;

      const whole = await requestExport(world.owner.id, world.organizationId);
      const [lena] = await db
        .select()
        .from(employments)
        .where(eq(employments.userId, world.leaver.id));
      const person = await request(server.url)
        .post(`/api/employment/${lena!.id}/export`)
        .set("Cookie", await authCookieFor(world.owner.id));
      expect(person.status).toBe(202);
      const kept = await requestExport(other.owner.id, other.organizationId);
      await queue.drain();
      const stray = `exports/${world.organizationId}/left-behind.zip`;
      await store.putFile(stray, await writeTempFile("stray"), "application/zip");

      const keys = [
        `exports/${world.organizationId}/${whole.body.id}.zip`,
        `exports/${world.organizationId}/${person.body.id}.zip`,
        stray,
      ];
      for (const key of keys) expect(await store.getObject(key)).toBeDefined();

      expect((await deleteAccount(world.owner.email)).status).toBe(204);

      for (const key of keys) expect(await store.getObject(key)).toBeUndefined();
      expect(
        await store.getObject(`exports/${other.organizationId}/${kept.body.id}.zip`)
      ).toBeDefined();
    });

    it("removes the file of a build that finishes after its organization went", async () => {
      const world = await setUpLeaving();
      const store = organizationDataStore!;
      const res = await requestExport(world.owner.id, world.organizationId);
      const key = `exports/${world.organizationId}/${res.body.id}.zip`;
      const racing: OrganizationDataStore = {
        ...store,
        putFile: async (target, file, type) => {
          await store.putFile(target, file, type);
          await db.delete(personExports).where(eq(personExports.id, res.body.id));
        },
      };

      expect(await buildPersonExport(res.body.id, { store: racing })).toEqual({ status: "done" });

      expect(await store.getObject(key)).toBeUndefined();
    });
  });
});
