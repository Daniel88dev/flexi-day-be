import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import { and, eq, isNull } from "drizzle-orm";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { db } from "../../db/db.js";
import { employments } from "../../db/schema/employment-schema.js";
import {
  directoryProfileHistory,
  directoryProfiles,
} from "../../db/schema/directory-profile-schema.js";
import { organizationUsers } from "../../db/schema/organization-users-schema.js";
import { vacation } from "../../db/schema/vacation-schema.js";
import { subscriptionPlan, subscriptionStatus } from "../../db/schema/subscription-schema.js";
import { upsertSubscription } from "../../services/billing/subscriptionServices.js";
import {
  disableDirectory,
  enableDirectory,
} from "../../services/directory/directorySettingsServices.js";
import { syncEmployment } from "../../services/employment/employmentServices.js";
import { ensureOrganizationForUser } from "../../services/organization/organizationServices.js";
import { upsertAttendanceSettings } from "../../services/organization/attendanceSettingsServices.js";
import { businessDateInZone } from "../../utils/dateFunc.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { authCookieFor } from "./helpers/authHelper.js";
import {
  addLeave,
  addMember,
  makeGroup,
  makeUser,
  resetReportData,
} from "./helpers/reportFixtures.js";
import { cleanupTestData } from "./helpers/testSetup.js";

vi.mock("../../services/email/index.js", () => ({
  emailSender: { sendTemplated: () => Promise.resolve() },
}));

