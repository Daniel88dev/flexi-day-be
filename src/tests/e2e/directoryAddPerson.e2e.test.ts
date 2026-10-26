import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import { and, eq, isNull } from "drizzle-orm";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { db } from "../../db/db.js";
import { employments } from "../../db/schema/employment-schema.js";
import { directoryProfileHistory } from "../../db/schema/directory-profile-schema.js";
import { user } from "../../db/schema/auth-schema.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
import { inviteLink } from "../../db/schema/invite-link-schema.js";
import { userYearQuotas } from "../../db/schema/user-year-quotas-schema.js";
import { vacation } from "../../db/schema/vacation-schema.js";
import { generateInviteCode } from "../../utils/inviteCode.js";
import { personExports } from "../../db/schema/person-export-schema.js";
import { readLog } from "../../db/schema/read-log-schema.js";
import { organizationDataStore } from "../../services/organizationData/organizationDataStore.js";
import { buildPersonExport } from "../../services/personExport/personExportBuild.js";
import { readZip } from "./helpers/readZip.js";
import { organizationUsers } from "../../db/schema/organization-users-schema.js";
import { subscriptionPlan, subscriptionStatus } from "../../db/schema/subscription-schema.js";
import { upsertSubscription } from "../../services/billing/subscriptionServices.js";
import { enableDirectory } from "../../services/directory/directorySettingsServices.js";
import { syncEmployment } from "../../services/employment/employmentServices.js";
import { ensureOrganizationForUser } from "../../services/organization/organizationServices.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { authCookieFor } from "./helpers/authHelper.js";
import { addMember, makeGroup, makeUser, resetReportData } from "./helpers/reportFixtures.js";
import { cleanupTestData } from "./helpers/testSetup.js";

vi.mock("../../services/email/index.js", () => ({
  emailSender: { sendTemplated: () => Promise.resolve() },
}));

