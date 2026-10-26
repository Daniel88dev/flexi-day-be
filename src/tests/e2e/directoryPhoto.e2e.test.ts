import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from "vitest";
import request from "supertest";
import sharp from "sharp";
import { and, eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { db } from "../../db/db.js";
import { user } from "../../db/schema/auth-schema.js";
import { directoryPhotos } from "../../db/schema/directory-photo-schema.js";
import { directoryRoleAssignments } from "../../db/schema/directory-role-schema.js";
import { directoryProfileHistory } from "../../db/schema/directory-profile-schema.js";
import { directoryPermissionCells } from "../../db/schema/directory-schema.js";
import { employments, workerType } from "../../db/schema/employment-schema.js";
import { organizationUsers } from "../../db/schema/organization-users-schema.js";
import { subscriptionPlan, subscriptionStatus } from "../../db/schema/subscription-schema.js";
import { upsertSubscription } from "../../services/billing/subscriptionServices.js";
import { syncEmployment } from "../../services/employment/employmentServices.js";
import { ensureOrganizationForUser } from "../../services/organization/organizationServices.js";
import { organizationDataStore } from "../../services/organizationData/organizationDataStore.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { config } from "../../config.js";
import { personExports } from "../../db/schema/person-export-schema.js";
import {
  createPersonExportQueue,
  installPersonExportQueue,
} from "../../services/personExport/personExportQueue.js";
import { readZip } from "./helpers/readZip.js";
import {
  ATTACHMENT_SIGNATURE_HEADER,
  signAttachmentCallback,
} from "../../services/attachment/callbackSignature.js";
import { createWebUser, webSessionCookieFor, WEB_TEST_PASSWORD } from "./helpers/authHelper.js";
import { addMember, makeGroup, makeUser } from "./helpers/reportFixtures.js";
import { cleanupTestData } from "./helpers/testSetup.js";
import { apiAs, enableEnterpriseDirectory } from "./helpers/directoryWorld.js";

const photoWithGps = () =>
  sharp({ create: { width: 1600, height: 1200, channels: 3, background: "#2f6f4f" } })
    .jpeg()
    .withExif({
      IFD0: { Make: "Fixture camera" },
      IFD3: { GPSLatitudeRef: "N", GPSLatitude: "50/1 5/1 0/1" },
    })
    .toBuffer();

describe("The Profile photo", () => {
  let server: LoopbackServer;

  beforeAll(async () => {
    server = await listenOnLoopback(createServer());
  });

  beforeEach(async () => {
    await cleanupTestData();
  });

  afterEach(() => {
    installPersonExportQueue(undefined);
  });

  afterAll(async () => {
    await server?.close();
    await cleanupTestData();
  });

  /**
   * Olga owns the organization. In Support: Jana and Mira (plain members),
   * Dana (org-admin grant), Eli (External worker) and Karel (Deleted
   * account). Ada has no account.
   */
  const setUp = async () => {
    const owner = await makeUser("Olga Owner");
    const jana = await makeUser("Jana Member");
    const mira = await makeUser("Mira Member");
    const dana = await makeUser("Dana Delegate");
    const eli = await makeUser("Eli External");
    const karel = await makeUser("Karel Deleted");
    const organizationId = (await ensureOrganizationForUser(owner.id)).id;
    const support = await makeGroup("Support", owner.id, { organizationOwnerId: owner.id });
    await addMember(support, owner.id);
    await syncEmployment(organizationId, owner.id);
    for (const person of [jana, mira, dana, eli, karel]) {
      await addMember(support, person.id);
      await syncEmployment(organizationId, person.id);
    }
    await db.insert(organizationUsers).values({
      id: generateRandomUUID(),
      organizationId,
      userId: dana.id,
      grantedByUserId: owner.id,
    });
    await db
      .update(employments)
      .set({ type: workerType.External })
      .where(eq(employments.userId, eli.id));
    await db
      .update(employments)
      .set({ accountDeletedAt: new Date("2026-09-01T10:00:00Z") })
      .where(eq(employments.userId, karel.id));
    await db
      .update(user)
      .set({ image: "https://example.test/jana.png" })
      .where(eq(user.id, jana.id));
    const ada = uuidv4();
    await db.insert(employments).values({
      id: ada,
      organizationId,
      userId: null,
      name: "Ada Noaccount",
      email: "ada@example.test",
    });

    await enableEnterpriseDirectory(organizationId, owner.id);

    const employmentOf = async (userId: string) => {
      const [row] = await db
        .select({ id: employments.id })
        .from(employments)
        .where(and(eq(employments.userId, userId), eq(employments.organizationId, organizationId)));
      return row!.id;
    };

    return {
      organizationId,
      users: { owner, jana, mira, dana, eli, karel },
      employment: {
        owner: await employmentOf(owner.id),
        jana: await employmentOf(jana.id),
        mira: await employmentOf(mira.id),
        dana: await employmentOf(dana.id),
        eli: await employmentOf(eli.id),
        karel: await employmentOf(karel.id),
        ada,
      },
    };
  };

  const as = (userId: string) => apiAs(server.url, userId);

  /** A store URL points at the configured API origin; send it to the test server instead. */
  const local = (url: string) => {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  };

  type Client = Awaited<ReturnType<typeof as>>;

  const upload = async (
    client: Client,
    organizationId: string,
    employmentId: string,
    bytes: Buffer
  ) => {
    const requested = await client.post(
      `/api/directory/${organizationId}/people/${employmentId}/photo`,
      { contentType: "image/jpeg", size: bytes.length }
    );
    expect(requested.status).toBe(201);
    const target = requested.body.upload as {
      url: string;
      method: string;
      headers: Record<string, string>;
    };
    expect(target.method).toBe("PUT");
    const sent = await request(server.url).put(local(target.url)).set(target.headers).send(bytes);
    return { photoId: requested.body.photo.id as string, sent };
  };

  const photoFiles = async (organizationId: string, employmentId: string, photoId: string) => {
    const prefix = `photos/${organizationId}/${employmentId}/${photoId}/`;
    return {
      small: await organizationDataStore!.getObject(`${prefix}small.jpg`),
      full: await organizationDataStore!.getObject(`${prefix}full.jpg`),
    };
  };

  it("stores an upload as a small and a full JPEG without its metadata, on the disk store", async () => {
    const { organizationId, users, employment } = await setUp();
    const owner = await as(users.owner.id);

    const { photoId, sent } = await upload(
      owner,
      organizationId,
      employment.jana,
      await photoWithGps()
    );

    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ id: photoId, status: "READY" });
    const files = await photoFiles(organizationId, employment.jana, photoId);
    expect(files.small).toBeDefined();
    expect(files.full).toBeDefined();
    const small = await sharp(files.small).metadata();
    const full = await sharp(files.full).metadata();
    expect([small.format, small.width, small.height]).toEqual(["jpeg", 256, 192]);
    expect([full.format, full.width, full.height]).toEqual(["jpeg", 1024, 768]);
    expect(small.exif).toBeUndefined();
    expect(full.exif).toBeUndefined();
    expect(files.full!.includes("Fixture camera")).toBe(false);

    const status = await owner.get(
      `/api/directory/${organizationId}/people/${employment.jana}/photo/${photoId}`
    );
    expect(status.body).toEqual({ id: photoId, status: "READY", rejectionReason: null });
  });

  const setCell = async (organizationId: string, row: string, audience: string, value: string) =>
    db
      .update(directoryPermissionCells)
      .set({ value: value as never })
      .where(
        and(
          eq(directoryPermissionCells.organizationId, organizationId),
          eq(directoryPermissionCells.row, row as never),
          eq(directoryPermissionCells.audience, audience as never)
        )
      );

  it("shows the photo to Photo readers in the list and on the profile, and the Account picture to the rest", async () => {
    const { organizationId, users, employment } = await setUp();
    const owner = await as(users.owner.id);
    await upload(owner, organizationId, employment.jana, await photoWithGps());

    const mira = await as(users.mira.id);
    const list = await mira.get(`/api/directory/${organizationId}/people`);
    const jana = list.body.people.find(
      (person: { employmentId: string }) => person.employmentId === employment.jana
    );
    expect(jana.image).toBe("https://example.test/jana.png");
    expect(jana.photoUrl).toEqual(expect.stringContaining("small.jpg"));
    const others = list.body.people.filter(
      (person: { employmentId: string }) => person.employmentId !== employment.jana
    );
    expect(others.every((person: { photoUrl: unknown }) => person.photoUrl === null)).toBe(true);

    const profile = await mira.get(`/api/directory/${organizationId}/people/${employment.jana}`);
    expect(profile.body.sections.photo).toEqual({
      level: "READ",
      photo: {
        smallUrl: expect.stringContaining("small.jpg"),
        fullUrl: expect.stringContaining("full.jpg"),
      },
    });

    const shown = await request(server.url).get(local(profile.body.sections.photo.photo.fullUrl));
    expect(shown.status).toBe(200);
    expect(shown.headers["content-type"]).toBe("image/jpeg");
    expect(shown.headers["cache-control"]).toBe("private, max-age=3600");
    expect(shown.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    expect((await sharp(shown.body as Buffer).metadata()).width).toBe(1024);

    const again = await mira.get(`/api/directory/${organizationId}/people/${employment.jana}`);
    expect(again.body.sections.photo.photo.fullUrl).toBe(profile.body.sections.photo.photo.fullUrl);

    await setCell(organizationId, "PHOTO", "COLLEAGUE", "NONE");
    const hidden = await mira.get(`/api/directory/${organizationId}/people/${employment.jana}`);
    expect(hidden.body.sections.photo).toBeUndefined();
    expect(hidden.body.photoUrl).toBeNull();
    expect(hidden.body.image).toBe("https://example.test/jana.png");
    const hiddenList = await mira.get(`/api/directory/${organizationId}/people`);
    expect(
      hiddenList.body.people.find(
        (person: { employmentId: string }) => person.employmentId === employment.jana
      ).photoUrl
    ).toBeNull();
  });

  it("tells the writer about a profile without a photo", async () => {
    const { organizationId, users, employment } = await setUp();
    const jana = await as(users.jana.id);

    const profile = await jana.get(`/api/directory/${organizationId}/people/${employment.jana}`);

    expect(profile.body.sections.photo).toEqual({ level: "WRITE", photo: null });
    expect(profile.body.photoUrl).toBeNull();
  });

  it("lets the person, the owner, an org admin and HR set a photo, and refuses colleagues", async () => {
    const { organizationId, users, employment } = await setUp();
    const path = (employmentId: string) =>
      `/api/directory/${organizationId}/people/${employmentId}/photo`;
    const body = { contentType: "image/jpeg", size: 1000 };

    expect((await (await as(users.jana.id)).post(path(employment.jana), body)).status).toBe(201);
    expect((await (await as(users.dana.id)).post(path(employment.jana), body)).status).toBe(201);
    expect((await (await as(users.owner.id)).post(path(employment.ada), body)).status).toBe(201);

    const colleague = await (await as(users.mira.id)).post(path(employment.jana), body);
    expect(colleague.status).toBe(403);
    await db.insert(directoryRoleAssignments).values({
      employmentId: employment.mira,
      role: "HR" as never,
      organizationId,
      assignedByUserId: users.owner.id,
    });
    expect((await (await as(users.mira.id)).post(path(employment.jana), body)).status).toBe(201);
    expect(colleague.body.errors[0].context.code).toBe("SECTION_NOT_WRITABLE");
    const external = await (await as(users.eli.id)).post(path(employment.jana), body);
    expect(external.status).toBe(403);
    expect((await (await as(users.eli.id)).delete(path(employment.jana))).status).toBe(403);
  });

  it("refuses what is not a picture or is too large", async () => {
    const { organizationId, users, employment } = await setUp();
    const owner = await as(users.owner.id);
    const path = `/api/directory/${organizationId}/people/${employment.jana}/photo`;

    const pdf = await owner.post(path, { contentType: "application/pdf", size: 1000 });
    expect(pdf.status).toBe(422);
    expect(pdf.body.errors[0].context.reason).toBe("UNSUPPORTED_TYPE");
    const large = await owner.post(path, { contentType: "image/png", size: 10 * 1024 * 1024 + 1 });
    expect(large.status).toBe(422);
    expect(large.body.errors[0].context.reason).toBe("FILE_TOO_LARGE");

    const { photoId, sent } = await upload(
      owner,
      organizationId,
      employment.jana,
      Buffer.from("not really a jpeg")
    );
    expect(sent.body).toMatchObject({ id: photoId, status: "REJECTED" });
    expect(await photoFiles(organizationId, employment.jana, photoId)).toEqual({
      small: undefined,
      full: undefined,
    });
  });

  it("refuses setting a photo on a lapsed organization and still lets it be removed", async () => {
    const { organizationId, users, employment } = await setUp();
    const owner = await as(users.owner.id);
    const { photoId } = await upload(owner, organizationId, employment.jana, await photoWithGps());
    await upsertSubscription(organizationId, {
      plan: subscriptionPlan.Pro,
      status: subscriptionStatus.Active,
      graceEndsAt: null,
    });

    const refused = await owner.post(
      `/api/directory/${organizationId}/people/${employment.jana}/photo`,
      { contentType: "image/jpeg", size: 1000 }
    );
    expect(refused.status).toBe(402);
    expect(refused.body.errors[0].context.reason).toBe("PLAN_LIMIT");

    const removed = await owner.delete(
      `/api/directory/${organizationId}/people/${employment.jana}/photo`
    );
    expect(removed.status).toBe(204);
    expect(await photoFiles(organizationId, employment.jana, photoId)).toEqual({
      small: undefined,
      full: undefined,
    });
  });

  it("deletes both sizes on removal and on replacement, and records each in the profile history", async () => {
    const { organizationId, users, employment } = await setUp();
    const jana = await as(users.jana.id);
    const first = await upload(jana, organizationId, employment.jana, await photoWithGps());
    const second = await upload(jana, organizationId, employment.jana, await photoWithGps());

    expect(await photoFiles(organizationId, employment.jana, first.photoId)).toEqual({
      small: undefined,
      full: undefined,
    });
    const kept = await photoFiles(organizationId, employment.jana, second.photoId);
    expect(kept.small).toBeDefined();
    expect(kept.full).toBeDefined();

    const removed = await jana.delete(
      `/api/directory/${organizationId}/people/${employment.jana}/photo`
    );
    expect(removed.status).toBe(204);
    expect(await photoFiles(organizationId, employment.jana, second.photoId)).toEqual({
      small: undefined,
      full: undefined,
    });
    expect(await db.select().from(directoryPhotos)).toEqual([]);

    const history = await db
      .select()
      .from(directoryProfileHistory)
      .where(eq(directoryProfileHistory.employmentId, employment.jana));
    expect(history).toHaveLength(3);
    expect(
      history.every(
        (row) =>
          row.section === "PHOTO" &&
          row.audience === "SELF" &&
          row.actorUserId === users.jana.id &&
          row.fields.join() === "photo"
      )
    ).toBe(true);
  });

  it("deletes both sizes when the person is erased", async () => {
    const { organizationId, users, employment } = await setUp();
    const owner = await as(users.owner.id);
    const { photoId } = await upload(owner, organizationId, employment.karel, await photoWithGps());
    expect((await photoFiles(organizationId, employment.karel, photoId)).full).toBeDefined();

    const erased = await owner.post(`/api/employment/${employment.karel}/erase`, {
      confirmName: "Karel Deleted",
    });

    expect(erased.status).toBe(204);
    expect(await photoFiles(organizationId, employment.karel, photoId)).toEqual({
      small: undefined,
      full: undefined,
    });
    expect(await db.select().from(directoryPhotos)).toEqual([]);
  });

  describe("POST /api/directory/photos/processed", () => {
    const report = (payload: unknown, secret = config.attachments.callbackSecret!) =>
      request(server.url)
        .post("/api/directory/photos/processed")
        .set("Content-Type", "application/json")
        .set(ATTACHMENT_SIGNATURE_HEADER, signAttachmentCallback(secret, JSON.stringify(payload)))
        .send(JSON.stringify(payload));

    const pending = async () => {
      const { organizationId, users, employment } = await setUp();
      const owner = await as(users.owner.id);
      const requested = await owner.post(
        `/api/directory/${organizationId}/people/${employment.jana}/photo`,
        { contentType: "image/jpeg", size: 1000 }
      );
      return { organizationId, employment, owner, photoId: requested.body.photo.id as string };
    };

    it("makes a reported photo the Profile photo, once", async () => {
      const { organizationId, employment, owner, photoId } = await pending();

      const applied = await report({ photoId, status: "READY" });
      expect(applied.status).toBe(200);
      expect(applied.body).toEqual({ id: photoId, status: "READY", rejectionReason: null });
      const profile = await owner.get(`/api/directory/${organizationId}/people/${employment.jana}`);
      expect(decodeURIComponent(profile.body.sections.photo.photo.fullUrl)).toContain(
        `${photoId}/full.jpg`
      );

      const repeat = await report({ photoId, status: "READY" });
      expect(repeat.status).toBe(409);
      expect(repeat.body.errors[0].context.status).toBe("READY");
    });

    it("answers PHOTO_GONE for an upload that was dropped, and 401 for a wrong signature", async () => {
      const { photoId } = await pending();

      expect((await report({ photoId, status: "READY" }, "another-secret")).status).toBe(401);
      await db.delete(directoryPhotos).where(eq(directoryPhotos.id, photoId));
      const gone = await report({
        photoId,
        status: "REJECTED",
        rejectionReason: "IMAGE_UNREADABLE",
      });
      expect(gone.status).toBe(404);
      expect(gone.body.errors[0].context.reason).toBe("PHOTO_GONE");
    });
  });

  it("puts the full photo in the person export, next to the spell it belongs to", async () => {
    const { organizationId, users, employment } = await setUp();
    const owner = await as(users.owner.id);
    const { photoId } = await upload(owner, organizationId, employment.jana, await photoWithGps());
    const queue = createPersonExportQueue({ retryDelaysMs: [0, 0, 0], busyRetryMs: 0 });
    installPersonExportQueue(queue);

    const requested = await owner.post(`/api/employment/${employment.jana}/export`, {});
    expect(requested.status).toBe(202);
    await queue.drain();
    const [row] = await db
      .select()
      .from(personExports)
      .where(eq(personExports.id, requested.body.id as string));
    const entries = readZip((await organizationDataStore!.getObject(row!.storageKey!))!);

    const file = `profile-photos/${employment.jana}.jpg`;
    const stored = (await photoFiles(organizationId, employment.jana, photoId)).full!;
    expect(entries.get(file)?.equals(stored)).toBe(true);
    const person = JSON.parse(entries.get("person.json")!.toString("utf8"));
    expect(person.employments).toEqual([
      expect.objectContaining({
        id: employment.jana,
        photo: { file, uploadedAt: expect.any(String) },
      }),
    ]);
  });

  it("puts the full photo of a person without an account in the Organization export", async () => {
    const { organizationId, users, employment } = await setUp();
    const owner = await as(users.owner.id);
    const { photoId } = await upload(owner, organizationId, employment.ada, await photoWithGps());
    const queue = createPersonExportQueue({ retryDelaysMs: [0, 0, 0], busyRetryMs: 0 });
    installPersonExportQueue(queue);

    const requested = await owner.post(
      `/api/organization/export?organizationId=${organizationId}`,
      {}
    );
    expect(requested.status).toBe(202);
    await queue.drain();
    const [row] = await db
      .select()
      .from(personExports)
      .where(eq(personExports.id, requested.body.id as string));
    const entries = readZip((await organizationDataStore!.getObject(row!.storageKey!))!);

    const file = `people-without-account/profile-photos/${employment.ada}.jpg`;
    const stored = (await photoFiles(organizationId, employment.ada, photoId)).full!;
    expect(entries.get(file)?.equals(stored)).toBe(true);
    const document = JSON.parse(entries.get("organization.json")!.toString("utf8"));
    expect(document.peopleWithoutAccount).toEqual([
      expect.objectContaining({
        employmentId: employment.ada,
        photo: { file, uploadedAt: expect.any(String) },
      }),
    ]);
  });

  it("deletes an organization's photos with the organization", async () => {
    const owner = await createWebUser("Solo Owner");
    const organizationId = (await ensureOrganizationForUser(owner.id)).id;
    const group = await makeGroup("Solo", owner.id, { organizationOwnerId: owner.id });
    await addMember(group, owner.id);
    await syncEmployment(organizationId, owner.id);
    await enableEnterpriseDirectory(organizationId, owner.id);
    const [own] = await db
      .select({ id: employments.id })
      .from(employments)
      .where(eq(employments.userId, owner.id));
    const { photoId } = await upload(
      await as(owner.id),
      organizationId,
      own!.id,
      await photoWithGps()
    );
    expect((await photoFiles(organizationId, own!.id, photoId)).full).toBeDefined();

    const deleted = await request(server.url)
      .post("/api/users/me/delete")
      .set("Cookie", await webSessionCookieFor(server.url, owner.email))
      .send({ password: WEB_TEST_PASSWORD });

    expect(deleted.status).toBe(204);
    expect(await photoFiles(organizationId, own!.id, photoId)).toEqual({
      small: undefined,
      full: undefined,
    });
  });
});
