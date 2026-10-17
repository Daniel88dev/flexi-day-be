import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { db } from "../../db/db.js";
import { groups } from "../../db/schema/group-schema.js";
import { userBirthdays } from "../../db/schema/user-birthday-schema.js";
import {
  manualPlanOverride,
  subscriptionPlan,
  subscriptionStatus,
} from "../../db/schema/subscription-schema.js";
import { cleanupTestData } from "./helpers/testSetup.js";
import { authCookieFor } from "./helpers/authHelper.js";
import { addMember, makeGroup, makeUser, removeMember } from "./helpers/reportFixtures.js";
import { ensureOrganizationForUser } from "../../services/organization/organizationServices.js";
import { upsertSubscription } from "../../services/billing/subscriptionServices.js";
import { visibleBirthdays } from "../../services/birthday/birthdayVisibility.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const organizationOf = async (managerId: string) => (await ensureOrganizationForUser(managerId)).id;

const makePaid = async (managerId: string) =>
  upsertSubscription(await organizationOf(managerId), {
    plan: subscriptionPlan.Pro,
    status: subscriptionStatus.Active,
    graceEndsAt: null,
  });

const makeLapsed = async (managerId: string) =>
  upsertSubscription(await organizationOf(managerId), {
    plan: subscriptionPlan.Pro,
    status: subscriptionStatus.Canceled,
    graceEndsAt: new Date(Date.now() - DAY_MS),
  });

/** A group in its own organization, managed by a fresh user. */
const groupInOwnOrganization = async (name: string) => {
  const manager = await makeUser(`${name} manager`);
  const groupId = await makeGroup(name, manager.id);
  return { groupId, managerId: manager.id };
};

describe("my birthday", () => {
  let server: LoopbackServer;
  let me: { id: string };
  let cookie: string;

  const read = () => request(server.url).get("/api/users/me/birthday").set("Cookie", cookie);
  const save = (body: Record<string, unknown>) =>
    request(server.url).put("/api/users/me/birthday").set("Cookie", cookie).send(body);
  const remove = () => request(server.url).delete("/api/users/me/birthday").set("Cookie", cookie);

  beforeAll(async () => {
    await cleanupTestData();
    server = await listenOnLoopback(createServer());
  });

  afterAll(async () => {
    await server?.close();
    await cleanupTestData();
  });

  beforeEach(async () => {
    me = await makeUser("Birthday Owner");
    cookie = await authCookieFor(me.id);
  });

  it("needs a session", async () => {
    expect((await request(server.url).get("/api/users/me/birthday")).status).toBe(401);
  });

  it("saves, reads and removes a birthday, and brings it back", async () => {
    expect((await read()).body).toEqual({ birthday: null, canShare: false, shareGroups: [] });

    const saved = await save({ month: 5, day: 14, year: 1990, shared: false });
    expect(saved.status).toBe(200);
    expect(saved.body.birthday).toEqual({ month: 5, day: 14, year: 1990, shared: false });

    expect((await read()).body.birthday).toEqual({ month: 5, day: 14, year: 1990, shared: false });

    expect((await remove()).status).toBe(204);
    expect((await read()).body.birthday).toBeNull();
    const [tombstone] = await db
      .select()
      .from(userBirthdays)
      .where(eq(userBirthdays.userId, me.id));
    expect(tombstone).toMatchObject({ month: null, day: null, year: null, shared: false });
    expect(tombstone?.deletedAt).toBeInstanceOf(Date);

    expect((await remove()).status).toBe(204);

    const back = await save({ month: 12, day: 1, shared: false });
    expect(back.body.birthday).toEqual({ month: 12, day: 1, year: null, shared: false });
  });

  it("lists paid and lapsed groups as share groups, never one that never paid", async () => {
    const paid = await groupInOwnOrganization("Paid Team");
    const grace = await groupInOwnOrganization("Grace Team");
    const lapsed = await groupInOwnOrganization("Lapsed Team");
    const freeOverride = await groupInOwnOrganization("Override Team");
    const neverPaid = await groupInOwnOrganization("Never Paid Team");
    const checkout = await groupInOwnOrganization("Checkout Team");
    for (const group of [paid, grace, lapsed, freeOverride, neverPaid, checkout]) {
      await addMember(group.groupId, me.id);
    }
    await makePaid(paid.managerId);
    await upsertSubscription(await organizationOf(grace.managerId), {
      plan: subscriptionPlan.Pro,
      status: subscriptionStatus.PastDue,
      graceEndsAt: new Date(Date.now() + DAY_MS),
    });
    await makeLapsed(lapsed.managerId);
    await upsertSubscription(await organizationOf(freeOverride.managerId), {
      manualPlanOverride: manualPlanOverride.Free,
    });
    await upsertSubscription(await organizationOf(checkout.managerId), {});

    const res = await read();

    expect(res.status).toBe(200);
    expect(res.body.canShare).toBe(true);
    expect(res.body.shareGroups).toEqual([
      { groupId: grace.groupId, groupName: "Grace Team" },
      { groupId: lapsed.groupId, groupName: "Lapsed Team" },
      { groupId: freeOverride.groupId, groupName: "Override Team" },
      { groupId: paid.groupId, groupName: "Paid Team" },
    ]);
  });

  it("leaves out a group the user has left and a deleted group", async () => {
    const left = await groupInOwnOrganization("Left Team");
    const deleted = await groupInOwnOrganization("Deleted Team");
    await addMember(left.groupId, me.id);
    await addMember(deleted.groupId, me.id);
    await makePaid(left.managerId);
    await makePaid(deleted.managerId);
    await removeMember(left.groupId, me.id);
    await db.update(groups).set({ deletedAt: new Date() }).where(eq(groups.id, deleted.groupId));

    expect((await read()).body).toEqual({ birthday: null, canShare: false, shareGroups: [] });
  });

  it("saves with no paid group, refuses to share, and keeps a switch on through a lapse", async () => {
    const team = await groupInOwnOrganization("Free Team");
    await addMember(team.groupId, me.id);

    expect((await save({ month: 3, day: 8, year: null, shared: false })).status).toBe(200);

    const refused = await save({ month: 3, day: 8, year: null, shared: true });
    expect(refused.status).toBe(402);
    expect(refused.body.errors[0].context).toEqual({
      reason: "PLAN_LIMIT",
      code: "BIRTHDAY_SHARE_PLAN_REQUIRED",
    });
    expect((await read()).body.birthday.shared).toBe(false);

    await makePaid(team.managerId);
    expect((await save({ month: 3, day: 8, year: null, shared: true })).status).toBe(200);

    await makeLapsed(team.managerId);
    const afterLapse = await read();
    expect(afterLapse.body).toEqual({
      birthday: { month: 3, day: 8, year: null, shared: true },
      canShare: false,
      shareGroups: [{ groupId: team.groupId, groupName: "Free Team" }],
    });

    const edited = await save({ month: 3, day: 9, year: 1985, shared: true });
    expect(edited.status).toBe(200);
    expect(edited.body.birthday).toEqual({ month: 3, day: 9, year: 1985, shared: true });

    const off = await save({ month: 3, day: 9, year: 1985, shared: false });
    expect(off.status).toBe(200);
    expect(off.body.birthday.shared).toBe(false);

    expect((await save({ month: 3, day: 9, year: 1985, shared: true })).status).toBe(402);
  });

  it("asks the plan again when a removed birthday comes back shared", async () => {
    const team = await groupInOwnOrganization("Removed Team");
    await addMember(team.groupId, me.id);
    await makePaid(team.managerId);
    expect((await save({ month: 6, day: 1, shared: true })).status).toBe(200);
    await remove();
    await makeLapsed(team.managerId);

    expect((await save({ month: 6, day: 1, shared: true })).status).toBe(402);
  });

  it("accepts 29 February and refuses 31 April and a future year", async () => {
    const leap = await save({ month: 2, day: 29, year: 1992, shared: false });
    expect(leap.status).toBe(200);
    expect(leap.body.birthday).toEqual({ month: 2, day: 29, year: 1992, shared: false });

    expect((await save({ month: 4, day: 31, year: null, shared: false })).status).toBe(422);
    const nextYear = new Date().getUTCFullYear() + 1;
    expect((await save({ month: 1, day: 1, year: nextYear, shared: false })).status).toBe(422);
    expect((await save({ month: 1, day: 1, year: 1899, shared: false })).status).toBe(422);

    expect((await read()).body.birthday).toEqual({ month: 2, day: 29, year: 1992, shared: false });
  });
});

