import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { db } from "../../db/db.js";
import { directoryPermissionCells } from "../../db/schema/directory-schema.js";
import { employments, workerType } from "../../db/schema/employment-schema.js";
import { organizationUsers } from "../../db/schema/organization-users-schema.js";
import { subscriptionPlan, subscriptionStatus } from "../../db/schema/subscription-schema.js";
import { upsertSubscription } from "../../services/billing/subscriptionServices.js";
import { disableDirectory } from "../../services/directory/directorySettingsServices.js";
import { syncEmployment } from "../../services/employment/employmentServices.js";
import { ensureOrganizationForUser } from "../../services/organization/organizationServices.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { authCookieFor } from "./helpers/authHelper.js";
import { addMember, makeGroup, makeUser } from "./helpers/reportFixtures.js";
import { cleanupTestData } from "./helpers/testSetup.js";
import { enableEnterpriseDirectory } from "./helpers/directoryWorld.js";

type Person = {
  employmentId: string;
  name: string;
  markers: string[];
  user: { id: string | null };
};

describe("Reading the people directory through the Permission table", () => {
  let server: LoopbackServer;

  beforeAll(async () => {
    server = await listenOnLoopback(createServer());
  });

  beforeEach(async () => {
    await cleanupTestData();
  });

  afterAll(async () => {
    await server?.close();
    await cleanupTestData();
  });

  /**
   * Olga owns the organization and manages Support. In Support: Jana (plain
   * member), Gabi (member with admin access, so a Group admin), Dana (org-admin
   * grant), Eli (External worker), Karel (Deleted account, still open) and
   * Rita (left, then rejoined). Petra left. Ada has no account. Xena is in
   * another organization.
   */
  const setUp = async () => {
    const owner = await makeUser("Olga Owner");
    const jana = await makeUser("Jana Member");
    const gabi = await makeUser("Gabi Groupadmin");
    const dana = await makeUser("Dana Delegate");
    const eli = await makeUser("Eli External");
    const karel = await makeUser("Karel Deleted");
    const rita = await makeUser("Rita Rejoined");
    const petra = await makeUser("Petra Leaver");
    const xena = await makeUser("Xena Outsider");
    const organizationId = (await ensureOrganizationForUser(owner.id)).id;
    await ensureOrganizationForUser(xena.id);
    const support = await makeGroup("Support", owner.id, { organizationOwnerId: owner.id });
    await addMember(support, owner.id);
    await syncEmployment(organizationId, owner.id);
    for (const person of [jana, gabi, dana, eli, karel, rita, petra]) {
      await addMember(support, person.id, { adminAccess: person === gabi });
      await syncEmployment(organizationId, person.id);
    }
    await db.insert(organizationUsers).values({
      id: generateRandomUUID(),
      organizationId,
      userId: dana.id,
      grantedByUserId: owner.id,
    });

    const employmentOf = async (userId: string) => {
      const [row] = await db
        .select({ id: employments.id })
        .from(employments)
        .where(and(eq(employments.userId, userId), eq(employments.organizationId, organizationId)));
      return row!.id;
    };
    await db
      .update(employments)
      .set({ type: workerType.External })
      .where(eq(employments.userId, eli.id));
    await db
      .update(employments)
      .set({ accountDeletedAt: new Date("2026-09-01T10:00:00Z") })
      .where(eq(employments.userId, karel.id));
    await db
      .update(employments)
      .set({ endedAt: new Date("2026-03-31T12:00:00Z") })
      .where(eq(employments.userId, petra.id));
    const ritaFirstSpell = await employmentOf(rita.id);
    await db
      .update(employments)
      .set({
        startedAt: new Date("2025-01-10T08:00:00Z"),
        endedAt: new Date("2026-05-31T12:00:00Z"),
      })
      .where(eq(employments.id, ritaFirstSpell));
    await syncEmployment(organizationId, rita.id);
    const ada = uuidv4();
    await db.insert(employments).values({
      id: ada,
      organizationId,
      userId: null,
      name: "Ada Noaccount",
      email: "ada@example.test",
    });

    await enableEnterpriseDirectory(organizationId, owner.id);

    return {
      organizationId,
      users: { owner, jana, gabi, dana, eli, karel, rita, petra, xena },
      employment: {
        jana: await employmentOf(jana.id),
        owner: await employmentOf(owner.id),
        karel: await employmentOf(karel.id),
        petra: await employmentOf(petra.id),
        ritaFirstSpell,
        ada,
      },
    };
  };

  const as = async (userId: string) => {
    const cookie = await authCookieFor(userId);
    return (path: string) => request(server.url).get(path).set("Cookie", cookie);
  };

  const names = (people: Person[]) => people.map((person) => person.name);
  const markersByName = (people: Person[]) =>
    Object.fromEntries(people.map((person) => [person.name, person.markers]));

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

  describe("the directory list", () => {
    it("shows a colleague every open person by name, with only the External worker badge", async () => {
      const { organizationId, users } = await setUp();
      const get = await as(users.jana.id);

      const res = await get(`/api/directory/${organizationId}/people`);

      expect(res.status).toBe(200);
      expect(res.body.formerList).toBe(false);
      expect(names(res.body.people)).toEqual([
        "Ada Noaccount",
        "Dana Delegate",
        "Eli External",
        "Gabi Groupadmin",
        "Jana Member",
        "Karel Deleted",
        "Olga Owner",
        "Rita Rejoined",
      ]);
      expect(markersByName(res.body.people)).toEqual({
        "Ada Noaccount": [],
        "Dana Delegate": [],
        "Eli External": ["EXTERNAL_WORKER"],
        "Gabi Groupadmin": [],
        "Jana Member": [],
        "Karel Deleted": [],
        "Olga Owner": [],
        "Rita Rejoined": [],
      });
    });

    it("shows the owner and an org admin No account and Account deleted, and opens the Former list", async () => {
      const { organizationId, users } = await setUp();

      for (const viewer of [users.owner, users.dana]) {
        const res = await (await as(viewer.id))(`/api/directory/${organizationId}/people`);
        expect(res.status).toBe(200);
        expect(res.body.formerList).toBe(true);
        expect(markersByName(res.body.people)).toMatchObject({
          "Ada Noaccount": ["NO_ACCOUNT"],
          "Eli External": ["EXTERNAL_WORKER"],
          "Karel Deleted": ["ACCOUNT_DELETED"],
          "Jana Member": [],
        });
      }
    });

    it("sends no user id for a record without an account, to any viewer", async () => {
      const { organizationId, users, employment } = await setUp();

      for (const viewer of [users.jana, users.owner]) {
        const res = await (await as(viewer.id))(`/api/directory/${organizationId}/people`);
        const ada = res.body.people.find(
          (person: Person) => person.employmentId === employment.ada
        );
        expect(ada.user).toEqual({
          id: null,
          name: "Ada Noaccount",
          initials: "AN",
          avatarColor: expect.any(String),
        });
        const profile = await (
          await as(viewer.id)
        )(`/api/directory/${organizationId}/people/${employment.ada}`);
        expect(profile.body.user.id).toBeNull();
      }
      const jana = await (await as(users.jana.id))(`/api/directory/${organizationId}/people`);
      expect(
        jana.body.people.find((person: Person) => person.employmentId === employment.jana).user.id
      ).toBe(users.jana.id);
    });

    it("hides the restricted markers from a group admin", async () => {
      const { organizationId, users } = await setUp();
      const res = await (await as(users.gabi.id))(`/api/directory/${organizationId}/people`);
      expect(markersByName(res.body.people)).toMatchObject({
        "Ada Noaccount": [],
        "Karel Deleted": [],
      });
    });

    it("leaves out everyone whose Card the viewer can't read, but never the viewer's own record", async () => {
      const { organizationId, users } = await setUp();
      await setCell(organizationId, "CARD", "COLLEAGUE", "NONE");

      const res = await (await as(users.jana.id))(`/api/directory/${organizationId}/people`);

      expect(names(res.body.people)).toEqual(["Jana Member"]);
    });

    it("refuses a viewer with no standing in the organization, and an organization with the directory off", async () => {
      const { organizationId, users } = await setUp();

      const outsider = await (await as(users.xena.id))(`/api/directory/${organizationId}/people`);
      expect(outsider.status).toBe(403);
      expect(outsider.body.errors[0].context.code).toBe("NOT_IN_DIRECTORY");

      const leaver = await (await as(users.petra.id))(`/api/directory/${organizationId}/people`);
      expect(leaver.status).toBe(403);

      await db.transaction((tx) =>
        disableDirectory({ organizationId, userId: users.owner.id }, tx)
      );
      const off = await (await as(users.jana.id))(`/api/directory/${organizationId}/people`);
      expect(off.status).toBe(409);
      expect(off.body.errors[0].context.code).toBe("DIRECTORY_OFF");
    });
  });

  describe("the Former list", () => {
    it("lists one row per ended spell, latest end first, for the owner and org admins", async () => {
      const { organizationId, users, employment } = await setUp();

      for (const viewer of [users.owner, users.dana]) {
        const res = await (await as(viewer.id))(`/api/directory/${organizationId}/former`);
        expect(res.status).toBe(200);
        expect(
          res.body.map((row: Person & { endedAt: string }) => [
            row.employmentId,
            row.name,
            row.endedAt,
            row.markers,
          ])
        ).toEqual([
          [employment.ritaFirstSpell, "Rita Rejoined", "2026-05-31T12:00:00.000Z", ["REJOINED"]],
          [employment.petra, "Petra Leaver", "2026-03-31T12:00:00.000Z", []],
        ]);
      }
    });

    it("leaves the spell dates out for a viewer who doesn't read Job, and still sorts by end", async () => {
      const { organizationId, users, employment } = await setUp();
      await setCell(organizationId, "JOB", "ORGANIZATION_ADMIN", "NONE");

      const res = await (await as(users.dana.id))(`/api/directory/${organizationId}/former`);

      expect(res.status).toBe(200);
      expect(
        res.body.map((row: Person & { startedAt: string | null; endedAt: string | null }) => [
          row.employmentId,
          row.startedAt,
          row.endedAt,
        ])
      ).toEqual([
        [employment.ritaFirstSpell, null, null],
        [employment.petra, null, null],
      ]);
    });

    it("refuses colleagues, group admins and External workers", async () => {
      const { organizationId, users } = await setUp();

      for (const viewer of [users.jana, users.gabi, users.eli]) {
        const res = await (await as(viewer.id))(`/api/directory/${organizationId}/former`);
        expect(res.status).toBe(403);
        expect(res.body.errors[0].context.code).toBe("FORMER_LIST_DENIED");
      }
    });
  });

  describe("a profile", () => {
    const profilePath = (organizationId: string, employmentId: string) =>
      `/api/directory/${organizationId}/people/${employmentId}`;

    it("gives a colleague Card, Photo and Work contact and an External worker Card and Photo, with no spell dates or account facts", async () => {
      const { organizationId, users, employment } = await setUp();

      const external = await (await as(users.eli.id))(profilePath(organizationId, employment.jana));
      expect(external.status).toBe(200);
      expect(external.body.sections).toEqual({
        card: expect.objectContaining({ level: "READ" }),
        photo: { level: "READ", photo: null },
      });
      expect(external.body).not.toHaveProperty("account");

      const colleague = await (
        await as(users.karel.id)
      )(profilePath(organizationId, employment.jana));
      expect(colleague.body).toMatchObject({ name: "Jana Member", self: false, ended: false });
      expect(colleague.body.sections).toEqual({
        card: expect.objectContaining({ level: "READ" }),
        photo: { level: "READ", photo: null },
        workContact: { level: "READ", workEmail: null, workPhone: null },
      });
      expect(colleague.body).not.toHaveProperty("account");
      expect(JSON.stringify(colleague.body)).not.toContain("startedAt");
    });

    it("gives a group admin the Job Section with the spell dates for a plain member of their group", async () => {
      const { organizationId, users, employment } = await setUp();
      const get = await as(users.gabi.id);

      const member = await get(profilePath(organizationId, employment.jana));
      expect(Object.keys(member.body.sections)).toEqual(["card", "photo", "workContact", "job"]);
      expect(member.body.sections.job).toMatchObject({
        level: "READ",
        spell: { startedAt: expect.any(String), endedAt: null },
      });
      expect(member.body).not.toHaveProperty("account");

      const manager = await get(profilePath(organizationId, employment.owner));
      expect(Object.keys(manager.body.sections)).toEqual(["card", "photo", "workContact"]);
    });

    it("gives the person every Section of their own record, and their account facts", async () => {
      const { organizationId, users, employment } = await setUp();
      const res = await (await as(users.jana.id))(profilePath(organizationId, employment.jana));

      expect(res.body.self).toBe(true);
      expect(res.body.sections).toEqual({
        card: expect.objectContaining({ level: "READ" }),
        photo: { level: "WRITE", photo: null },
        workContact: { level: "READ", workEmail: null, workPhone: null },
        job: expect.objectContaining({
          level: "READ",
          spell: { startedAt: expect.any(String), endedAt: null },
        }),
        contact: expect.objectContaining({ level: "WRITE", notice: expect.any(String) }),
        personal: { level: "WRITE" },
      });
      expect(res.body.account).toEqual({
        status: "ACTIVE",
        signInEmail: `${users.jana.id.toLowerCase()}@report-e2e.test`,
        directoryRoles: [],
      });
    });

    it("gives the owner the account facts of a person without an account and of a Deleted account", async () => {
      const { organizationId, users, employment } = await setUp();
      const get = await as(users.owner.id);

      const ada = await get(profilePath(organizationId, employment.ada));
      expect(ada.body).toMatchObject({
        name: "Ada Noaccount",
        image: null,
        markers: ["NO_ACCOUNT"],
        account: { status: "NO_ACCOUNT", signInEmail: "ada@example.test", directoryRoles: [] },
      });
      expect(Object.keys(ada.body.sections)).toHaveLength(6);

      const karel = await get(profilePath(organizationId, employment.karel));
      expect(karel.body).toMatchObject({
        markers: ["ACCOUNT_DELETED"],
        account: { status: "DELETED" },
      });
    });

    it("drops a Section from the answer as soon as its cell turns to none", async () => {
      const { organizationId, users, employment } = await setUp();
      await setCell(organizationId, "WORK_CONTACT", "COLLEAGUE", "NONE");

      const res = await (await as(users.karel.id))(profilePath(organizationId, employment.jana));

      expect(res.body.sections).toEqual({
        card: expect.objectContaining({ level: "READ" }),
        photo: { level: "READ", photo: null },
      });
    });

    it("reaches an ended record for the owner only, and answers 404 to the rest", async () => {
      const { organizationId, users, employment } = await setUp();

      const owner = await (await as(users.owner.id))(profilePath(organizationId, employment.petra));
      expect(owner.status).toBe(200);
      expect(owner.body).toMatchObject({ ended: true, name: "Petra Leaver" });
      expect(owner.body.sections.job.spell.endedAt).toBe("2026-03-31T12:00:00.000Z");

      for (const viewer of [users.jana, users.gabi]) {
        const res = await (await as(viewer.id))(profilePath(organizationId, employment.petra));
        expect(res.status).toBe(404);
        expect(res.body.errors[0].context.code).toBe("PERSON_NOT_FOUND");
      }
    });

    it("answers 404 for an Employment of another organization", async () => {
      const { organizationId, users } = await setUp();
      const [other] = await db
        .select({ id: employments.id })
        .from(employments)
        .where(eq(employments.userId, users.xena.id));
      const elsewhere = other?.id ?? uuidv4();

      const res = await (await as(users.owner.id))(profilePath(organizationId, elsewhere));
      expect(res.status).toBe(404);
    });
  });

  describe("a lapsed plan", () => {
    it("keeps the list, the Former list and the profiles readable", async () => {
      const { organizationId, users, employment } = await setUp();
      await upsertSubscription(organizationId, {
        plan: subscriptionPlan.Pro,
        status: subscriptionStatus.Active,
        graceEndsAt: null,
      });

      const owner = await as(users.owner.id);
      expect((await owner(`/api/directory/${organizationId}/people`)).status).toBe(200);
      expect((await owner(`/api/directory/${organizationId}/former`)).status).toBe(200);
      const jana = await as(users.jana.id);
      const profile = await jana(`/api/directory/${organizationId}/people/${employment.jana}`);
      expect(profile.status).toBe(200);
      expect(Object.keys(profile.body.sections)).toHaveLength(6);

      const organizations = await jana("/api/directory/organizations");
      expect(organizations.body).toContainEqual(
        expect.objectContaining({ organizationId, enabled: true, writable: false })
      );
    });
  });
});
