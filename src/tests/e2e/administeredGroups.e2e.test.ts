import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { v4 as uuidv4 } from "uuid";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { db } from "../../db/db.js";
import { groups } from "../../db/schema/group-schema.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
import { createTestUser, cleanupTestData } from "./helpers/testSetup.js";
import { authCookieFor } from "./helpers/authHelper.js";
import {
  ensureOrganizationForUser,
  grantOrganizationAdmin,
} from "../../services/organization/organizationServices.js";

type Caller = "ownerA" | "ownerB" | "delegate" | "manager" | "member";

type Item = {
  id: string;
  groupName: string;
  organizationId: string;
  organization: { id: string } | null;
  memberCount: number;
  uploadsAvailable: boolean;
  membership: { adminAccess: boolean; approverAccess: boolean };
  viaOrgAdmin: boolean;
};

describe("GET /api/group/administered", () => {
  let server: LoopbackServer;
  const ids = {} as Record<Caller, string>;
  const cookies = {} as Record<Caller, string>;

  let orgA: string;
  let orgB: string;
  let alphaOps: string;
  let charlieOps: string;
  let ownTeam: string;
  let bravoSales: string;

  const insertGroup = async (
    organizationId: string,
    groupName: string,
    managerUserId: string,
    deletedAt: Date | null = null
  ) => {
    const id = uuidv4();
    await db.insert(groups).values({ id, organizationId, groupName, managerUserId, deletedAt });
    return id;
  };

  const addMember = (userId: string, groupId: string, adminAccess = false) =>
    db.insert(groupUsers).values({
      id: uuidv4(),
      userId,
      groupId,
      viewAccess: true,
      adminAccess,
      approverAccess: adminAccess,
      controlledUser: true,
    });

  const administered = async (caller: Caller): Promise<Item[]> => {
    const res = await request(server.url)
      .get("/api/group/administered")
      .set("Cookie", cookies[caller])
      .expect(200);
    return res.body as Item[];
  };

  beforeAll(async () => {
    await cleanupTestData();
    server = await listenOnLoopback(createServer());

    const names: Record<Caller, string> = {
      ownerA: "Ann Owner",
      ownerB: "Ben Owner",
      delegate: "Dee Delegate",
      manager: "Max Manager",
      member: "Mia Member",
    };
    for (const caller of Object.keys(names) as Caller[]) {
      const email = `administered-${caller.toLowerCase()}@test.com`;
      ids[caller] = (await createTestUser(email, names[caller], "password123")).id;
    }

    orgA = (await ensureOrganizationForUser(ids.ownerA)).id;
    orgB = (await ensureOrganizationForUser(ids.ownerB)).id;

    // Org A: one group the owner belongs to, two run by a manager who is not a
    // member of either, and a deleted one.
    ownTeam = await insertGroup(orgA, "Own Team", ids.ownerA);
    await addMember(ids.ownerA, ownTeam, true);

    alphaOps = await insertGroup(orgA, "Alpha Ops", ids.manager);
    await addMember(ids.member, alphaOps);
    charlieOps = await insertGroup(orgA, "Charlie Ops", ids.manager);
    await insertGroup(orgA, "Archived Ops", ids.manager, new Date());

    // Org B, where owner A is a delegated admin.
    bravoSales = await insertGroup(orgB, "Bravo Sales", ids.ownerB);
    await addMember(ids.ownerB, bravoSales, true);
    await addMember(ids.member, bravoSales);
    await insertGroup(orgB, "Aardvark Sales", ids.ownerB, new Date());

    await grantOrganizationAdmin({
      organizationId: orgA,
      userId: ids.delegate,
      grantedByUserId: ids.ownerA,
    });
    await grantOrganizationAdmin({
      organizationId: orgB,
      userId: ids.ownerA,
      grantedByUserId: ids.ownerB,
    });

    for (const caller of Object.keys(names) as Caller[]) {
      cookies[caller] = await authCookieFor(ids[caller]);
    }
  });

  afterAll(async () => {
    await server?.close();
    await cleanupTestData();
  });

  it("lists every group of the organization to a delegate who belongs to none", async () => {
    const result = await administered("delegate");

    expect(result.map((item) => item.groupName)).toEqual(["Alpha Ops", "Charlie Ops", "Own Team"]);
    expect(result.every((item) => item.viaOrgAdmin)).toBe(true);
  });

  it("shapes each item like a GET /api/group item with no membership rights", async () => {
    const [alpha] = await administered("delegate");

    expect(alpha).toMatchObject({
      id: alphaOps,
      organizationId: orgA,
      managerUserId: ids.manager,
      organization: { id: orgA, plan: "FREE" },
      memberCount: 1,
      uploadsAvailable: false,
      membership: { adminAccess: false, approverAccess: false },
      viaOrgAdmin: true,
    });
  });

  it("merges an owner's own organization with one they are a delegate in, by name", async () => {
    const result = await administered("ownerA");

    expect(result.map((item) => item.id)).toEqual([alphaOps, bravoSales, charlieOps]);
    expect(result.map((item) => item.organizationId)).toEqual([orgA, orgB, orgA]);
  });

  it("never lists a group the viewer is a member of", async () => {
    const ownerA = await administered("ownerA");
    expect(ownerA.map((item) => item.id)).not.toContain(ownTeam);

    // Owner B administers Bravo Sales as owner, manager and admin member.
    expect(await administered("ownerB")).toEqual([]);
  });

  it("answers an empty list to a plain member", async () => {
    expect(await administered("member")).toEqual([]);
  });

  it("leaves deleted groups out", async () => {
    const names = [
      ...(await administered("ownerA")),
      ...(await administered("delegate")),
      ...(await administered("manager")),
    ].map((item) => item.groupName);

    expect(names).not.toContain("Archived Ops");
    expect(names).not.toContain("Aardvark Sales");
  });

  it("marks a group the viewer manages without belonging to as not via the organization", async () => {
    const result = await administered("manager");

    expect(result.map((item) => [item.groupName, item.viaOrgAdmin])).toEqual([
      ["Alpha Ops", false],
      ["Charlie Ops", false],
    ]);
  });

  it("leaves GET /api/group membership-only", async () => {
    const delegate = await request(server.url)
      .get("/api/group")
      .set("Cookie", cookies.delegate)
      .expect(200);
    expect(delegate.body).toEqual([]);

    const ownerA = await request(server.url)
      .get("/api/group")
      .set("Cookie", cookies.ownerA)
      .expect(200);
    expect(ownerA.body.map((item: Item) => item.id)).toEqual([ownTeam]);
    expect(ownerA.body[0]).not.toHaveProperty("viaOrgAdmin");
  });

  it("still serves GET /api/group/:groupId for an administered group", async () => {
    const res = await request(server.url)
      .get(`/api/group/${charlieOps}`)
      .set("Cookie", cookies.delegate)
      .expect(200);

    expect(res.body.access).toEqual({
      canView: true,
      canAdmin: true,
      viaOrgAdmin: true,
      isMember: false,
    });
  });

  it("refuses an unauthenticated caller", async () => {
    await request(server.url).get("/api/group/administered").expect(401);
  });
});
