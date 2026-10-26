import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { db } from "../../db/db.js";
import { employments } from "../../db/schema/employment-schema.js";
import { inviteLink } from "../../db/schema/invite-link-schema.js";
import {
  directoryAgreementAcceptances,
  directoryPermissionCells,
  organizationDirectorySettings,
} from "../../db/schema/directory-schema.js";
import {
  directoryProfileHistory,
  directoryProfiles,
} from "../../db/schema/directory-profile-schema.js";
import { directorySensitiveProfiles } from "../../db/schema/directory-sensitive-profile-schema.js";
import { directoryPhotos, directoryPhotoStatus } from "../../db/schema/directory-photo-schema.js";
import { directoryDepartments, directoryLocations } from "../../db/schema/directory-list-schema.js";
import {
  directoryPermissionHistory,
  directoryRoleAssignments,
} from "../../db/schema/directory-role-schema.js";
import {
  directoryRetentionHolds,
  directoryRetentionPeriods,
} from "../../db/schema/directory-retention-schema.js";
import { readLog } from "../../db/schema/read-log-schema.js";
import {
  personExports,
  personExportScope,
  personExportStatus,
} from "../../db/schema/person-export-schema.js";
import { organizations } from "../../db/schema/organization-schema.js";
import { directoryAudience } from "../../db/schema/directory-schema.js";
import { organizationDataStore } from "../../services/organizationData/organizationDataStore.js";
import { photoKeys, photoPrefix } from "../../services/directory/directoryPhotoServices.js";
import { exportStorageKey } from "../../services/personExport/personExportBuild.js";
import { DIRECTORY_PERMISSION_DEFAULTS } from "../../services/directory/permissionDefaults.js";
import { organizationUsers } from "../../db/schema/organization-users-schema.js";
import { subscriptionPlan, subscriptionStatus } from "../../db/schema/subscription-schema.js";
import { upsertSubscription } from "../../services/billing/subscriptionServices.js";
import { enableDirectory } from "../../services/directory/directorySettingsServices.js";
import { syncEmployment } from "../../services/employment/employmentServices.js";
import { ensureOrganizationForUser } from "../../services/organization/organizationServices.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { authCookieFor } from "./helpers/authHelper.js";
import {
  addMember,
  makeGroup,
  makeUser,
  removeMember,
  resetReportData,
} from "./helpers/reportFixtures.js";
import { cleanupTestData } from "./helpers/testSetup.js";

type SentEmail = { to: string; template: string; data: Record<string, string> };
const sentEmails: SentEmail[] = [];
vi.mock("../../services/email/index.js", () => ({
  emailSender: {
    sendTemplated: (email: SentEmail) => {
      sentEmails.push(email);
      return Promise.resolve();
    },
  },
}));

const PASSWORD = "sturdy-passphrase-42";

// Sign-up runs the Have I Been Pwned check, an outbound call. Answered here so
// the suite runs offline.
const realFetch = globalThis.fetch;
vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
  const url = input instanceof Request ? input.url : input.toString();
  if (!url.startsWith("https://api.pwnedpasswords.com/range/")) return realFetch(input, init);
  return Promise.resolve(
    new Response("", { status: 200, headers: { "content-type": "text/plain" } })
  );
});

/**
 * Turning the directory off, Delete all directory data and turning it back on,
 * driven over HTTP against a real database.
 */