const ZONE = "Europe/Prague";
const DAY_MS = 24 * 60 * 60 * 1000;
const shift = (date: string, days: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

describe("ending an Employment in a Directory organization", () => {
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
   * Support. In Support: Jana (also a delegated org admin, with bookings) and
   * Bob. Gina manages Sales without a membership row; Mia is in Sales. Dana is
   * a delegated org admin in no group.
   */
  const setUp = async () => {
    const owner = await makeUser("Olga Owner");
    const jana = await makeUser("Jana Member");
    const bob = await makeUser("Bob Plain");
    const gina = await makeUser("Gina Manager");
    const mia = await makeUser("Mia Sales");
    const dana = await makeUser("Dana Delegate");
    const organizationId = (await ensureOrganizationForUser(owner.id)).id;
    await upsertAttendanceSettings(organizationId, { timezone: ZONE });

    const support = await makeGroup("Support", owner.id, { organizationOwnerId: owner.id });
    const sales = await makeGroup("Sales", gina.id, { organizationOwnerId: owner.id });
    await addMember(support, owner.id, { adminAccess: true, approverAccess: true });
    await addMember(support, jana.id);
    await addMember(support, bob.id);
    await addMember(sales, mia.id);
    for (const userId of [jana.id, dana.id]) {
      await db.insert(organizationUsers).values({
        id: generateRandomUUID(),
        organizationId,
        userId,
        grantedByUserId: owner.id,
      });
    }
    for (const person of [owner, jana, bob, gina, mia, dana]) {
      await syncEmployment(organizationId, person.id);
    }
    await db
      .update(employments)
      .set({ startedAt: new Date("2020-01-01T00:00:00Z") })
      .where(eq(employments.organizationId, organizationId));

    await upsertSubscription(organizationId, {
      plan: subscriptionPlan.Enterprise,
      status: subscriptionStatus.Active,
      graceEndsAt: null,
    });
    await db.transaction((tx) =>
      enableDirectory({ organizationId, userId: owner.id, agreementVersion: 1 }, tx)
    );

    const today = businessDateInZone(new Date(), ZONE);
    const bookings = {
      past: await addLeave(support, jana.id, shift(today, -7), { approvedBy: owner.id }),
      tomorrow: await addLeave(support, jana.id, shift(today, 1), { approvedBy: owner.id }),
      pending: await addLeave(support, jana.id, shift(today, 5), { approved: false }),
    };

    return {
      organizationId,
      support,
      sales,
      today,
      bookings,
      users: { owner, jana, bob, gina, mia, dana },
    };
  };

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
      delete: (path: string) => request(server.url).delete(path).set("Cookie", cookie),
    };
  };

  const lapse = (organizationId: string) =>
    upsertSubscription(organizationId, {
      plan: subscriptionPlan.Pro,
      status: subscriptionStatus.Active,
      graceEndsAt: null,
    });

  const code = (res: request.Response) => res.body.errors?.[0]?.context?.code;

  const openEmployment = async (organizationId: string, userId: string) => {
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

  const holdsAdminGrant = async (organizationId: string, userId: string) => {
    const rows = await db
      .select({ id: organizationUsers.id })
      .from(organizationUsers)
      .where(
        and(
          eq(organizationUsers.organizationId, organizationId),
          eq(organizationUsers.userId, userId),
          isNull(organizationUsers.deletedAt)
        )
      );
    return rows.length > 0;
  };

  const employmentIdOf = async (organizationId: string, userId: string) =>
    (await openEmployment(organizationId, userId))!.id;

  const accountless = async (organizationId: string, name: string) => {
    const id = generateRandomUUID();
    await db.insert(employments).values({
      id,
      organizationId,
      userId: null,
      name,
      email: `${name.split(" ")[0]!.toLowerCase()}@example.test`,
      startedAt: new Date("2020-01-01T00:00:00Z"),
    });
    return id;
  };

  const giveRole = async (
    world: Awaited<ReturnType<typeof setUp>>,
    userId: string,
    role: string
  ) => {
    const res = await (
      await as(world.users.owner.id)
    ).put(
      `/api/directory/${world.organizationId}/roles/${await employmentIdOf(world.organizationId, userId)}`,
      { roles: [role] }
    );
    expect(res.status).toBe(200);
  };

  const setCell = async (
    world: Awaited<ReturnType<typeof setUp>>,
    row: string,
    audience: string,
    value: string
  ) => {
    const res = await (
      await as(world.users.owner.id)
    ).patch(`/api/directory/${world.organizationId}/permissions`, { row, audience, value });
    expect(res.status).toBe(200);
  };

  const end = async (callerId: string, employmentId: string, endedOn: string) =>
    (await as(callerId)).post(`/api/employment/${employmentId}/end`, { endedOn });

  const live = async (vacationId: string) => {
    const [row] = await db.select().from(vacation).where(eq(vacation.id, vacationId));
    return row!.deletedAt === null;
  };

  describe("a link removal", () => {
    it.each([
      ["on Enterprise", false],
      ["on a lapsed plan", true],
    ])(
      "removing the last group %s leaves the Employment open, keeps the admin grant and cancels the bookings there",
      async (_label, lapsed) => {
        const world = await setUp();
        if (lapsed) await lapse(world.organizationId);
        const { jana, owner } = world.users;

        const res = await (
          await as(owner.id)
        ).delete(`/api/group-user/${world.support}/${jana.id}`);

        expect(res.status).toBe(200);
        expect(await openEmployment(world.organizationId, jana.id)).toBeDefined();
        expect(await holdsAdminGrant(world.organizationId, jana.id)).toBe(true);
        expect(await live(world.bookings.past)).toBe(true);
        expect(await live(world.bookings.tomorrow)).toBe(false);
        expect(await live(world.bookings.pending)).toBe(false);
      }
    );

    it("revoking an admin grant never ends the Employment", async () => {
      const world = await setUp();
      const { dana, owner } = world.users;

      const res = await (
        await as(owner.id)
      ).delete(`/api/organization/admins/${dana.id}?organizationId=${world.organizationId}`);

      expect(res.status).toBe(200);
      expect(await holdsAdminGrant(world.organizationId, dana.id)).toBe(false);
      expect(await openEmployment(world.organizationId, dana.id)).toBeDefined();
    });

    it("Change manager never ends the outgoing manager's Employment", async () => {
      const world = await setUp();
      const { gina, mia, owner } = world.users;

      const res = await (
        await as(owner.id)
      ).put(`/api/group/${world.sales}/manager`, { managerUserId: mia.id });

      expect(res.status).toBe(200);
      expect(await openEmployment(world.organizationId, gina.id)).toBeDefined();
    });

    it("follows the derived rule again once the directory is off", async () => {
      const world = await setUp();
      const { jana, owner } = world.users;
      await db.transaction((tx) =>
        disableDirectory({ organizationId: world.organizationId, userId: owner.id }, tx)
      );

      const res = await (await as(owner.id)).delete(`/api/group-user/${world.support}/${jana.id}`);

      expect(res.status).toBe(200);
      expect(await openEmployment(world.organizationId, jana.id)).toBeUndefined();
      expect(await holdsAdminGrant(world.organizationId, jana.id)).toBe(false);
    });
  });

  describe("End employment", () => {
    it("lets HR end a live account: every group left, the admin row dropped, bookings cancelled", async () => {
      const world = await setUp();
      const { jana, bob } = world.users;
      await giveRole(world, bob.id, "HR");
      const janaEmployment = await employmentIdOf(world.organizationId, jana.id);

      const res = await end(bob.id, janaEmployment, world.today);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: janaEmployment, ended: true, cancelledBookings: 2 });
      expect(await openEmployment(world.organizationId, jana.id)).toBeUndefined();
      expect(await holdsAdminGrant(world.organizationId, jana.id)).toBe(false);
      expect(await live(world.bookings.past)).toBe(true);
      expect(await live(world.bookings.tomorrow)).toBe(false);
    });

    it("follows the End cell: an org admin may, a member and Leadership may not, and HR not once its cell says no", async () => {
      const world = await setUp();
      const { bob, mia, dana, gina } = world.users;
      await giveRole(world, gina.id, "LEADERSHIP");
      await giveRole(world, mia.id, "HR");
      await setCell(world, "END_EMPLOYMENT", "HR", "NO");
      const bobEmployment = await employmentIdOf(world.organizationId, bob.id);

      for (const callerId of [bob.id, gina.id, mia.id]) {
        const refused = await end(callerId, bobEmployment, world.today);
        expect(refused.status).toBe(403);
      }
      expect(await openEmployment(world.organizationId, bob.id)).toBeDefined();

      const allowed = await end(dana.id, bobEmployment, world.today);
      expect(allowed.status).toBe(200);
    });

    it("lets Leadership end once the owner allows its End cell", async () => {
      const world = await setUp();
      const { bob, gina } = world.users;
      await giveRole(world, gina.id, "LEADERSHIP");
      const bobEmployment = await employmentIdOf(world.organizationId, bob.id);
      expect((await end(gina.id, bobEmployment, world.today)).status).toBe(403);
      await setCell(world, "END_EMPLOYMENT", "LEADERSHIP", "ALLOWED");

      const res = await end(gina.id, bobEmployment, world.today);

      expect(res.status).toBe(200);
    });

    it("refuses a date after today, a group's manager and the owner", async () => {
      const world = await setUp();
      const { owner, bob, gina } = world.users;

      const future = await end(
        owner.id,
        await employmentIdOf(world.organizationId, bob.id),
        shift(world.today, 1)
      );
      expect(future.status).toBe(422);
      expect(code(future)).toBe("END_DATE_IN_FUTURE");

      const manager = await end(
        owner.id,
        await employmentIdOf(world.organizationId, gina.id),
        world.today
      );
      expect(manager.status).toBe(409);
      expect(code(manager)).toBe("MANAGES_GROUP");

      const ownSpell = await end(
        owner.id,
        await employmentIdOf(world.organizationId, owner.id),
        world.today
      );
      expect(ownSpell.status).toBe(409);
      expect(code(ownSpell)).toBe("OWNER_EMPLOYMENT");

      for (const userId of [bob.id, gina.id, owner.id]) {
        expect(await openEmployment(world.organizationId, userId)).toBeDefined();
      }
    });

    it("ends a person without an account, and keeps working on a lapsed plan", async () => {
      const world = await setUp();
      await lapse(world.organizationId);
      const ada = await accountless(world.organizationId, "Ada Noaccount");

      const res = await end(world.users.owner.id, ada, shift(world.today, -1));

      expect(res.status).toBe(200);
      const [row] = await db.select().from(employments).where(eq(employments.id, ada));
      expect(businessDateInZone(row!.endedAt!, ZONE)).toBe(shift(world.today, -1));
    });

    it("ends the person's Directory roles", async () => {
      const world = await setUp();
      const { bob, owner } = world.users;
      await giveRole(world, bob.id, "HR");
      const bobEmployment = await employmentIdOf(world.organizationId, bob.id);

      expect((await end(owner.id, bobEmployment, world.today)).status).toBe(200);

      const roles = await (await as(owner.id)).get(`/api/directory/${world.organizationId}/roles`);
      expect(JSON.stringify(roles.body)).not.toContain(bobEmployment);
    });
  });

  describe("Reports to", () => {
    it("clears it on every open record that named the person, with a Profile history entry, and leaves ended records alone", async () => {
      const world = await setUp();
      const { owner, jana, bob, mia, dana } = world.users;
      const janaEmployment = await employmentIdOf(world.organizationId, jana.id);
      const owners = await as(owner.id);
      for (const userId of [bob.id, mia.id]) {
        const res = await owners.patch(
          `/api/directory/${world.organizationId}/people/${await employmentIdOf(world.organizationId, userId)}`,
          { card: { reportsToEmploymentId: janaEmployment } }
        );
        expect(res.status).toBe(200);
      }
      const former = await accountless(world.organizationId, "Fred Former");
      await db.insert(directoryProfiles).values({
        employmentId: former,
        organizationId: world.organizationId,
        reportsToEmploymentId: janaEmployment,
      });
      await db
        .update(employments)
        .set({ endedAt: new Date("2025-06-30T12:00:00Z") })
        .where(eq(employments.id, former));

      expect((await end(dana.id, janaEmployment, world.today)).status).toBe(200);

      const reportsToOf = async (employmentId: string) => {
        const [row] = await db
          .select({ reportsTo: directoryProfiles.reportsToEmploymentId })
          .from(directoryProfiles)
          .where(eq(directoryProfiles.employmentId, employmentId));
        return row?.reportsTo;
      };
      const bobEmployment = await employmentIdOf(world.organizationId, bob.id);
      const miaEmployment = await employmentIdOf(world.organizationId, mia.id);
      expect(await reportsToOf(bobEmployment)).toBeNull();
      expect(await reportsToOf(miaEmployment)).toBeNull();
      expect(await reportsToOf(former)).toBe(janaEmployment);

      const entries = await db
        .select()
        .from(directoryProfileHistory)
        .where(eq(directoryProfileHistory.actorUserId, dana.id));
      expect(
        entries
          .map(({ employmentId, section, fields, audience }) => ({
            employmentId,
            section,
            fields,
            audience,
          }))
          .sort((a, b) => a.employmentId.localeCompare(b.employmentId))
      ).toEqual(
        [bobEmployment, miaEmployment].sort().map((employmentId) => ({
          employmentId,
          section: "CARD",
          fields: ["reportsTo"],
          audience: "ORGANIZATION_ADMIN",
        }))
      );
    });
  });

  describe("people in no group", () => {
    const removeJanaFromSupport = async (world: Awaited<ReturnType<typeof setUp>>) => {
      const res = await (
        await as(world.users.owner.id)
      ).delete(`/api/group-user/${world.support}/${world.users.jana.id}`);
      expect(res.status).toBe(200);
    };

    it("shows them on Team attendance to org admins only", async () => {
      const world = await setUp();
      await removeJanaFromSupport(world);
      const path = `/api/attendance/team?organizationId=${world.organizationId}&from=${world.today}&to=${world.today}`;
      const peopleSeenBy = async (userId: string) => {
        const res = await (await as(userId)).get(path);
        expect(res.status).toBe(200);
        return (res.body.people as { userId: string; groups: unknown[] }[]).map(
          (person) => person.userId
        );
      };

      const admin = await peopleSeenBy(world.users.dana.id);
      expect(admin).toContain(world.users.jana.id);
      const groupAdmin = await peopleSeenBy(world.users.gina.id);
      expect(groupAdmin).toEqual([world.users.mia.id]);
    });

    it("marks them for the owner and org admins in the directory list, and for nobody else", async () => {
      const world = await setUp();
      await removeJanaFromSupport(world);
      const ada = await accountless(world.organizationId, "Ada Noaccount");
      const path = `/api/directory/${world.organizationId}/people`;

      const owners = await (await as(world.users.owner.id)).get(path);
      expect(owners.status).toBe(200);
      expect(owners.body.noGroupFilter).toBe(true);
      const noGroup = (owners.body.people as { employmentId: string; noGroup: boolean }[])
        .filter((person) => person.noGroup)
        .map((person) => person.employmentId)
        .sort();
      expect(noGroup).toEqual(
        [
          ada,
          await employmentIdOf(world.organizationId, world.users.jana.id),
          await employmentIdOf(world.organizationId, world.users.dana.id),
        ].sort()
      );
      const admins = await (await as(world.users.dana.id)).get(path);
      expect(admins.body.noGroupFilter).toBe(true);

      await giveRole(world, world.users.bob.id, "HR");
      for (const userId of [world.users.bob.id, world.users.mia.id]) {
        const res = await (await as(userId)).get(path);
        expect(res.body.noGroupFilter).toBe(false);
        for (const person of res.body.people) expect(person).not.toHaveProperty("noGroup");
      }
    });
  });

  describe("the profile's actions and the End preview", () => {
    it("offers End to whoever the End cell allows, and Export and Erase to the owner and org admins", async () => {
      const world = await setUp();
      const { owner, bob, mia, gina } = world.users;
      await giveRole(world, mia.id, "HR");
      const bobEmployment = await employmentIdOf(world.organizationId, bob.id);
      const actionsOf = async (userId: string, employmentId: string) => {
        const res = await (
          await as(userId)
        ).get(`/api/directory/${world.organizationId}/people/${employmentId}`);
        expect(res.status).toBe(200);
        return res.body.actions;
      };

      expect(await actionsOf(owner.id, bobEmployment)).toEqual({
        end: true,
        export: true,
        erase: false,
        hold: false,
        invite: false,
        changeType: true,
        copyFromPreviousSpell: false,
      });
      expect(await actionsOf(mia.id, bobEmployment)).toEqual({
        end: true,
        export: false,
        erase: false,
        hold: false,
        invite: false,
        changeType: true,
        copyFromPreviousSpell: false,
      });
      expect(await actionsOf(gina.id, await employmentIdOf(world.organizationId, mia.id))).toEqual({
        end: false,
        export: false,
        erase: false,
        hold: false,
        invite: false,
        changeType: false,
        copyFromPreviousSpell: false,
      });
      expect(
        (await actionsOf(owner.id, await employmentIdOf(world.organizationId, owner.id))).end
      ).toBe(false);
    });

    it("lists the groups left, the bookings cancelled, the admin row, the roles and the people whose Reports to is cleared", async () => {
      const world = await setUp();
      const { owner, jana, bob } = world.users;
      const janaEmployment = await employmentIdOf(world.organizationId, jana.id);
      const bobEmployment = await employmentIdOf(world.organizationId, bob.id);
      const owners = await as(owner.id);
      await owners.patch(`/api/directory/${world.organizationId}/people/${bobEmployment}`, {
        card: { reportsToEmploymentId: janaEmployment },
      });
      await owners.patch(`/api/directory/${world.organizationId}/people/${janaEmployment}`, {
        job: { leavingDate: shift(world.today, -2) },
      });
      await giveRole(world, jana.id, "HR");

      const res = await owners.get(
        `/api/directory/${world.organizationId}/people/${janaEmployment}/end-preview`
      );

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        employmentId: janaEmployment,
        today: world.today,
        startedOn: "2020-01-01",
        suggestedEndedOn: shift(world.today, -2),
        reportees: [{ employmentId: bobEmployment, name: "Bob Plain" }],
        groups: [{ id: world.support, name: "Support" }],
        managedGroups: [],
        cancelledBookings: 2,
        organizationAdmin: true,
        directoryRoles: ["HR"],
        atEndSections: [],
      });
    });

    it("suggests today when the leaving date is later, and names the groups a manager blocks on", async () => {
      const world = await setUp();
      const { owner, gina } = world.users;
      const ginaEmployment = await employmentIdOf(world.organizationId, gina.id);
      const owners = await as(owner.id);
      await owners.patch(`/api/directory/${world.organizationId}/people/${ginaEmployment}`, {
        job: { leavingDate: shift(world.today, 10) },
      });

      const res = await owners.get(
        `/api/directory/${world.organizationId}/people/${ginaEmployment}/end-preview`
      );

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        suggestedEndedOn: world.today,
        managedGroups: [{ id: world.sales, name: "Sales" }],
        groups: [],
        cancelledBookings: 0,
        organizationAdmin: false,
        directoryRoles: [],
      });
    });

    it("refuses a viewer the End cell doesn't allow, and an ended record", async () => {
      const world = await setUp();
      const { owner, bob, mia } = world.users;
      const bobEmployment = await employmentIdOf(world.organizationId, bob.id);
      const path = `/api/directory/${world.organizationId}/people/${bobEmployment}/end-preview`;

      const member = await (await as(mia.id)).get(path);
      expect(member.status).toBe(403);
      expect(code(member)).toBe("END_DENIED");

      expect((await end(owner.id, bobEmployment, world.today)).status).toBe(200);
      const ended = await (await as(owner.id)).get(path);
      expect(ended.status).toBe(409);
      expect(code(ended)).toBe("EMPLOYMENT_ENDED");
    });
  });
});
