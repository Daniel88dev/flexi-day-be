import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import {
  ensureOrganizationForUser,
  grantOrganizationAdmin,
} from "../../services/organization/organizationServices.js";
import { upsertSubscription } from "../../services/billing/subscriptionServices.js";
import { saveBirthday } from "../../services/birthday/birthdayServices.js";
import { subscriptionPlan, subscriptionStatus } from "../../db/schema/subscription-schema.js";
import { authCookieFor } from "./helpers/authHelper.js";
import {
  addLeave,
  addMember,
  addQuota,
  dayIn,
  makeGroup,
  makeUser,
  resetReportData,
} from "./helpers/reportFixtures.js";

const FUTURE_YEAR = new Date().getFullYear() + 1;
const MONTH = 3;

/**
 * "Support" belongs to the owner's organization. The owner and a delegate
 * administer it through the organization, and its manager holds no membership
 * row, so all three administer it without belonging to it.
 */
const seed = async () => {
  const owner = await makeUser("Olivia Owner");
  const manager = await makeUser("Manny Manager");
  const delegate = await makeUser("Dee Delegate");
  const erin = await makeUser("Erin Member");
  const frank = await makeUser("Frank Member");
  const sibling = await makeUser("Sid Sibling");
  const outsider = await makeUser("Otto Outsider");

  const ownTeam = await makeGroup("Own Team", owner.id);
  await addMember(ownTeam, owner.id, { viewAccess: true, adminAccess: true });
  await addMember(ownTeam, sibling.id);

  const support = await makeGroup("Support", manager.id, { organizationOwnerId: owner.id });
  await addMember(support, erin.id);
  await addMember(support, frank.id);
  await addQuota(support, erin.id, FUTURE_YEAR, { vacationDays: 22 });
  await addQuota(support, frank.id, FUTURE_YEAR, { vacationDays: 18 });
  const approvedId = await addLeave(support, erin.id, dayIn(FUTURE_YEAR, MONTH, 10));
  const pendingId = await addLeave(support, frank.id, dayIn(FUTURE_YEAR, MONTH, 14), {
    approved: false,
  });

  const organizationId = (await ensureOrganizationForUser(owner.id)).id;
  await grantOrganizationAdmin({ organizationId, userId: delegate.id, grantedByUserId: owner.id });

  const otherTeam = await makeGroup("Other Org Team", outsider.id);
  await addMember(otherTeam, outsider.id, { viewAccess: true, adminAccess: true });

  return {
    owner,
    manager,
    delegate,
    erin,
    frank,
    sibling,
    outsider,
    support,
    approvedId,
    pendingId,
  };
};

type Seeded = Awaited<ReturnType<typeof seed>>;
type Row = { id: string; userId: string; groupId: string; canApprove: boolean };

