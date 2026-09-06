import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { v4 as uuidv4 } from "uuid";
import { eq } from "drizzle-orm";
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
import { attachmentStore } from "../../services/attachment/attachmentStore.js";
import { sweepAttachments } from "../../services/attachment/attachmentRetention.js";
import {
  ATTACHMENT_SIGNATURE_HEADER,
  signAttachmentCallback,
} from "../../services/attachment/callbackSignature.js";
import { finalStorageKey } from "../../services/attachment/s3Layout.js";
import { config } from "../../config.js";

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../services/attachment/tests/fixtures"
);
const fixture = (name: string) => readFileSync(path.join(fixturesDir, name));

const DAY_IN_MS = 24 * 60 * 60 * 1000;
// Next year, so a seeded Request is never past retention on the wall clock.
const REQUEST_YEAR = new Date().getFullYear() + 1;

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
  const seedRequest = async (userId: string, groupId: string, year = REQUEST_YEAR) => {
    const requestId = uuidv4();
    const ids = [uuidv4(), uuidv4()];
    await db.insert(vacation).values(
      ids.map((id, index) => ({
        id,
        userId,
        groupId,
        requestId,
        requestedDay: `${year.toString()}-03-0${(index + 2).toString()}`,
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
    if (target.method !== "PUT") throw new Error("The disk store hands out PUT targets");
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

  const remove = (cookie: string, attachmentId: string) =>
    request(context.app).delete(`/api/attachments/${attachmentId}`).set("Cookie", cookie);

  const rowFor = async (attachmentId: string) => {
    const [row] = await db.select().from(attachments).where(eq(attachments.id, attachmentId));
    return row;
  };

  /** The stored bytes, looked up by key so the check works after the row is gone. */
  const stored = (storageKey: string) => attachmentStore.getObject(storageKey);

  const uploadedByOwner = async (requestId: string) => {
    const { attachmentId } = await createAndUpload(
      await authCookieFor(context.user2.id),
      pngBody(requestId),
      fixture("small.png")
    );
    const row = await rowFor(attachmentId);
    expect(await stored(row!.storageKey)).toBeDefined();
    return { attachmentId, storageKey: row!.storageKey };
  };

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

    it("keeps accepting files while one day of the Request lives, and stops once none does", async () => {
      const { requestId } = await seedRequest(context.user2.id, context.group.id);
      const cookie = await authCookieFor(context.user2.id);
      const days = await db.select().from(vacation).where(eq(vacation.requestId, requestId));

      await request(context.app)
        .delete(`/api/vacation/${days[0]!.id}`)
        .set("Cookie", cookie)
        .expect(200);
      await create(cookie, pngBody(requestId)).expect(201);
      expect((await detail(cookie, days[1]!.id).expect(200)).body.canAttach).toBe(true);

      await request(context.app)
        .delete(`/api/vacation/${days[1]!.id}`)
        .set("Cookie", cookie)
        .expect(200);
      await create(cookie, pngBody(requestId)).expect(403);
    });

    it("refuses a Request whose last day is over twelve months gone, and the detail agrees", async () => {
      const { requestId, vacationId } = await seedRequest(
        context.user2.id,
        context.group.id,
        new Date().getFullYear() - 2
      );
      const cookie = await authCookieFor(context.user2.id);

      const refused = await create(cookie, pngBody(requestId)).expect(403);
      expect(refused.body.errors[0].context).toEqual({ reason: "RETENTION_EXPIRED" });
      expect((await detail(cookie, vacationId).expect(200)).body.canAttach).toBe(false);
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
      expect(link.headers["cache-control"]).toBe("no-store");
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
      // The frontend embeds the bytes in an <img> from another origin.
      expect(bytes.headers["cross-origin-resource-policy"]).toBe("cross-origin");
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

    it("stores only a byte body: an empty one and a JSON array are refused and the row keeps waiting", async () => {
      const { requestId } = await seedRequest(context.user2.id, context.group.id);
      const created = await create(
        await authCookieFor(context.user2.id),
        pngBody(requestId)
      ).expect(201);
      const attachmentId = created.body.attachment.id as string;
      const target = created.body.upload as UploadTarget;

      await upload(target, Buffer.alloc(0)).expect(422);

      // The app's JSON parser runs first, so this reaches the handler as a
      // real array rather than as bytes; the Buffer check is what refuses it.
      const url = new URL(target.url);
      await request(context.app)
        .put(url.pathname + url.search)
        .set("Content-Type", "application/json")
        .send([1, 2, 3])
        .expect(422);

      expect((await rowFor(attachmentId))?.status).toBe(AttachmentStatus.Uploading);
      await upload(target, fixture("small.png")).expect(200);
    });

    it("keeps every disk write under the store root", async () => {
      await expect(attachmentStore.putObject("../escape", Buffer.from("x"))).rejects.toThrow(
        "escapes the store root"
      );
      await expect(attachmentStore.getObject("../../etc/passwd")).rejects.toThrow(
        "escapes the store root"
      );
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

      const expectations: [TestUser, { canAttach: boolean; canDeleteAnyAttachment: boolean }][] = [
        [context.user2, { canAttach: true, canDeleteAnyAttachment: false }],
        [context.approverUser, { canAttach: false, canDeleteAnyAttachment: false }],
        [context.user1, { canAttach: true, canDeleteAnyAttachment: true }],
        [orgAdmin, { canAttach: true, canDeleteAnyAttachment: true }],
      ];
      for (const [who, flags] of expectations) {
        const shown = await detail(await authCookieFor(who.id), vacationId).expect(200);
        expect(shown.body.attachments, who.name).toHaveLength(1);
        expect(shown.body, who.name).toMatchObject(flags);
      }

      const viewOnly = await detail(await authCookieFor(viewer.id), vacationId).expect(200);
      expect(viewOnly.body).not.toHaveProperty("attachments");
      expect(viewOnly.body).not.toHaveProperty("canAttach");
      expect(viewOnly.body).not.toHaveProperty("canDeleteAnyAttachment");
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

  describe("DELETE /api/attachments/:id", () => {
    it("lets the uploader delete their own file, keeping the row as history", async () => {
      const { requestId, vacationId } = await seedRequest(context.user2.id, context.group.id);
      const cookie = await authCookieFor(context.user2.id);
      const { attachmentId, storageKey } = await uploadedByOwner(requestId);

      const response = await remove(cookie, attachmentId).expect(200);

      expect(response.body.attachment).toMatchObject({
        id: attachmentId,
        deletedByUserId: context.user2.id,
      });
      expect(typeof response.body.attachment.deletedAt).toBe("string");
      expect(await stored(storageKey)).toBeUndefined();
      expect(await rowFor(attachmentId)).toMatchObject({
        deletedByUserId: context.user2.id,
        deletedAt: expect.any(Date) as Date,
      });

      const shown = await detail(cookie, vacationId).expect(200);
      expect(shown.body.attachments).toHaveLength(1);
      expect(shown.body.attachments[0]).toMatchObject({
        id: attachmentId,
        status: AttachmentStatus.Ready,
        deletedByUserId: context.user2.id,
      });
      expect(typeof shown.body.attachments[0].deletedAt).toBe("string");

      await request(context.app)
        .get(`/api/attachments/${attachmentId}/download-url`)
        .set("Cookie", cookie)
        .expect(404);
      await remove(cookie, attachmentId).expect(404);
    });

    it("lets a group admin and an org admin delete a member's file", async () => {
      const { requestId } = await seedRequest(context.user2.id, context.group.id);
      const first = await uploadedByOwner(requestId);
      const second = await uploadedByOwner(requestId);

      const byGroupAdmin = await remove(
        await authCookieFor(context.user1.id),
        first.attachmentId
      ).expect(200);
      expect(byGroupAdmin.body.attachment.deletedByUserId).toBe(context.user1.id);
      expect(await stored(first.storageKey)).toBeUndefined();

      const byOrgAdmin = await remove(await authCookieFor(orgAdmin.id), second.attachmentId).expect(
        200
      );
      expect(byOrgAdmin.body.attachment.deletedByUserId).toBe(orgAdmin.id);
      expect(await stored(second.storageKey)).toBeUndefined();
    });

    it("answers 403 for an approver and a view-only member, leaving the file in place", async () => {
      const { requestId } = await seedRequest(context.user2.id, context.group.id);
      const { attachmentId, storageKey } = await uploadedByOwner(requestId);

      await remove(await authCookieFor(context.approverUser.id), attachmentId).expect(403);
      await remove(await authCookieFor(viewer.id), attachmentId).expect(403);

      expect(await stored(storageKey)).toBeDefined();
      expect((await rowFor(attachmentId))?.deletedAt).toBeNull();
    });

    it("answers 404 for an attachment that does not exist", async () => {
      await remove(await authCookieFor(context.user2.id), uuidv4()).expect(404);
    });

    it("refuses an uploader who has since lost their standing in the organization", async () => {
      const { requestId } = await seedRequest(context.user2.id, context.group.id);
      const cookie = await authCookieFor(orgAdmin.id);
      const { attachmentId } = await createAndUpload(
        cookie,
        pngBody(requestId),
        fixture("small.png")
      );

      await db.delete(organizationUsers).where(eq(organizationUsers.userId, orgAdmin.id));
      try {
        await remove(cookie, attachmentId).expect(403);
        expect((await rowFor(attachmentId))?.deletedAt).toBeNull();
      } finally {
        await db.insert(organizationUsers).values({
          id: uuidv4(),
          organizationId,
          userId: orgAdmin.id,
          grantedByUserId: context.user1.id,
        });
      }
    });

    it("lets the uploader clear an upload that never finished", async () => {
      const { requestId } = await seedRequest(context.user2.id, context.group.id);
      const cookie = await authCookieFor(context.user2.id);
      const created = await create(cookie, pngBody(requestId)).expect(201);
      const attachmentId = created.body.attachment.id as string;

      // As if the Lambda had stored the result before its report landed.
      const row = (await rowFor(attachmentId))!;
      const finalKey = finalStorageKey(row.storageKey, "image/jpeg");
      await attachmentStore.putObject(finalKey, fixture("small.png"));

      const response = await remove(cookie, attachmentId).expect(200);

      expect(response.body.attachment).toMatchObject({
        id: attachmentId,
        status: AttachmentStatus.Uploading,
        deletedByUserId: context.user2.id,
      });
      expect(await stored(finalKey)).toBeUndefined();
      await upload(created.body.upload as UploadTarget, fixture("small.png")).expect(404);
    });

    it("frees the slot the deleted file held", async () => {
      const { requestId, vacationId } = await seedRequest(context.user2.id, context.group.id);
      const cookie = await authCookieFor(context.user2.id);
      const { attachmentId } = await uploadedByOwner(requestId);
      for (let i = 0; i < 4; i++) await create(cookie, pngBody(requestId)).expect(201);
      expect((await detail(cookie, vacationId).expect(200)).body.canAttach).toBe(false);

      await remove(cookie, attachmentId).expect(200);

      expect((await detail(cookie, vacationId).expect(200)).body.canAttach).toBe(true);
      await create(cookie, pngBody(requestId)).expect(201);
    });
  });

  describe("POST /api/attachments/processed", () => {
    const secret = config.attachments.callbackSecret!;

    const report = (payload: unknown, signature?: string) => {
      const pending = request(context.app)
        .post("/api/attachments/processed")
        .set("Content-Type", "application/json");
      if (signature !== undefined) pending.set(ATTACHMENT_SIGNATURE_HEADER, signature);
      return pending.send(JSON.stringify(payload));
    };

    const signed = (payload: unknown) =>
      report(payload, signAttachmentCallback(secret, JSON.stringify(payload)));

    /** A row waiting for bytes, as the Lambda would find it. */
    const pendingUpload = async (file?: Omit<ReturnType<typeof pngBody>, "requestId">) => {
      const { requestId, vacationId } = await seedRequest(context.user2.id, context.group.id);
      const created = await create(await authCookieFor(context.user2.id), {
        ...pngBody(requestId),
        ...file,
      }).expect(201);
      const attachmentId = created.body.attachment.id as string;
      return { attachmentId, requestId, vacationId, row: (await rowFor(attachmentId))! };
    };

    it("refuses a missing or wrong signature and leaves the row waiting", async () => {
      const { attachmentId } = await pendingUpload();
      const payload = { attachmentId, status: "READY", contentType: "image/jpeg", size: 10 };
      const body = JSON.stringify(payload);

      await report(payload).expect(401);
      await report(payload, signAttachmentCallback("another-secret", body)).expect(401);
      // A signature over different bytes does not carry over either.
      await report({ ...payload, size: 11 }, signAttachmentCallback(secret, body)).expect(401);

      expect((await rowFor(attachmentId))!.status).toBe(AttachmentStatus.Uploading);
    });

    it("moves the row to READY under the final key, as the local path does, and the bytes then download", async () => {
      const bytes = fixture("clean.pdf");
      const { attachmentId, row } = await pendingUpload({
        fileName: "note.pdf",
        contentType: "application/pdf",
        size: bytes.length,
      });
      const storageKey = finalStorageKey(row.storageKey, "application/pdf");
      await attachmentStore.putObject(storageKey, bytes);
      const payload = {
        attachmentId,
        status: "READY",
        contentType: "application/pdf",
        size: bytes.length,
      };

      const response = await signed(payload).expect(200);

      expect(response.body).toEqual({
        id: attachmentId,
        status: AttachmentStatus.Ready,
        rejectionReason: null,
      });
      expect(await rowFor(attachmentId)).toMatchObject({
        status: AttachmentStatus.Ready,
        contentType: "application/pdf",
        size: bytes.length,
        storageKey,
      });

      const link = await request(context.app)
        .get(`/api/attachments/${attachmentId}/download-url`)
        .set("Cookie", await authCookieFor(context.user2.id))
        .expect(200);
      expect(link.body.fileName).toBe("note.pdf");
      const downloaded = await downloadBytes(link.body.url as string);
      expect((downloaded.body as Buffer).equals(bytes)).toBe(true);

      // A repeat delivery finds the row settled, and learns how.
      const repeat = await signed(payload).expect(409);
      expect(repeat.body.errors[0].context).toEqual({
        status: "READY",
        contentType: "application/pdf",
      });
    });

    it("moves the row to REJECTED with the reason, which the detail then shows", async () => {
      const { attachmentId, vacationId } = await pendingUpload();

      await signed({
        attachmentId,
        status: "REJECTED",
        rejectionReason: AttachmentRejectionReason.PdfJavaScript,
      }).expect(200);

      expect(await rowFor(attachmentId)).toMatchObject({
        status: AttachmentStatus.Rejected,
        rejectionReason: AttachmentRejectionReason.PdfJavaScript,
      });
      const shown = await detail(await authCookieFor(context.user2.id), vacationId).expect(200);
      expect(shown.body.attachments[0]).toMatchObject({
        id: attachmentId,
        status: AttachmentStatus.Rejected,
        rejectionReason: AttachmentRejectionReason.PdfJavaScript,
      });
    });

    it("answers 404 for an unknown or deleted row, 409 for a settled one and 422 for a malformed report", async () => {
      const ready = { status: "READY", contentType: "image/jpeg", size: 1 };
      const unknown = await signed({ attachmentId: uuidv4(), ...ready }).expect(404);
      expect(unknown.body.errors[0].context).toEqual({ reason: "ATTACHMENT_GONE" });

      const { attachmentId, requestId } = await pendingUpload();
      await signed({ attachmentId, status: "DONE" }).expect(422);
      await signed({ attachmentId, ...ready, contentType: "image/gif" }).expect(422);
      await remove(await authCookieFor(context.user2.id), attachmentId).expect(200);
      await signed({ attachmentId, ...ready }).expect(404);

      const settled = await uploadedByOwner(requestId);
      await signed({
        attachmentId: settled.attachmentId,
        status: "REJECTED",
        rejectionReason: AttachmentRejectionReason.TypeMismatch,
      }).expect(409);
    });
  });

  describe("retention sweep", () => {
    // seedRequest books 2 and 3 March, so twelve months after the last day is 3 March a year on.
    const dayBeforeExpiry = new Date(Date.UTC(REQUEST_YEAR + 1, 2, 2, 2));
    const expiryDay = new Date(Date.UTC(REQUEST_YEAR + 1, 2, 3, 2));

    it("removes every attachment twelve months after the Request's last day, deleted ones included", async () => {
      const { requestId, vacationId } = await seedRequest(context.user2.id, context.group.id);
      const cookie = await authCookieFor(context.user2.id);
      const kept = await uploadedByOwner(requestId);
      const deleted = await uploadedByOwner(requestId);
      await remove(cookie, deleted.attachmentId).expect(200);

      expect(await sweepAttachments(dayBeforeExpiry)).toEqual({
        expired: 0,
        noLiveDay: 0,
        stale: 0,
      });
      expect(await stored(kept.storageKey)).toBeDefined();
      expect(await rowFor(deleted.attachmentId)).toBeDefined();

      expect(await sweepAttachments(expiryDay)).toEqual({ expired: 2, noLiveDay: 0, stale: 0 });
      expect(await stored(kept.storageKey)).toBeUndefined();
      expect(await rowFor(kept.attachmentId)).toBeUndefined();
      expect(await rowFor(deleted.attachmentId)).toBeUndefined();
      expect((await detail(cookie, vacationId).expect(200)).body.attachments).toEqual([]);
    });

    it("removes attachments once every day is cancelled, and keeps them while one day lives", async () => {
      const { requestId } = await seedRequest(context.user2.id, context.group.id);
      const cookie = await authCookieFor(context.user2.id);
      const { attachmentId, storageKey } = await uploadedByOwner(requestId);
      const days = await db.select().from(vacation).where(eq(vacation.requestId, requestId));

      await request(context.app)
        .delete(`/api/vacation/${days[0]!.id}`)
        .set("Cookie", cookie)
        .expect(200);
      expect(await sweepAttachments(dayBeforeExpiry)).toEqual({
        expired: 0,
        noLiveDay: 0,
        stale: 0,
      });
      expect(await stored(storageKey)).toBeDefined();

      await request(context.app)
        .delete(`/api/vacation/${days[1]!.id}`)
        .set("Cookie", cookie)
        .expect(200);
      expect(await sweepAttachments(dayBeforeExpiry)).toEqual({
        expired: 0,
        noLiveDay: 1,
        stale: 0,
      });
      expect(await stored(storageKey)).toBeUndefined();
      expect(await rowFor(attachmentId)).toBeUndefined();
    });

    it("removes attachments once every day is rejected", async () => {
      const { requestId } = await seedRequest(context.user2.id, context.group.id);
      const approver = await authCookieFor(context.approverUser.id);
      const { attachmentId, storageKey } = await uploadedByOwner(requestId);
      const days = await db.select().from(vacation).where(eq(vacation.requestId, requestId));

      await request(context.app)
        .post(`/api/vacation/reject/${days[0]!.id}`)
        .set("Cookie", approver)
        .expect(200);
      expect(await sweepAttachments(dayBeforeExpiry)).toEqual({
        expired: 0,
        noLiveDay: 0,
        stale: 0,
      });

      await request(context.app)
        .post(`/api/vacation/reject/${days[1]!.id}`)
        .set("Cookie", approver)
        .expect(200);
      expect(await sweepAttachments(dayBeforeExpiry)).toEqual({
        expired: 0,
        noLiveDay: 1,
        stale: 0,
      });
      expect(await stored(storageKey)).toBeUndefined();
      expect(await rowFor(attachmentId)).toBeUndefined();
    });

    it("clears an upload still pending after ten minutes and keeps a fresh one", async () => {
      const { requestId } = await seedRequest(context.user2.id, context.group.id);
      const cookie = await authCookieFor(context.user2.id);
      const ready = await uploadedByOwner(requestId);
      const pending = await create(cookie, pngBody(requestId)).expect(201);
      const pendingId = pending.body.attachment.id as string;
      const startedAt = (await rowFor(pendingId))!.createdAt.getTime();

      expect(await sweepAttachments(new Date(startedAt + 9 * 60 * 1000))).toEqual({
        expired: 0,
        noLiveDay: 0,
        stale: 0,
      });
      expect(await rowFor(pendingId)).toMatchObject({ status: AttachmentStatus.Uploading });

      expect(await sweepAttachments(new Date(startedAt + 11 * 60 * 1000))).toEqual({
        expired: 0,
        noLiveDay: 0,
        stale: 1,
      });
      expect(await rowFor(pendingId)).toBeUndefined();
      expect(await rowFor(ready.attachmentId)).toBeDefined();
      expect(await stored(ready.storageKey)).toBeDefined();
    });
  });
});
