import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { v4 as uuidv4 } from "uuid";
import {
  setupTestEnvironment,
  cleanupTestData,
  createTestGroup,
  createTestUser,
  type TestContext,
  type TestUser,
} from "./helpers/testSetup.js";
import { authCookieFor } from "./helpers/authHelper.js";
import { db } from "../../db/db.js";
import { vacation } from "../../db/schema/vacation-schema.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
import { organizationUsers } from "../../db/schema/organization-users-schema.js";
import { attachments, AttachmentStatus } from "../../db/schema/attachment-schema.js";
import { subscriptionPlan, subscriptionStatus } from "../../db/schema/subscription-schema.js";
import { ensureOrganizationForUser } from "../../services/organization/organizationServices.js";
import { upsertSubscription } from "../../services/billing/subscriptionServices.js";
import { getGroupDetailForSupport } from "../../services/support/supportServices.js";
import {
  AttachmentRejectionReason,
  sniffContentType,
} from "../../services/attachment/processor.js";
import { MAX_ATTACHMENT_BYTES, type UploadTarget } from "../../services/attachment/types.js";

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../services/attachment/tests/fixtures"
);
const fixture = (name: string) => readFileSync(path.join(fixturesDir, name));

const DAY_IN_MS = 24 * 60 * 60 * 1000;