describe("Admins read and approve the groups they administer without belonging to them", () => {
  let server: LoopbackServer;

  beforeAll(async () => {
    server = await listenOnLoopback(createServer());
  });

  beforeEach(async () => {
    await resetReportData();
  });

  afterAll(async () => {
    await server?.close();
    await resetReportData();
  });

  const get = async (userId: string, path: string, query: Record<string, unknown> = {}) =>
    request(server.url)
      .get(path)
      .query(query)
      .set("Cookie", await authCookieFor(userId));

  const saveDashboardGroup = async (userId: string, groupId: string) =>
    request(server.url)
      .put("/api/users/me/settings")
      .set("Cookie", await authCookieFor(userId))
      .send({ dashboardScope: "GROUP", dashboardGroupId: groupId });

  const listQuery = (groupId: string) => ({
    year: FUTURE_YEAR,
    month: MONTH,
    groupId,
    includeCancelled: true,
  });
  const monthQuery = (groupId: string) => ({ year: FUTURE_YEAR, month: MONTH, groupId });

  const orgAdmins: [string, (s: Seeded) => { id: string }][] = [
    ["the org owner", (s) => s.owner],
    ["a delegated org admin", (s) => s.delegate],
  ];
  const admins: [string, (s: Seeded) => { id: string }][] = [
    ...orgAdmins,
    ["the group's manager without a membership row", (s) => s.manager],
  ];

  describe.each(admins)("%s", (_label, pick) => {
    it("lists the group's requests on /requests (GET /api/vacation?groupId=)", async () => {
      const s = await seed();
      const res = await get(pick(s).id, "/api/vacation", listQuery(s.support));

      expect(res.status).toBe(200);
      expect((res.body as Row[]).map((row) => row.id).sort()).toEqual(
        [s.approvedId, s.pendingId].sort()
      );
    });

    it("reads the group's dashboard calendar (GET /api/vacation/calendar)", async () => {
      const s = await seed();
      const res = await get(pick(s).id, "/api/vacation/calendar", monthQuery(s.support));

      expect(res.status).toBe(200);
      expect((res.body as Row[]).map((row) => row.id).sort()).toEqual(
        [s.approvedId, s.pendingId].sort()
      );
    });

    it("reads the dashboard's Out today list (GET /api/vacation without includeCancelled)", async () => {
      const s = await seed();
      const res = await get(pick(s).id, "/api/vacation", monthQuery(s.support));

      expect(res.status).toBe(200);
    });

    it("reads the group's birthdays on the dashboard (GET /api/birthdays?groupId=)", async () => {
      const s = await seed();
      const res = await get(pick(s).id, "/api/birthdays", monthQuery(s.support));

      expect(res.status).toBe(200);
    });

    it("reads the group's events on the dashboard (GET /api/group-events?groupId=)", async () => {
      const s = await seed();
      const res = await get(pick(s).id, "/api/group-events", monthQuery(s.support));

      expect(res.status).toBe(200);
    });

    it("reads the group detail the dashboard takes the holiday country from", async () => {
      const s = await seed();
      const res = await get(pick(s).id, `/api/group/${s.support}`);

      expect(res.status).toBe(200);
    });

    it("opens a request's detail dialog (GET /api/vacation/:id)", async () => {
      const s = await seed();
      const res = await get(pick(s).id, `/api/vacation/${s.pendingId}`);

      expect(res.status).toBe(200);
    });

    it("saves the group as the dashboard default (PUT /api/users/me/settings)", async () => {
      const s = await seed();
      expect((await saveDashboardGroup(pick(s).id, s.support)).status).toBe(200);
    });
  });

  describe("birthdays", () => {
    it("shows the org owner their own birthday but not the members' shared ones", async () => {
      const s = await seed();
      const viewer = await makeUser("Vera Viewer");
      await addMember(s.support, viewer.id, { viewAccess: true });
      await upsertSubscription((await ensureOrganizationForUser(s.owner.id)).id, {
        plan: subscriptionPlan.Pro,
        status: subscriptionStatus.Active,
        graceEndsAt: null,
      });
      await saveBirthday(s.erin.id, { month: MONTH, day: 5, year: null, shared: true });
      await saveBirthday(s.owner.id, { month: MONTH, day: 9, year: null, shared: false });

      const forViewer = await get(viewer.id, "/api/birthdays", monthQuery(s.support));
      expect((forViewer.body as { userId: string }[]).map((row) => row.userId)).toEqual([
        s.erin.id,
      ]);

      const forOwner = await get(s.owner.id, "/api/birthdays", monthQuery(s.support));
      expect(forOwner.status).toBe(200);
      expect((forOwner.body as { userId: string }[]).map((row) => row.userId)).toEqual([
        s.owner.id,
      ]);
    });
  });

  describe("approval", () => {
    it("lets the manager without a membership row approve a pending request from the list", async () => {
      const s = await seed();
      const list = await get(s.manager.id, "/api/vacation", listQuery(s.support));

      expect(list.status).toBe(200);
      const pending = (list.body as Row[]).find((row) => row.id === s.pendingId);
      expect(pending?.canApprove).toBe(true);

      await request(server.url)
        .post("/api/vacation/approve")
        .set("Cookie", await authCookieFor(s.manager.id))
        .send({ ids: [s.pendingId] })
        .expect(200);
    });

    // docs/invariants.md "Administration, never approval": an org admin reads the
    // group but decides nothing in it unless they are one of its approvers.
    it.each(orgAdmins)(
      "shows %s the pending request without the right to decide it",
      async (_label, pick) => {
        const s = await seed();
        const list = await get(pick(s).id, "/api/vacation", listQuery(s.support));

        expect(list.status).toBe(200);
        const pending = (list.body as Row[]).find((row) => row.id === s.pendingId);
        expect(pending?.canApprove).toBe(false);

        await request(server.url)
          .post("/api/vacation/approve")
          .set("Cookie", await authCookieFor(pick(s).id))
          .send({ ids: [s.pendingId] })
          .expect(403);
      }
    );
  });

  const outsiders: [string, (s: Seeded) => { id: string }][] = [
    ["a plain member without view access", (s) => s.erin],
    ["a member of another group in the same organization", (s) => s.sibling],
    ["a user from another organization", (s) => s.outsider],
  ];

  describe.each(outsiders)("%s", (_label, pick) => {
    it("still gets 403 listing the group", async () => {
      const s = await seed();
      expect((await get(pick(s).id, "/api/vacation", listQuery(s.support))).status).toBe(403);
    });

    it("still gets 403 on the group's calendar", async () => {
      const s = await seed();
      expect((await get(pick(s).id, "/api/vacation/calendar", monthQuery(s.support))).status).toBe(
        403
      );
    });

    it("still gets 403 on the group's birthdays", async () => {
      const s = await seed();
      expect((await get(pick(s).id, "/api/birthdays", monthQuery(s.support))).status).toBe(403);
    });

    it("still cannot save the group as the dashboard default", async () => {
      const s = await seed();
      expect((await saveDashboardGroup(pick(s).id, s.support)).status).toBe(403);
    });

    it("still cannot approve in the group", async () => {
      const s = await seed();
      await request(server.url)
        .post("/api/vacation/approve")
        .set("Cookie", await authCookieFor(pick(s).id))
        .send({ ids: [s.pendingId] })
        .expect(403);
    });
  });
});