describe("adding a person without an account", () => {
  let server: LoopbackServer;

  beforeAll(async () => {
    server = await listenOnLoopback(createServer());
  });

  beforeEach(async () => {
    await resetReportData();
    await cleanupTestData();
  });

  afterAll(async () => {
    await server?.close();
    await resetReportData();
    await cleanupTestData();
  });

  /**
   * Olga owns an Enterprise organization with the directory on and manages
   * Support, where Bob is a plain member and Gabi a member with admin access.
   * Dana is a delegated org admin; Hana gets HR and Lea Leadership.
   */
  const setUp = async () => {
    const owner = await makeUser("Olga Owner");
    const bob = await makeUser("Bob Plain");
    const gabi = await makeUser("Gabi Admin");
    const dana = await makeUser("Dana Delegate");
    const hana = await makeUser("Hana Hr");
    const lea = await makeUser("Lea Leader");
    const organizationId = (await ensureOrganizationForUser(owner.id)).id;

    const support = await makeGroup("Support", owner.id, { organizationOwnerId: owner.id });
    await addMember(support, bob.id);
    await addMember(support, gabi.id, { adminAccess: true });
    await addMember(support, hana.id);
    await addMember(support, lea.id);
    await db.insert(organizationUsers).values({
      id: generateRandomUUID(),
      organizationId,
      userId: dana.id,
      grantedByUserId: owner.id,
    });
    for (const person of [owner, bob, gabi, dana, hana, lea]) {
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

    const world = { organizationId, support, users: { owner, bob, gabi, dana, hana, lea } };
    await giveRole(world, hana.id, "HR");
    await giveRole(world, lea.id, "LEADERSHIP");
    return world;
  };

  type World = Awaited<ReturnType<typeof setUp>>;

  const as = async (userId: string) => {
    const cookie = await authCookieFor(userId);
    return {
      get: (path: string) => request(server.url).get(path).set("Cookie", cookie),
      post: (path: string, body: object) =>
        request(server.url).post(path).set("Cookie", cookie).send(body),
      put: (path: string, body: object) =>
        request(server.url).put(path).set("Cookie", cookie).send(body),
      patch: (path: string, body: object) =>
        request(server.url).patch(path).set("Cookie", cookie).send(body),
    };
  };

  const code = (res: request.Response) => res.body.errors?.[0]?.context?.code;

  const employmentIdOf = async (organizationId: string, userId: string) => {
    const [row] = await db
      .select({ id: employments.id })
      .from(employments)
      .where(
        and(
          eq(employments.organizationId, organizationId),
          eq(employments.userId, userId),
          isNull(employments.endedAt)
        )
      );
    return row!.id;
  };

  async function giveRole(
    world: { organizationId: string; users: { owner: { id: string } } },
    userId: string,
    role: string
  ) {
    const res = await (
      await as(world.users.owner.id)
    ).put(
      `/api/directory/${world.organizationId}/roles/${await employmentIdOf(world.organizationId, userId)}`,
      { roles: [role] }
    );
    expect(res.status).toBe(200);
  }

  const setCell = async (world: World, row: string, audience: string, value: string) => {
    const res = await (
      await as(world.users.owner.id)
    ).patch(`/api/directory/${world.organizationId}/permissions`, { row, audience, value });
    expect(res.status).toBe(200);
  };

  const accountlessRows = (organizationId: string) =>
    db
      .select()
      .from(employments)
      .where(and(eq(employments.organizationId, organizationId), isNull(employments.userId)));

  const emailOf = async (organizationId: string, userId: string) => {
    const [row] = await db
      .select({ email: employments.email })
      .from(employments)
      .where(and(eq(employments.organizationId, organizationId), eq(employments.userId, userId)));
    return row!.email!;
  };

  const add = async (world: World, callerId: string, body: object) =>
    (await as(callerId)).post(`/api/directory/${world.organizationId}/people`, body);

  describe("POST /api/directory/{organizationId}/people", () => {
    it("creates an open Employment without an account and answers with its profile", async () => {
      const world = await setUp();

      const res = await add(world, world.users.owner.id, {
        name: "  Petra Nová ",
        type: "external",
        email: "Petra@Example.test",
      });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        name: "Petra Nová",
        organizationId: world.organizationId,
        ended: false,
        markers: expect.arrayContaining(["EXTERNAL_WORKER", "NO_ACCOUNT"]),
        account: { status: "NO_ACCOUNT", signInEmail: "petra@example.test" },
      });
      const [row] = await db
        .select()
        .from(employments)
        .where(eq(employments.id, res.body.employmentId));
      expect(row).toMatchObject({
        organizationId: world.organizationId,
        userId: null,
        type: "external",
        name: "Petra Nová",
        email: "petra@example.test",
        endedAt: null,
      });
    });
  });

  describe("the Card, the history and who may add", () => {
    it("writes the Card fields given and one Card history entry naming the audience", async () => {
      const world = await setUp();
      const owner = await as(world.users.owner.id);
      const department = await owner.post(`/api/directory/${world.organizationId}/departments`, {
        name: "Support",
      });
      const location = await owner.post(`/api/directory/${world.organizationId}/locations`, {
        name: "Brno",
        country: "CZ",
      });
      const bobEmployment = await employmentIdOf(world.organizationId, world.users.bob.id);

      const res = await add(world, world.users.hana.id, {
        name: "Petra Nová",
        card: {
          jobTitle: "Cleaner",
          departmentId: department.body.id,
          locationId: location.body.id,
          reportsToEmploymentId: bobEmployment,
        },
      });

      expect(res.status).toBe(201);
      expect(res.body.sections.card).toMatchObject({
        jobTitle: "Cleaner",
        department: { id: department.body.id, name: "Support" },
        location: { id: location.body.id, name: "Brno" },
        reportsTo: { employmentId: bobEmployment, name: "Bob Plain" },
      });
      expect(res.body.markers).toEqual(["NO_ACCOUNT"]);
      const history = await db
        .select()
        .from(directoryProfileHistory)
        .where(eq(directoryProfileHistory.employmentId, res.body.employmentId));
      expect(history).toEqual([
        expect.objectContaining({
          actorUserId: world.users.hana.id,
          section: "CARD",
          fields: ["name", "jobTitle", "department", "location", "reportsTo"],
          audience: "HR",
        }),
      ]);
    });

    it("refuses an archived entry and a Reports to that isn't open, and writes nothing", async () => {
      const world = await setUp();
      const owner = await as(world.users.owner.id);
      const department = await owner.post(`/api/directory/${world.organizationId}/departments`, {
        name: "Old",
      });
      await owner.patch(
        `/api/directory/${world.organizationId}/departments/${department.body.id}`,
        {
          archived: true,
        }
      );

      const archived = await add(world, world.users.owner.id, {
        name: "Petra Nová",
        card: { departmentId: department.body.id },
      });
      const nobody = await add(world, world.users.owner.id, {
        name: "Petra Nová",
        card: { reportsToEmploymentId: generateRandomUUID() },
      });

      expect([archived.status, code(archived)]).toEqual([422, "ENTRY_ARCHIVED"]);
      expect([nobody.status, code(nobody)]).toEqual([422, "REPORTS_TO_NOT_FOUND"]);
      expect(await accountlessRows(world.organizationId)).toHaveLength(0);
    });

    it("lets the owner, an org admin and HR add, and refuses Leadership, a group admin and a member", async () => {
      const world = await setUp();
      const { owner, dana, hana, lea, gabi, bob } = world.users;

      for (const caller of [owner, dana, hana]) {
        expect((await add(world, caller.id, { name: `By ${caller.name}` })).status).toBe(201);
      }
      for (const caller of [lea, gabi, bob]) {
        const res = await add(world, caller.id, { name: `By ${caller.name}` });
        expect([res.status, code(res)]).toEqual([403, "CREATE_DENIED"]);
      }
      expect(await accountlessRows(world.organizationId)).toHaveLength(3);
    });

    it("follows the stored cells: Leadership adds once allowed, HR is refused once its cell says no", async () => {
      const world = await setUp();
      await setCell(world, "CREATE_ACCOUNTLESS_PERSON", "LEADERSHIP", "ALLOWED");
      await setCell(world, "CREATE_ACCOUNTLESS_PERSON", "HR", "NO");
      await setCell(world, "CREATE_ACCOUNTLESS_PERSON", "GROUP_ADMIN", "ALLOWED");

      const leadership = await add(world, world.users.lea.id, { name: "By Lea" });
      const hr = await add(world, world.users.hana.id, { name: "By Hana" });
      const groupAdmin = await add(world, world.users.gabi.id, { name: "By Gabi" });

      expect(leadership.status).toBe(201);
      const [entry] = await db
        .select()
        .from(directoryProfileHistory)
        .where(eq(directoryProfileHistory.employmentId, leadership.body.employmentId));
      expect(entry).toMatchObject({ fields: ["name"], audience: "LEADERSHIP" });
      expect([hr.status, code(hr)]).toEqual([403, "CREATE_DENIED"]);
      expect([groupAdmin.status, code(groupAdmin)]).toEqual([403, "CREATE_DENIED"]);
    });

    it("refuses adding on a lapsed organization with 402", async () => {
      const world = await setUp();
      await upsertSubscription(world.organizationId, {
        plan: subscriptionPlan.Pro,
        status: subscriptionStatus.Active,
        graceEndsAt: null,
      });

      const res = await add(world, world.users.owner.id, { name: "Petra Nová" });

      expect(res.status).toBe(402);
      expect(res.body.errors[0].context.reason).toBe("PLAN_LIMIT");
      expect(await accountlessRows(world.organizationId)).toHaveLength(0);
    });

    it("refuses a missing name and a malformed email", async () => {
      const world = await setUp();

      const blank = await add(world, world.users.owner.id, { name: "   " });
      const email = await add(world, world.users.owner.id, { name: "Petra", email: "petra@" });

      expect(blank.status).toBe(422);
      expect(email.status).toBe(422);
    });
  });

  describe("the directory list and the markers", () => {
    it("tells the list who may add a person", async () => {
      const world = await setUp();
      const flag = async (callerId: string) =>
        (await (await as(callerId)).get(`/api/directory/${world.organizationId}/people`)).body
          .addPerson;

      const { owner, dana, hana, lea, gabi, bob } = world.users;
      expect(await Promise.all([owner, dana, hana].map((user) => flag(user.id)))).toEqual([
        true,
        true,
        true,
      ]);
      expect(await Promise.all([lea, gabi, bob].map((user) => flag(user.id)))).toEqual([
        false,
        false,
        false,
      ]);
    });

    it("shows No account to the owner, org admins and HR only, and the person to every Card reader", async () => {
      const world = await setUp();
      const created = await add(world, world.users.owner.id, { name: "Petra Nová" });
      const markersSeenBy = async (callerId: string) => {
        const list = await (
          await as(callerId)
        ).get(`/api/directory/${world.organizationId}/people`);
        return list.body.people.find(
          (person: { employmentId: string }) => person.employmentId === created.body.employmentId
        )?.markers;
      };

      const { owner, dana, hana, lea, bob, gabi } = world.users;
      for (const viewer of [owner, dana, hana]) {
        expect(await markersSeenBy(viewer.id)).toEqual(["NO_ACCOUNT"]);
      }
      for (const viewer of [lea, bob, gabi]) {
        expect(await markersSeenBy(viewer.id)).toEqual([]);
      }
      const profile = await (
        await as(bob.id)
      ).get(`/api/directory/${world.organizationId}/people/${created.body.employmentId}`);
      expect(profile.status).toBe(200);
      expect(profile.body.markers).toEqual([]);
      expect(profile.body.account).toBeUndefined();
    });
  });

  describe("no group, no bookings, no quota", () => {
    it("can't be booked for or given a quota, and a joining account with the email is refused", async () => {
      const world = await setUp();
      const created = await add(world, world.users.owner.id, {
        name: "Petra Nová",
        email: "petra@example.test",
      });
      const id = created.body.employmentId;
      const owner = await as(world.users.owner.id);

      const booking = await owner.post("/api/vacation/create-vacation", {
        groupId: world.support,
        userId: id,
        from: "2030-03-06",
        to: "2030-03-06",
        autoApprove: true,
      });
      const quota = await owner.put(`/api/quotas/${world.support}`, {
        userId: id,
        year: 2030,
        vacationDays: 20,
        homeOfficeDays: 0,
      });

      expect(booking.status).toBeGreaterThanOrEqual(400);
      expect(booking.status).toBeLessThan(500);
      expect(quota.status).toBeGreaterThanOrEqual(400);
      expect(quota.status).toBeLessThan(500);
      expect(await db.select().from(vacation).where(eq(vacation.userId, id))).toHaveLength(0);
      expect(
        await db.select().from(userYearQuotas).where(eq(userYearQuotas.userId, id))
      ).toHaveLength(0);

      const joiner = await makeUser("Petra Joiner");
      await db.update(user).set({ email: "petra@example.test" }).where(eq(user.id, joiner.id));
      const code = generateInviteCode();
      await db.insert(inviteLink).values({
        id: generateRandomUUID(),
        groupId: world.support,
        code,
        invitedByUserId: world.users.owner.id,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });
      const redeem = await (await as(joiner.id)).post(`/api/group-user/code/${code}`, {});
      expect(redeem.status).toBe(409);
      expect(redeem.body.errors[0].context.code).toBe("ACCOUNTLESS_EMPLOYMENT_EMAIL");
      expect(
        await db.select().from(groupUsers).where(eq(groupUsers.groupId, world.support))
      ).toHaveLength(4);
    });
  });

  describe("Erase", () => {
    it("offers Erase on the profile to the owner and org admins, not to HR", async () => {
      const world = await setUp();
      const created = await add(world, world.users.owner.id, { name: "Petra Nová" });
      const actionsOf = async (callerId: string) =>
        (
          await (
            await as(callerId)
          ).get(`/api/directory/${world.organizationId}/people/${created.body.employmentId}`)
        ).body.actions;

      expect(await actionsOf(world.users.owner.id)).toMatchObject({ erase: true, end: true });
      expect(await actionsOf(world.users.dana.id)).toMatchObject({ erase: true });
      expect(await actionsOf(world.users.hana.id)).toMatchObject({ erase: false, end: true });
    });

    it("removes the account-less Employment entirely, its profile and history with it", async () => {
      const world = await setUp();
      const owner = await as(world.users.owner.id);
      const created = await add(world, world.users.owner.id, {
        name: "Petra Nová",
        email: "petra@example.test",
        card: { jobTitle: "Cleaner" },
      });
      const id = created.body.employmentId;
      const bobEmployment = await employmentIdOf(world.organizationId, world.users.bob.id);
      await owner.patch(`/api/directory/${world.organizationId}/people/${bobEmployment}`, {
        card: { reportsToEmploymentId: id },
      });

      const wrongName = await owner.post(`/api/employment/${id}/erase`, { confirmName: "Petra" });
      const byHr = await (
        await as(world.users.hana.id)
      ).post(`/api/employment/${id}/erase`, { confirmName: "petra  nová" });
      expect([wrongName.status, code(wrongName)]).toEqual([422, "NAME_MISMATCH"]);
      expect(byHr.status).toBe(403);

      const res = await owner.post(`/api/employment/${id}/erase`, { confirmName: "petra  nová" });

      expect(res.status).toBe(204);
      expect(await db.select().from(employments).where(eq(employments.id, id))).toHaveLength(0);
      expect(
        await db
          .select()
          .from(directoryProfileHistory)
          .where(eq(directoryProfileHistory.employmentId, id))
      ).toHaveLength(0);
      const bob = await owner.get(`/api/directory/${world.organizationId}/people/${bobEmployment}`);
      expect(bob.body.sections.card.reportsTo).toBeNull();
      const again = await add(world, world.users.owner.id, {
        name: "Petra Nová",
        email: "petra@example.test",
      });
      expect(again.status).toBe(201);
    });

    it("still refuses to erase a live account", async () => {
      const world = await setUp();
      const bobEmployment = await employmentIdOf(world.organizationId, world.users.bob.id);

      const res = await (
        await as(world.users.owner.id)
      ).post(`/api/employment/${bobEmployment}/erase`, { confirmName: "Bob Plain" });

      expect([res.status, code(res)]).toEqual([422, "ACCOUNT_NOT_DELETED"]);
    });
  });

  describe("the Person export", () => {
    it("exports a person without an account, logs it and lists it for the requester", async () => {
      const world = await setUp();
      const created = await add(world, world.users.owner.id, {
        name: "Petra Nová",
        email: "petra@example.test",
        type: "external",
        card: { jobTitle: "Cleaner" },
      });
      const id = created.body.employmentId;
      const owner = await as(world.users.owner.id);
      expect(
        (await owner.get(`/api/directory/${world.organizationId}/people/${id}`)).body.actions
      ).toMatchObject({ export: true });

      const res = await owner.post(`/api/employment/${id}/export`, {});

      expect(res.status).toBe(202);
      expect(res.body).toMatchObject({ subjectUserId: null, subjectEmploymentId: id });
      const [logged] = await db
        .select()
        .from(readLog)
        .where(eq(readLog.personExportId, res.body.id));
      expect(logged).toMatchObject({
        kind: "export",
        subjectUserId: null,
        employmentIds: [id],
        audience: "OWNER",
      });
      const again = await owner.post(`/api/employment/${id}/export`, {});
      expect(again.body.id).toBe(res.body.id);

      await buildPersonExport(res.body.id);
      const [row] = await db.select().from(personExports).where(eq(personExports.id, res.body.id));
      expect(row!.status).toBe("READY");
      const entries = readZip((await organizationDataStore!.getObject(row!.storageKey!))!);
      const person = JSON.parse(entries.get("person.json")!.toString("utf8"));
      expect(person.employments).toEqual([
        expect.objectContaining({
          id,
          name: "Petra Nová",
          email: "petra@example.test",
          profile: expect.objectContaining({ jobTitle: "Cleaner" }),
        }),
      ]);
      expect(person).toMatchObject({ groups: [], quotas: [], bookings: [], attachments: [] });
      expect(person.readLog).toEqual([expect.objectContaining({ kind: "export" })]);
      expect(person.profileHistory).toEqual([
        expect.objectContaining({ section: "CARD", fields: ["name", "jobTitle"] }),
      ]);

      const listed = await owner.get(
        `/api/employment/exports?organizationId=${world.organizationId}`
      );
      expect(listed.body).toEqual([
        expect.objectContaining({ id: res.body.id, subjectEmploymentId: id }),
      ]);

      const erased = await owner.post(`/api/employment/${id}/erase`, { confirmName: "Petra Nová" });
      expect(erased.status).toBe(204);
      expect(
        await db.select().from(personExports).where(eq(personExports.id, res.body.id))
      ).toHaveLength(0);
    });
  });

  describe("the email", () => {
    it("refuses an email an open Employment holds, bound or not, ignoring case", async () => {
      const world = await setUp();
      const bobEmail = await emailOf(world.organizationId, world.users.bob.id);
      await add(world, world.users.owner.id, { name: "Petra Nová", email: "petra@example.test" });

      const bound = await add(world, world.users.owner.id, {
        name: "Bob Again",
        email: bobEmail.toUpperCase(),
      });
      const accountless = await add(world, world.users.owner.id, {
        name: "Petra Again",
        email: "PETRA@example.test",
      });

      expect([bound.status, code(bound)]).toEqual([409, "EMPLOYMENT_EMAIL_TAKEN"]);
      expect([accountless.status, code(accountless)]).toEqual([409, "EMPLOYMENT_EMAIL_TAKEN"]);
      expect(await accountlessRows(world.organizationId)).toHaveLength(1);
    });

    it("lets an ended Employment's email be used again, and several people go without one", async () => {
      const world = await setUp();
      const first = await add(world, world.users.owner.id, {
        name: "Petra Nová",
        email: "petra@example.test",
      });
      await db
        .update(employments)
        .set({ endedAt: new Date(), endRecordedAt: new Date() })
        .where(eq(employments.id, first.body.employmentId));

      const again = await add(world, world.users.owner.id, {
        name: "Petra Nová",
        email: "petra@example.test",
      });
      const noEmail1 = await add(world, world.users.owner.id, { name: "Ivo" });
      const noEmail2 = await add(world, world.users.owner.id, { name: "Eva", email: null });

      expect([again.status, noEmail1.status, noEmail2.status]).toEqual([201, 201, 201]);
    });

    it("answers the blur check for Create act holders only", async () => {
      const world = await setUp();
      const bobEmail = await emailOf(world.organizationId, world.users.bob.id);
      const check = async (callerId: string, email: string) =>
        (await as(callerId)).post(`/api/directory/${world.organizationId}/people/email-check`, {
          email,
        });

      const taken = await check(world.users.hana.id, bobEmail.toUpperCase());
      const free = await check(world.users.hana.id, "new@example.test");
      const member = await check(world.users.bob.id, "new@example.test");
      const malformed = await check(world.users.owner.id, "nope");

      expect([taken.status, taken.body]).toEqual([200, { available: false }]);
      expect([free.status, free.body]).toEqual([200, { available: true }]);
      expect([member.status, code(member)]).toEqual([403, "CREATE_DENIED"]);
      expect(malformed.status).toBe(422);
    });
  });
});