describe("Attachments E2E", () => {
  let context: TestContext;
  let organizationId: string;
  let viewer: TestUser;
  let orgAdmin: TestUser;

  const addToGroup = async (
    userId: string,
    groupId: string,
    permissions: { viewAccess?: boolean; adminAccess?: boolean; controlledUser?: boolean } = {}
  ) => {
    await db.insert(groupUsers).values({
      id: uuidv4(),
      groupId,
      userId,
      viewAccess: permissions.viewAccess ?? false,
      adminAccess: permissions.adminAccess ?? false,
      approverAccess: false,
      controlledUser: permissions.controlledUser ?? true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  };

  /** A two-day Request inserted directly; creation itself is covered by the vacation suite. */
  const seedRequest = async (userId: string, groupId: string) => {
    const requestId = uuidv4();
    const ids = [uuidv4(), uuidv4()];
    await db.insert(vacation).values(
      ids.map((id, index) => ({
        id,
        userId,
        groupId,
        requestId,
        requestedDay: `2026-03-0${(index + 2).toString()}`,
        createdByUserId: userId,
      }))
    );
    return { requestId, vacationId: ids[0]! };
  };

  const create = (cookie: string, body: Record<string, unknown>) =>
    request(context.app).post("/api/attachments").set("Cookie", cookie).send(body);

  const pngBody = (requestId: string) => ({
    requestId,
    fileName: "note.png",
    contentType: "image/png",
    size: fixture("small.png").length,
  });

  /** Sends bytes to the target the create endpoint handed back, session-less like the browser would. */
  const upload = (target: UploadTarget, bytes: Buffer) => {
    const url = new URL(target.url);
    return request(context.app)
      .put(url.pathname + url.search)
      .set("Content-Type", target.headers["Content-Type"] ?? "application/octet-stream")
      .send(bytes);
  };

  const createAndUpload = async (cookie: string, body: Record<string, unknown>, bytes: Buffer) => {
    const created = await create(cookie, body).expect(201);
    const uploaded = await upload(created.body.upload as UploadTarget, bytes).expect(200);
    return { attachmentId: created.body.attachment.id as string, settled: uploaded.body };
  };

  /** Fetches a signed download link's bytes, session-less like the browser would. */
  const downloadBytes = (link: string) => {
    const url = new URL(link);
    return request(context.app)
      .get(url.pathname + url.search)
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => done(null, Buffer.concat(chunks)));
      })
      .expect(200);
  };

  const detail = (cookie: string, vacationId: string) =>
    request(context.app).get(`/api/vacation/${vacationId}`).set("Cookie", cookie);

  const setPaid = () =>
    upsertSubscription(organizationId, {
      plan: subscriptionPlan.Pro,
      status: subscriptionStatus.Active,
      graceEndsAt: null,
    });

  beforeAll(async () => {
    context = await setupTestEnvironment();
    organizationId = (await ensureOrganizationForUser(context.user1.id)).id;

    viewer = await createTestUser("viewer@test.com", "Viewer", "password123");
    orgAdmin = await createTestUser("orgadmin@test.com", "Org Admin", "password123");

    await addToGroup(context.user2.id, context.group.id);
    await addToGroup(viewer.id, context.group.id, { viewAccess: true, controlledUser: false });
    await db.insert(organizationUsers).values({
      id: uuidv4(),
      organizationId,
      userId: orgAdmin.id,
      grantedByUserId: context.user1.id,
    });
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  beforeEach(async () => {
    await db.delete(attachments);
    await db.delete(vacation);
    await setPaid();
  });

  describe("POST /api/attachments", () => {
    it("answers 402 PLAN_LIMIT when the organization is on the free plan", async () => {
      const freeOwner = await createTestUser("free-owner@test.com", "Free Owner", "password123");
      const freeGroup = await createTestGroup("Free Group", freeOwner.id);
      const { requestId } = await seedRequest(freeOwner.id, freeGroup.id);

      const response = await create(await authCookieFor(freeOwner.id), pngBody(requestId)).expect(
        402
      );

      expect(response.body.errors[0].context).toEqual({ reason: "PLAN_LIMIT" });
    });

    it("keeps uploads open through grace and closes them after it", async () => {
      const { requestId } = await seedRequest(context.user2.id, context.group.id);
      const cookie = await authCookieFor(context.user2.id);

      await upsertSubscription(organizationId, {
        status: subscriptionStatus.Canceled,
        graceEndsAt: new Date(Date.now() + DAY_IN_MS),
      });
      await create(cookie, pngBody(requestId)).expect(201);

      await upsertSubscription(organizationId, { graceEndsAt: new Date(Date.now() - DAY_IN_MS) });
      await create(cookie, pngBody(requestId)).expect(402);
    });

    it("answers 403 for an approver and a view-only member", async () => {
      const { requestId } = await seedRequest(context.user2.id, context.group.id);

      await create(await authCookieFor(context.approverUser.id), pngBody(requestId)).expect(403);
      await create(await authCookieFor(viewer.id), pngBody(requestId)).expect(403);
    });

    it("lets a group admin attach on the member's behalf, keeping the member as owner", async () => {
      const { requestId } = await seedRequest(context.user2.id, context.group.id);

      const response = await create(
        await authCookieFor(context.user1.id),
        pngBody(requestId)
      ).expect(201);

      expect(response.body.attachment).toMatchObject({
        requestId,
        uploadedByUserId: context.user1.id,
        status: AttachmentStatus.Uploading,
      });
      const [row] = await db.select().from(attachments);
      expect(row?.ownerUserId).toBe(context.user2.id);
    });

    it("answers 404 for a request that does not exist", async () => {
      await create(await authCookieFor(context.user2.id), pngBody(uuidv4())).expect(404);
    });

    it("answers 422 for an unsupported type", async () => {
      const { requestId } = await seedRequest(context.user2.id, context.group.id);

      const response = await create(await authCookieFor(context.user2.id), {
        ...pngBody(requestId),
        contentType: "image/gif",
      }).expect(422);

      expect(response.body.errors[0].context.reason).toBe("UNSUPPORTED_TYPE");
    });

    it("answers 422 for a file over 10 MB", async () => {
      const { requestId } = await seedRequest(context.user2.id, context.group.id);

      const response = await create(await authCookieFor(context.user2.id), {
        ...pngBody(requestId),
        size: MAX_ATTACHMENT_BYTES + 1,
      }).expect(422);

      expect(response.body.errors[0].context.reason).toBe("FILE_TOO_LARGE");
    });

    it("answers 422 for a sixth attachment, counting uploading and ready rows", async () => {
      const { requestId } = await seedRequest(context.user2.id, context.group.id);
      const cookie = await authCookieFor(context.user2.id);

      await createAndUpload(cookie, pngBody(requestId), fixture("small.png"));
      for (let i = 0; i < 4; i++) await create(cookie, pngBody(requestId)).expect(201);

      const response = await create(cookie, pngBody(requestId)).expect(422);

      expect(response.body.errors[0].context).toEqual({
        reason: "ATTACHMENT_LIMIT",
        limit: 5,
        current: 5,
      });
    });

    it("returns a PUT upload target with the declared content type", async () => {
      const { requestId } = await seedRequest(context.user2.id, context.group.id);

      const response = await create(
        await authCookieFor(context.user2.id),
        pngBody(requestId)
      ).expect(201);

      expect(response.body.upload).toMatchObject({
        method: "PUT",
        headers: { "Content-Type": "image/png" },
      });
      expect(new URL(response.body.upload.url as string).pathname).toBe(
        `/api/attachments/local/upload/${response.body.attachment.id as string}`
      );
      expect(new Date(response.body.upload.expiresAt as string).getTime()).toBeGreaterThan(
        Date.now()
      );
    });
  });

  describe("upload and processing", () => {
    it("turns a PNG into a READY JPEG the owner can fetch back", async () => {
      const { requestId, vacationId } = await seedRequest(context.user2.id, context.group.id);
      const cookie = await authCookieFor(context.user2.id);

      const { attachmentId, settled } = await createAndUpload(
        cookie,
        pngBody(requestId),
        fixture("small.png")
      );
      expect(settled).toEqual({
        id: attachmentId,
        status: AttachmentStatus.Ready,
        rejectionReason: null,
      });

      const shown = await detail(cookie, vacationId).expect(200);
      expect(shown.body.attachments).toHaveLength(1);
      expect(shown.body.attachments[0]).toMatchObject({
        id: attachmentId,
        fileName: "note.png",
        contentType: "image/jpeg",
        status: AttachmentStatus.Ready,
        rejectionReason: null,
      });
      expect(shown.body.canAttach).toBe(true);

      const link = await request(context.app)
        .get(`/api/attachments/${attachmentId}/download-url`)
        .set("Cookie", cookie)
        .expect(200);
      expect(link.body).toMatchObject({
        disposition: "inline",
        fileName: "note.jpg",
        contentType: "image/jpeg",
      });

      const bytes = await downloadBytes(link.body.url as string);
      expect(bytes.headers["content-type"]).toBe("image/jpeg");
      expect(bytes.headers["content-disposition"]).toBe(
        `inline; filename="note.jpg"; filename*=UTF-8''note.jpg`
      );
      expect(sniffContentType(bytes.body as Buffer)).toBe("image/jpeg");
    });

    it("turns a HEIC into a READY JPEG whose download name ends in .jpg", async () => {
      const { requestId, vacationId } = await seedRequest(context.user2.id, context.group.id);
      const cookie = await authCookieFor(context.user2.id);
      const heic = fixture("oversized-exif.heic");

      const { attachmentId, settled } = await createAndUpload(
        cookie,
        { requestId, fileName: "IMG_0001.HEIC", contentType: "image/heic", size: heic.length },
        heic
      );
      expect(settled).toEqual({
        id: attachmentId,
        status: AttachmentStatus.Ready,
        rejectionReason: null,
      });

      const shown = await detail(cookie, vacationId).expect(200);
      expect(shown.body.attachments[0]).toMatchObject({
        id: attachmentId,
        fileName: "IMG_0001.HEIC",
        contentType: "image/jpeg",
        status: AttachmentStatus.Ready,
      });

      const link = await request(context.app)
        .get(`/api/attachments/${attachmentId}/download-url`)
        .set("Cookie", cookie)
        .expect(200);
      expect(link.body).toMatchObject({ fileName: "IMG_0001.jpg", contentType: "image/jpeg" });

      const bytes = await downloadBytes(link.body.url as string);
      expect(bytes.headers["content-type"]).toBe("image/jpeg");
      expect(sniffContentType(bytes.body as Buffer)).toBe("image/jpeg");
      expect((bytes.body as Buffer).length).toBeLessThan(heic.length * 4);
    });

    it("rejects a HEIC that will not decode as unreadable", async () => {
      const { requestId } = await seedRequest(context.user2.id, context.group.id);
      const cookie = await authCookieFor(context.user2.id);
      const heic = fixture("oversized-exif.heic").subarray(0, 4096);

      const { settled } = await createAndUpload(
        cookie,
        { requestId, fileName: "IMG_0002.heic", contentType: "image/heic", size: heic.length },
        heic
      );
      expect(settled).toMatchObject({
        status: AttachmentStatus.Rejected,
        rejectionReason: AttachmentRejectionReason.ImageUnreadable,
      });
    });

    it("honours the attachment disposition on the download URL", async () => {
      const { requestId } = await seedRequest(context.user2.id, context.group.id);
      const cookie = await authCookieFor(context.user2.id);
      const { attachmentId } = await createAndUpload(
        cookie,
        { ...pngBody(requestId), fileName: "clean.pdf", contentType: "application/pdf" },
        fixture("clean.pdf")
      );

      const link = await request(context.app)
        .get(`/api/attachments/${attachmentId}/download-url`)
        .query({ disposition: "attachment" })
        .set("Cookie", cookie)
        .expect(200);
      expect(link.body).toMatchObject({ disposition: "attachment", fileName: "clean.pdf" });

      const url = new URL(link.body.url as string);
      const bytes = await request(context.app)
        .get(url.pathname + url.search)
        .expect(200);
      expect(bytes.headers["content-type"]).toBe("application/pdf");
      expect(bytes.headers["content-disposition"]).toMatch(/^attachment; filename="clean\.pdf"/);
    });

    it("rejects a PDF carrying JavaScript and refuses a download URL for it", async () => {
      const { requestId, vacationId } = await seedRequest(context.user2.id, context.group.id);
      const cookie = await authCookieFor(context.user2.id);

      const { attachmentId, settled } = await createAndUpload(
        cookie,
        { requestId, fileName: "scan.pdf", contentType: "application/pdf", size: 270 },
        fixture("javascript.pdf")
      );
      expect(settled).toMatchObject({
        status: AttachmentStatus.Rejected,
        rejectionReason: AttachmentRejectionReason.PdfJavaScript,
      });

      const shown = await detail(cookie, vacationId).expect(200);
      expect(shown.body.attachments[0]).toMatchObject({
        status: AttachmentStatus.Rejected,
        rejectionReason: AttachmentRejectionReason.PdfJavaScript,
      });

      const refused = await request(context.app)
        .get(`/api/attachments/${attachmentId}/download-url`)
        .set("Cookie", cookie)
        .expect(409);
      expect(refused.body.errors[0].context).toMatchObject({
        status: AttachmentStatus.Rejected,
        rejectionReason: AttachmentRejectionReason.PdfJavaScript,
      });
    });

    it("rejects bytes that do not match the claimed type", async () => {
      const { requestId } = await seedRequest(context.user2.id, context.group.id);

      const { settled } = await createAndUpload(
        await authCookieFor(context.user2.id),
        { ...pngBody(requestId), fileName: "note.jpg", contentType: "image/jpeg" },
        fixture("small.png")
      );

      expect(settled).toMatchObject({
        status: AttachmentStatus.Rejected,
        rejectionReason: AttachmentRejectionReason.TypeMismatch,
      });
    });

    it("refuses a tampered or expired upload link, and a second upload", async () => {
      const { requestId } = await seedRequest(context.user2.id, context.group.id);
      const cookie = await authCookieFor(context.user2.id);
      const created = await create(cookie, pngBody(requestId)).expect(201);
      const target = created.body.upload as UploadTarget;

      const tampered = new URL(target.url);
      tampered.searchParams.set("signature", "0".repeat(64));
      await upload({ ...target, url: tampered.toString() }, fixture("small.png")).expect(403);

      const expired = new URL(target.url);
      expired.searchParams.set("expires", (Date.now() - DAY_IN_MS).toString());
      await upload({ ...target, url: expired.toString() }, fixture("small.png")).expect(403);

      await upload(target, fixture("small.png")).expect(200);
      await upload(target, fixture("small.png")).expect(409);
    });

    it("answers 413 when the uploaded body exceeds 10 MB", async () => {
      const { requestId } = await seedRequest(context.user2.id, context.group.id);
      const created = await create(
        await authCookieFor(context.user2.id),
        pngBody(requestId)
      ).expect(201);

      const response = await upload(
        created.body.upload as UploadTarget,
        Buffer.alloc(MAX_ATTACHMENT_BYTES + 1)
      ).expect(413);

      expect(response.body.errors[0].context.reason).toBe("FILE_TOO_LARGE");
    });
  });

  describe("who sees attachments", () => {
    it("shows them to the owner, approvers, group admins and org admins, and hides them from a view-only member", async () => {
      const { requestId, vacationId } = await seedRequest(context.user2.id, context.group.id);
      await createAndUpload(
        await authCookieFor(context.user2.id),
        pngBody(requestId),
        fixture("small.png")
      );

      const expectations: [TestUser, boolean][] = [
        [context.user2, true],
        [context.approverUser, false],
        [context.user1, true],
        [orgAdmin, true],
      ];
      for (const [who, canAttach] of expectations) {
        const shown = await detail(await authCookieFor(who.id), vacationId).expect(200);
        expect(shown.body.attachments, who.name).toHaveLength(1);
        expect(shown.body.canAttach, who.name).toBe(canAttach);
      }

      const viewOnly = await detail(await authCookieFor(viewer.id), vacationId).expect(200);
      expect(viewOnly.body).not.toHaveProperty("attachments");
      expect(viewOnly.body).not.toHaveProperty("canAttach");
    });

    it("turns canAttach off for the owner once the plan lapses or the slots are used up", async () => {
      const { requestId, vacationId } = await seedRequest(context.user2.id, context.group.id);
      const cookie = await authCookieFor(context.user2.id);

      await upsertSubscription(organizationId, {
        status: subscriptionStatus.Canceled,
        graceEndsAt: new Date(Date.now() - DAY_IN_MS),
      });
      expect((await detail(cookie, vacationId).expect(200)).body.canAttach).toBe(false);

      await setPaid();
      for (let i = 0; i < 5; i++) await create(cookie, pngBody(requestId)).expect(201);
      expect((await detail(cookie, vacationId).expect(200)).body.canAttach).toBe(false);
    });

    it("refuses a download URL to the same callers the detail refuses", async () => {
      const { requestId } = await seedRequest(context.user2.id, context.group.id);
      const { attachmentId } = await createAndUpload(
        await authCookieFor(context.user2.id),
        pngBody(requestId),
        fixture("small.png")
      );

      await request(context.app)
        .get(`/api/attachments/${attachmentId}/download-url`)
        .set("Cookie", await authCookieFor(viewer.id))
        .expect(403);
      await request(context.app)
        .get(`/api/attachments/${attachmentId}/download-url`)
        .set("Cookie", await authCookieFor(context.approverUser.id))
        .expect(200);
    });

    it("never reaches the support surface", async () => {
      const { requestId } = await seedRequest(context.user2.id, context.group.id);
      await createAndUpload(
        await authCookieFor(context.user2.id),
        pngBody(requestId),
        fixture("small.png")
      );

      const support = await getGroupDetailForSupport(context.group.id);
      expect(support?.vacations).toHaveLength(2);
      for (const row of support!.vacations) {
        expect(row).not.toHaveProperty("attachments");
        expect(row).not.toHaveProperty("canAttach");
      }
    });
  });

  describe("GET /api/group/:groupId uploadsAvailable", () => {
    it("flips with the plan and grace state", async () => {
      const cookie = await authCookieFor(context.user1.id);
      const flag = async () =>
        (
          await request(context.app)
            .get(`/api/group/${context.group.id}`)
            .set("Cookie", cookie)
            .expect(200)
        ).body.uploadsAvailable as boolean;

      expect(await flag()).toBe(true);

      await upsertSubscription(organizationId, {
        status: subscriptionStatus.Canceled,
        graceEndsAt: new Date(Date.now() + DAY_IN_MS),
      });
      expect(await flag()).toBe(true);

      await upsertSubscription(organizationId, { graceEndsAt: new Date(Date.now() - DAY_IN_MS) });
      expect(await flag()).toBe(false);
    });
  });
});