describe("visibleBirthdays against the database", () => {
  beforeAll(async () => {
    await cleanupTestData();
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  const share = (userId: string, shared = true) =>
    db.insert(userBirthdays).values({ userId, month: 7, day: 2, year: 1991, shared });

  it("reads live members of viewable paid or lapsed groups, each once", async () => {
    const viewer = await makeUser("Viewer");
    const paid = await groupInOwnOrganization("Visible Paid");
    const lapsed = await groupInOwnOrganization("Visible Lapsed");
    const neverPaid = await groupInOwnOrganization("Visible Never Paid");
    const selfOnly = await groupInOwnOrganization("Visible Self Only");
    await makePaid(paid.managerId);
    await makeLapsed(lapsed.managerId);
    await makePaid(selfOnly.managerId);

    await addMember(paid.groupId, viewer.id, { viewAccess: true });
    await addMember(lapsed.groupId, viewer.id, { viewAccess: true });
    await addMember(neverPaid.groupId, viewer.id, { viewAccess: true });
    await addMember(selfOnly.groupId, viewer.id, { viewAccess: false });

    const inBoth = await makeUser("In Both");
    const inLapsed = await makeUser("In Lapsed");
    const inNeverPaid = await makeUser("In Never Paid");
    const inSelfOnly = await makeUser("In Self Only");
    const leaver = await makeUser("Leaver");
    const unshared = await makeUser("Unshared");
    const removed = await makeUser("Removed");

    await addMember(paid.groupId, inBoth.id);
    await addMember(lapsed.groupId, inBoth.id);
    await addMember(lapsed.groupId, inLapsed.id);
    await addMember(neverPaid.groupId, inNeverPaid.id);
    await addMember(selfOnly.groupId, inSelfOnly.id);
    await addMember(paid.groupId, leaver.id);
    await removeMember(paid.groupId, leaver.id);
    await addMember(paid.groupId, unshared.id);
    await addMember(paid.groupId, removed.id);

    await share(viewer.id, false);
    for (const user of [inBoth, inLapsed, inNeverPaid, inSelfOnly, leaver]) await share(user.id);
    await share(unshared.id, false);
    await db.insert(userBirthdays).values({
      userId: removed.id,
      shared: false,
      deletedAt: new Date(),
    });

    const all = await visibleBirthdays(viewer.id);
    expect(all.map((row) => row.userId).sort()).toEqual([viewer.id, inBoth.id, inLapsed.id].sort());
    expect(all[0]).toMatchObject({ userId: viewer.id, month: 7, day: 2, year: 1991 });

    const narrowed = await visibleBirthdays(viewer.id, paid.groupId);
    expect(narrowed.map((row) => row.userId).sort()).toEqual([viewer.id, inBoth.id].sort());
  });
});