describe("turning the directory off", () => {
  let server: LoopbackServer;

  beforeAll(async () => {
    server = await listenOnLoopback(createServer());
  });

  beforeEach(async () => {
    sentEmails.length = 0;
    await resetReportData();
    await cleanupTestData();
  });

  afterAll(async () => {
    await server?.close();
    await resetReportData();
    await cleanupTestData();
  });

  async function as(userId: string) {
    const cookie = await authCookieFor(userId);
    return {
      get: (path: string) => request(server.url).get(path).set("Cookie", cookie),
      post: (path: string, body: object = {}) =>
        request(server.url).post(path).set("Cookie", cookie).send(body),
      put: (path: string, body: object) =>
        request(server.url).put(path).set("Cookie", cookie).send(body),
      patch: (path: string, body: object) =>
        request(server.url).patch(path).set("Cookie", cookie).send(body),
    };
  }

  const code = (res: request.Response) => res.body.errors?.[0]?.context?.code;

  const openEmploymentOf = async (organizationId: string, userId: string) => {
    const [row] = await db
      .select()
      .from(employments)
      .where(
        and(
          eq(employments.organizationId, organizationId),
          eq(employments.userId, userId),
          isNull(employments.endedAt)
        )
      );
    return row;
  };

  /**
   * Olga owns the Enterprise organization with the directory on and manages
   * Support, where Bob is a member. Dana holds an org-admin grant and belongs to
   * no group. Ivan was removed from Support while the directory was on. Petra
   * has no account, and Eva is an External worker without one.
   */
  const setUp = async () => {
    const owner = await makeUser("Olga Owner");
    const bob = await makeUser("Bob Member");
    const dana = await makeUser("Dana Delegate");
    const ivan = await makeUser("Ivan Removed");
    const organizationId = (await ensureOrganizationForUser(owner.id)).id;
    const support = await makeGroup("Support", owner.id, { organizationOwnerId: owner.id });
    await addMember(support, bob.id);
    await addMember(support, ivan.id);
    await db.insert(organizationUsers).values({
      id: generateRandomUUID(),
      organizationId,
      userId: dana.id,
      grantedByUserId: owner.id,
    });
    for (const person of [owner, bob, dana, ivan]) {
      await syncEmployment(organizationId, person.id);
    }
    await upsertSubscription(organizationId, {
      plan: subscriptionPlan.Enterprise,
      status: subscriptionStatus.Active,
      graceEndsAt: null,
    });
    await db.transaction((tx) =>
      enableDirectory({ organizationId, userId: owner.id, agreementVersion: 1 }, tx)
    );

    await removeMember(support, ivan.id);
    await syncEmployment(organizationId, ivan.id);

    const ownerApi = await as(owner.id);
    const add = async (body: object) => {
      const res = await ownerApi.post(`/api/directory/${organizationId}/people`, body);
      expect(res.status).toBe(201);
      return res.body.employmentId as string;
    };
    const petra = await add({ name: "Petra Nová", type: "employee", email: "petra@example.test" });
    const eva = await add({ name: "Eva External", type: "external" });

    return {
      organizationId,
      support,
      users: { owner, bob, dana, ivan },
      accountless: { petra, eva },
      ownerApi,
    };
  };

  type World = Awaited<ReturnType<typeof setUp>>;

  const turnOff = async (world: World) => {
    const res = await world.ownerApi.post(
      `/api/organization/directory/disable?organizationId=${world.organizationId}`
    );
    expect(res.status).toBe(200);
    return res;
  };

  const roster = async (world: World, userId = world.users.owner.id) => {
    const res = await (
      await as(userId)
    ).get(`/api/employment/list?organizationId=${world.organizationId}`);
    expect(res.status).toBe(200);
    return res.body as { id: string; userId: string | null; ended: boolean; noLink?: boolean }[];
  };

  describe("the roster's no-link mark", () => {
    it("marks the open Employments no link holds, for the dialog and the People card", async () => {
      const world = await setUp();
      const ivan = (await openEmploymentOf(world.organizationId, world.users.ivan.id))!.id;

      const unlinked = (await roster(world))
        .filter((row) => row.noLink)
        .map((row) => row.id)
        .sort();

      expect(unlinked).toEqual([ivan, world.accountless.petra, world.accountless.eva].sort());
    });
  });

  describe("POST /api/organization/directory/disable", () => {
    it("ends nobody at the switch", async () => {
      const world = await setUp();
      const openBefore = (await roster(world)).filter((row) => !row.ended).map((row) => row.id);

      await turnOff(world);

      const openAfter = (await roster(world)).filter((row) => !row.ended).map((row) => row.id);
      expect(openAfter.sort()).toEqual(openBefore.sort());
      expect(openAfter).toHaveLength(6);
    });

    it("revokes open directory invites that name no group, and keeps the rest redeemable", async () => {
      const world = await setUp();
      const karel = await world.ownerApi
        .post(`/api/directory/${world.organizationId}/people`, {
          name: "Karel Grouped",
          type: "employee",
          email: "karel@example.test",
        })
        .then((res) => res.body.employmentId as string);
      const invite = (employmentId: string, body: object = {}) =>
        world.ownerApi.post(
          `/api/directory/${world.organizationId}/people/${employmentId}/invite`,
          body
        );
      expect((await invite(world.accountless.petra)).status).toBe(201);
      expect((await invite(karel, { groupId: world.support })).status).toBe(201);
      const groupInvite = await world.ownerApi.post(`/api/group-user/${world.support}/invites`, {
        email: "zoe@example.test",
      });
      expect(groupInvite.status).toBe(201);
      const tokenFor = (email: string) => {
        const mail = sentEmails.findLast((m) => m.to === email);
        return new URL(mail!.data.inviteUrl!).searchParams.get("token")!;
      };

      await turnOff(world);

      const invites = await db
        .select({
          employmentId: inviteLink.employmentId,
          email: inviteLink.email,
          revokedAt: inviteLink.revokedAt,
        })
        .from(inviteLink);
      const revoked = (email: string) =>
        invites.find((row) => row.email === email)?.revokedAt !== null;
      expect(revoked("petra@example.test")).toBe(true);
      expect(revoked("karel@example.test")).toBe(false);
      expect(revoked("zoe@example.test")).toBe(false);

      const signUp = (email: string, name: string) =>
        request(server.url)
          .post("/api/auth/invite/sign-up")
          .send({ token: tokenFor(email), name, email, password: PASSWORD });
      const refused = await signUp("petra@example.test", "Petra Nová");
      expect(refused.status).toBeGreaterThanOrEqual(400);
      const claimed = await signUp("karel@example.test", "Karel Grouped");
      expect(claimed.status).toBe(201);
      expect(claimed.body.membership).toMatchObject({
        groupId: world.support,
        claimed: { employmentId: karel },
      });
    });

    it("lets the next link change follow the derived rule again", async () => {
      const world = await setUp();
      await turnOff(world);

      await removeMember(world.support, world.users.bob.id);
      await syncEmployment(world.organizationId, world.users.bob.id);

      expect(await openEmploymentOf(world.organizationId, world.users.bob.id)).toBeUndefined();
    });
  });

  const today = () => new Date().toISOString().slice(0, 10);

  const organizationNameOf = async (organizationId: string) => {
    const [row] = await db
      .select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, organizationId));
    return row!.name;
  };

  const deleteAll = async (world: World, confirmName: string, userId = world.users.owner.id) =>
    (await as(userId)).post(
      `/api/organization/directory/delete-all?organizationId=${world.organizationId}`,
      { confirmName }
    );

  const turnOn = async (world: World) => {
    const res = await world.ownerApi.post(
      `/api/organization/directory/enable?organizationId=${world.organizationId}`,
      { agreementVersion: 1 }
    );
    expect(res.status).toBe(200);
  };

  const cellsOf = async (organizationId: string) =>
    (
      await db
        .select()
        .from(directoryPermissionCells)
        .where(eq(directoryPermissionCells.organizationId, organizationId))
    )
      .map((cell) => `${cell.row}/${cell.audience}=${cell.value}`)
      .sort();

  const defaultCells = () =>
    DIRECTORY_PERMISSION_DEFAULTS.map(
      ({ row, audience, value }) => `${row}/${audience}=${value}`
    ).sort();

  const rolesOf = async (world: World) => {
    const res = await world.ownerApi.get(`/api/directory/${world.organizationId}/roles`);
    expect(res.status).toBe(200);
    return res.body;
  };

  describe("POST /api/organization/directory/delete-all", () => {
    it("is refused while the directory is on", async () => {
      const world = await setUp();
      const name = await organizationNameOf(world.organizationId);

      const res = await deleteAll(world, name);

      expect([res.status, code(res)]).toEqual([409, "DIRECTORY_ON"]);
      expect(await cellsOf(world.organizationId)).toHaveLength(72);
    });

    it("is the owner's alone", async () => {
      const world = await setUp();
      await turnOff(world);
      const name = await organizationNameOf(world.organizationId);

      const res = await deleteAll(world, name, world.users.dana.id);

      expect([res.status, code(res)]).toEqual([403, "OWNER_ONLY"]);
    });

    it("needs the organization's name typed", async () => {
      const world = await setUp();
      await turnOff(world);

      const res = await deleteAll(world, "Some other name");

      expect([res.status, code(res)]).toEqual([422, "NAME_MISMATCH"]);
      expect(await cellsOf(world.organizationId)).toHaveLength(72);
    });

    it("accepts the name in any case, and answers with the directory state", async () => {
      const world = await setUp();
      await turnOff(world);
      const name = await organizationNameOf(world.organizationId);

      const res = await deleteAll(world, `  ${name.toUpperCase()} `);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ enabled: false, dataDeletedAt: expect.any(String) });
      expect(await cellsOf(world.organizationId)).toEqual([]);
    });

    describe("on an organization holding every kind of directory data", () => {
      let scratch: string;

      beforeAll(async () => {
        scratch = await mkdtemp(path.join(os.tmpdir(), "directory-delete-all-"));
      });

      afterAll(async () => {
        await rm(scratch, { recursive: true, force: true });
      });

      /**
       * Bob holds a full profile, a photo, HR and a Person export; Ivan has
       * ended and is on hold; Dana is an External worker; Petra (no account)
       * holds a profile, a photo and an open invite; Eva (no account) has
       * ended. The owner changed a cell, a retention period and the notice.
       */
      const seed = async () => {
        const world = await setUp();
        const { organizationId, ownerApi } = world;
        const base = `/api/directory/${organizationId}`;
        const bob = (await openEmploymentOf(organizationId, world.users.bob.id))!.id;
        const ivan = (await openEmploymentOf(organizationId, world.users.ivan.id))!.id;
        const dana = (await openEmploymentOf(organizationId, world.users.dana.id))!.id;
        const { petra, eva } = world.accountless;

        const sales = (await ownerApi.post(`${base}/departments`, { name: "Sales" })).body.id;
        const prague = (await ownerApi.post(`${base}/locations`, { name: "Prague", country: "CZ" }))
          .body.id;
        const ok = (res: request.Response) => {
          expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
          return res;
        };
        ok(
          await ownerApi.patch(`${base}/people/${bob}`, {
            card: { jobTitle: "Engineer", departmentId: sales, locationId: prague },
            workContact: { workEmail: "bob@work.test" },
            job: { employeeNumber: "E-1" },
            contact: { privateEmail: "bob@home.test" },
            personal: { dateOfBirth: "1990-01-01" },
          })
        );
        ok(
          await ownerApi.patch(`${base}/people/${petra}`, {
            card: { jobTitle: "Designer" },
            contact: { privateEmail: "petra@home.test" },
          })
        );
        ok(await ownerApi.put(`${base}/roles/${bob}`, { roles: ["HR"] }));
        ok(
          await ownerApi.patch(`${base}/permissions`, {
            row: "CARD",
            audience: "COLLEAGUE",
            value: "NONE",
          })
        );
        ok(
          await ownerApi.put(`${base}/settings/retention`, { section: "CONTACT", period: "YEAR_1" })
        );
        ok(
          await ownerApi.put(`${base}/settings/general`, {
            emergencyContactNotice: { en: "Our own notice", cs: "Naše vlastní upozornění" },
          })
        );
        ok(await ownerApi.put(`${base}/people/${dana}/worker-type`, { type: "external" }));
        ok(await ownerApi.post(`${base}/people/${bob}/show/contact`));
        ok(await ownerApi.post(`${base}/people/${petra}/show/contact`));
        ok(await ownerApi.post(`${base}/people/${petra}/invite`));
        for (const ended of [ivan, eva]) {
          ok(await ownerApi.post(`/api/employment/${ended}/end`, { endedOn: today() }));
        }
        ok(await ownerApi.put(`${base}/people/${ivan}/hold`, {}));

        const photoKeysOf: string[] = [];
        for (const employmentId of [bob, petra]) {
          const id = generateRandomUUID();
          await db.insert(directoryPhotos).values({
            id,
            organizationId,
            employmentId,
            status: directoryPhotoStatus.Ready,
            contentType: "image/jpeg",
            size: 10,
            uploadedByUserId: world.users.owner.id,
            audience: directoryAudience.Owner,
            readyAt: new Date(),
          });
          const keys = photoKeys(photoPrefix({ organizationId, employmentId, id }));
          for (const key of [keys.small, keys.full]) {
            await organizationDataStore!.putObject(key, Buffer.from("jpeg"), "image/jpeg");
            photoKeysOf.push(key);
          }
        }

        const exportKeys: string[] = [];
        for (const row of [
          { scope: personExportScope.Person, subjectUserId: world.users.bob.id },
          { scope: personExportScope.Organization, subjectUserId: null },
        ]) {
          const id = generateRandomUUID();
          const key = exportStorageKey(organizationId, id);
          const file = path.join(scratch, `${id}.zip`);
          await writeFile(file, "PK fake zip");
          await organizationDataStore!.putFile(key, file, "application/zip");
          await db.insert(personExports).values({
            id,
            organizationId,
            ...row,
            requestedByUserId: world.users.owner.id,
            status: personExportStatus.Ready,
            storageKey: key,
            readyAt: new Date(),
            expiresAt: new Date(Date.now() + 86_400_000),
          });
          exportKeys.push(key);
        }

        await turnOff(world);
        return { ...world, bob, ivan, dana, photoKeysOf, exportKeys };
      };

      const byOrganization = async (
        table:
          | typeof directoryProfiles
          | typeof directorySensitiveProfiles
          | typeof directoryPhotos
          | typeof directoryDepartments
          | typeof directoryLocations
          | typeof directoryRoleAssignments
          | typeof directoryPermissionCells
          | typeof directoryPermissionHistory
          | typeof directoryRetentionPeriods
          | typeof directoryRetentionHolds
          | typeof personExports,
        organizationId: string
      ) => (await db.select().from(table).where(eq(table.organizationId, organizationId))).length;

      const keptRows = async (organizationId: string) => ({
        employments: await db
          .select({
            id: employments.id,
            userId: employments.userId,
            name: employments.name,
            email: employments.email,
            type: employments.type,
            startedAt: employments.startedAt,
            endedAt: employments.endedAt,
          })
          .from(employments)
          .where(eq(employments.organizationId, organizationId))
          .then((rows) => rows.filter((row) => row.userId !== null)),
        acceptances: await db
          .select()
          .from(directoryAgreementAcceptances)
          .where(eq(directoryAgreementAcceptances.organizationId, organizationId)),
        readLog: await db.select().from(readLog).where(eq(readLog.organizationId, organizationId)),
      });

      it("removes every profile field, photo, list, role, table, setting and account-less person", async () => {
        const world = await seed();
        const { organizationId } = world;
        const tables = [
          directoryProfiles,
          directorySensitiveProfiles,
          directoryPhotos,
          directoryDepartments,
          directoryLocations,
          directoryRoleAssignments,
          directoryPermissionCells,
          directoryPermissionHistory,
          directoryRetentionPeriods,
          directoryRetentionHolds,
          personExports,
        ] as const;
        for (const table of tables) {
          expect(await byOrganization(table, organizationId)).toBeGreaterThan(0);
        }

        const res = await deleteAll(world, await organizationNameOf(organizationId));

        expect(res.status).toBe(200);
        for (const table of tables) {
          expect(await byOrganization(table, organizationId)).toBe(0);
        }
        const accountless = await db
          .select()
          .from(employments)
          .where(and(eq(employments.organizationId, organizationId), isNull(employments.userId)));
        expect(accountless).toEqual([]);
        expect(
          await db.select().from(inviteLink).where(eq(inviteLink.email, "petra@example.test"))
        ).toEqual([]);
        const [settings] = await db
          .select()
          .from(organizationDirectorySettings)
          .where(eq(organizationDirectorySettings.organizationId, organizationId));
        expect(settings).toMatchObject({
          enabled: false,
          emergencyContactNoticeEn: null,
          emergencyContactNoticeCs: null,
          dataDeletedByUserId: world.users.owner.id,
        });
        for (const key of [...world.photoKeysOf, ...world.exportKeys]) {
          expect(await organizationDataStore!.getObject(key)).toBeUndefined();
        }
      });

      it("keeps Employments with an account, the acceptances, the read log and their profile history", async () => {
        const world = await seed();
        const { organizationId } = world;
        const before = await keptRows(organizationId);
        const boundIds = before.employments.map((row) => row.id);
        const historyOf = () =>
          db
            .select()
            .from(directoryProfileHistory)
            .where(inArray(directoryProfileHistory.employmentId, boundIds));
        const history = await historyOf();
        expect(history.length).toBeGreaterThan(0);
        expect(before.readLog).toHaveLength(2);
        expect(before.employments.find((row) => row.id === world.dana)?.type).toBe("external");

        const res = await deleteAll(world, await organizationNameOf(organizationId));

        expect(res.status).toBe(200);
        expect(await keptRows(organizationId)).toEqual(before);
        expect(await historyOf()).toEqual(history);
      });
    });
  });

  describe("turning it back on", () => {
    it("restores the stored table and the roles, and stores a new acceptance", async () => {
      const world = await setUp();
      const base = `/api/directory/${world.organizationId}`;
      const bob = (await openEmploymentOf(world.organizationId, world.users.bob.id))!.id;
      expect(
        (
          await world.ownerApi.patch(`${base}/permissions`, {
            row: "CARD",
            audience: "COLLEAGUE",
            value: "NONE",
          })
        ).status
      ).toBe(200);
      expect((await world.ownerApi.put(`${base}/roles/${bob}`, { roles: ["HR"] })).status).toBe(
        200
      );
      const stored = await cellsOf(world.organizationId);
      // A row the product added after this organization's copy was made.
      await db
        .delete(directoryPermissionCells)
        .where(
          and(
            eq(directoryPermissionCells.organizationId, world.organizationId),
            eq(directoryPermissionCells.row, "MANAGE_DEPARTMENTS_AND_LOCATIONS")
          )
        );
      await turnOff(world);

      await turnOn(world);

      expect(await cellsOf(world.organizationId)).toEqual(stored);
      expect(stored).toContain("CARD/COLLEAGUE=NONE");
      const roles = (await rolesOf(world)).people as { employmentId: string; roles: string[] }[];
      expect(roles.filter((person) => person.roles.length > 0)).toEqual([
        expect.objectContaining({ employmentId: bob, roles: ["HR"] }),
      ]);
      const acceptances = await db
        .select()
        .from(directoryAgreementAcceptances)
        .where(eq(directoryAgreementAcceptances.organizationId, world.organizationId));
      expect(acceptances).toHaveLength(2);
    });

    it("puts open Employments under the admin-only ending again", async () => {
      const world = await setUp();
      await turnOff(world);
      await turnOn(world);

      await removeMember(world.support, world.users.bob.id);
      await syncEmployment(world.organizationId, world.users.bob.id);

      expect(await openEmploymentOf(world.organizationId, world.users.bob.id)).toBeDefined();
    });

    it("copies the default table fresh after a Delete all, with no roles", async () => {
      const world = await setUp();
      const base = `/api/directory/${world.organizationId}`;
      const bob = (await openEmploymentOf(world.organizationId, world.users.bob.id))!.id;
      await world.ownerApi.patch(`${base}/permissions`, {
        row: "CARD",
        audience: "COLLEAGUE",
        value: "NONE",
      });
      await world.ownerApi.put(`${base}/roles/${bob}`, { roles: ["HR"] });
      await turnOff(world);
      expect((await deleteAll(world, await organizationNameOf(world.organizationId))).status).toBe(
        200
      );

      await turnOn(world);

      expect(await cellsOf(world.organizationId)).toEqual(defaultCells());
      const roles = (await rolesOf(world)).people as { roles: string[] }[];
      expect(roles.length).toBeGreaterThan(0);
      expect(roles.filter((person) => person.roles.length > 0)).toEqual([]);
      const acceptances = await db
        .select()
        .from(directoryAgreementAcceptances)
        .where(eq(directoryAgreementAcceptances.organizationId, world.organizationId));
      expect(acceptances).toHaveLength(2);
    });
  });
});
