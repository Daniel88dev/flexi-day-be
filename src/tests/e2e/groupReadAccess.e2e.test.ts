import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { v4 as uuidv4 } from "uuid";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { db } from "../../db/db.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
import { userYearQuotas } from "../../db/schema/user-year-quotas-schema.js";
import { createTestGroup, createTestUser, cleanupTestData } from "./helpers/testSetup.js";
import { authCookieFor } from "./helpers/authHelper.js";
import {
  ensureOrganizationForUser,
  grantOrganizationAdmin,
} from "../../services/organization/organizationServices.js";

type Caller = "manager" | "viewMember" | "adminMember" | "orgAdmin" | "plainMember" | "outsider";

describe("who may read a group's members and quotas", () => {
  let server: LoopbackServer;
  let groupId: string;
  const ids = {} as Record<Caller, string>;
  const cookies = {} as Record<Caller, string>;

  beforeAll(async () => {
    await cleanupTestData();
    server = await listenOnLoopback(createServer());

    const names: Record<Caller, string> = {
      manager: "Mara Manager",
      viewMember: "Vic Viewer",
      adminMember: "Ada Admin",
      orgAdmin: "Oren Orgadmin",
      plainMember: "Pia Plain",
      outsider: "Otis Outsider",
    };
    for (const caller of Object.keys(names) as Caller[]) {
      const email = `reads-${caller.toLowerCase()}@test.com`;
      ids[caller] = (await createTestUser(email, names[caller], "password123")).id;
    }

    const group = await createTestGroup("Reads", ids.manager);
    groupId = group.id;

    const membership = (
      userId: string,
      flags: { viewAccess: boolean; adminAccess: boolean; approverAccess: boolean }
    ) => ({ id: uuidv4(), userId, groupId, controlledUser: true, ...flags });

    await db.insert(groupUsers).values([
      membership(ids.manager, { viewAccess: true, adminAccess: true, approverAccess: true }),
      membership(ids.viewMember, { viewAccess: true, adminAccess: false, approverAccess: false }),
      membership(ids.adminMember, { viewAccess: false, adminAccess: true, approverAccess: false }),
      membership(ids.plainMember, {
        viewAccess: false,
        adminAccess: false,
        approverAccess: false,
      }),
    ]);

    await db.insert(userYearQuotas).values(
      [ids.viewMember, ids.plainMember].map((userId) => ({
        id: uuidv4(),
        userId,
        groupId,
        relatedYear: "2026",
        vacationDays: 20,
        homeOfficeDays: 0,
      }))
    );

    await grantOrganizationAdmin({
      organizationId: (await ensureOrganizationForUser(ids.manager)).id,
      userId: ids.orgAdmin,
      grantedByUserId: ids.manager,
    });

    for (const caller of Object.keys(names) as Caller[]) {
      cookies[caller] = await authCookieFor(ids[caller]);
    }
  });

  afterAll(async () => {
    await server?.close();
    await cleanupTestData();
  });

  describe.each(["manager", "viewMember", "adminMember", "orgAdmin"] as const)("%s", (caller) => {
    it("lists the group's members", async () => {
      const res = await request(server.url)
        .get(`/api/group-user/${groupId}`)
        .set("Cookie", cookies[caller])
        .expect(200);

      expect(res.body.map((row: { userId: string }) => row.userId).sort()).toEqual(
        [ids.manager, ids.viewMember, ids.adminMember, ids.plainMember].sort()
      );
    });

    it("reads the group's quotas", async () => {
      const res = await request(server.url)
        .get(`/api/quotas/${groupId}?year=2026`)
        .set("Cookie", cookies[caller])
        .expect(200);

      expect(res.body.map((row: { userId: string }) => row.userId).sort()).toEqual(
        [ids.viewMember, ids.plainMember].sort()
      );
    });

    it("narrows the quotas to one member by their better-auth id", async () => {
      expect(ids.plainMember).toMatch(/^[A-Za-z0-9]{32}$/);

      const res = await request(server.url)
        .get(`/api/quotas/${groupId}?year=2026&userId=${ids.plainMember}`)
        .set("Cookie", cookies[caller])
        .expect(200);

      expect(res.body.map((row: { userId: string }) => row.userId)).toEqual([ids.plainMember]);
    });
  });

  it("rejects an empty userId filter", async () => {
    await request(server.url)
      .get(`/api/quotas/${groupId}?year=2026&userId=`)
      .set("Cookie", cookies.manager)
      .expect(400);
  });

  describe.each(["plainMember", "outsider"] as const)("%s", (caller) => {
    it("is refused the members list", async () => {
      const res = await request(server.url)
        .get(`/api/group-user/${groupId}`)
        .set("Cookie", cookies[caller])
        .expect(403);

      expect(res.body).toEqual({ message: "No access for related group" });
    });

    it("is refused the quotas", async () => {
      const res = await request(server.url)
        .get(`/api/quotas/${groupId}?year=2026`)
        .set("Cookie", cookies[caller])
        .expect(403);

      expect(res.body).toEqual({ errors: [{ message: "No permission for related group" }] });
    });
  });
});
