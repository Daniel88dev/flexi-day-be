import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { subscriptionPlan, subscriptionStatus } from "../../db/schema/subscription-schema.js";
import { authCookieFor } from "./helpers/authHelper.js";
import { addMember, makeGroup, makeUser, resetReportData } from "./helpers/reportFixtures.js";
import { ensureOrganizationForUser } from "../../services/organization/organizationServices.js";
import { upsertSubscription } from "../../services/billing/subscriptionServices.js";
import { saveBirthday } from "../../services/birthday/birthdayServices.js";

const DAY_MS = 24 * 60 * 60 * 1000;

type BirthdayCalendarRow = {
  userId: string;
  user: { id: string; name: string; initials: string; avatarColor: string };
  date: string;
  month: number;
  day: number;
  year: number | null;
  age: number | null;
};

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

describe("GET /api/birthdays", () => {
  let server: LoopbackServer;

  const calendar = async (
    userId: string,
    query: { year: number; month: number; groupId?: string }
  ) =>
    request(server.url)
      .get("/api/birthdays")
      .query(query)
      .set("Cookie", await authCookieFor(userId));

  const rowsFor = async (
    userId: string,
    query: { year: number; month: number; groupId?: string }
  ): Promise<BirthdayCalendarRow[]> => {
    const res = await calendar(userId, query);
    expect(res.status).toBe(200);
    return res.body as BirthdayCalendarRow[];
  };

  /** A paid group with a viewer who sees it in full and a colleague who shares a birthday. */
  const seedGroup = async (options: { plan: "paid" | "lapsed" | "never" } = { plan: "paid" }) => {
    const manager = await makeUser("Manager");
    const viewer = await makeUser("Vera Viewer");
    const colleague = await makeUser("Petra Colleague");
    const groupId = await makeGroup("Engineering", manager.id);
    await addMember(groupId, viewer.id, { viewAccess: true });
    await addMember(groupId, colleague.id);
    if (options.plan === "paid") await makePaid(manager.id);
    if (options.plan === "lapsed") await makeLapsed(manager.id);
    await saveBirthday(colleague.id, { month: 2, day: 14, year: 1990, shared: true });
    return { manager, viewer, colleague, groupId };
  };

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

  it("needs a session", async () => {
    expect((await request(server.url).get("/api/birthdays?year=2027&month=2")).status).toBe(401);
  });

  it("answers 422 for a missing or out-of-range month", async () => {
    const viewer = await makeUser("Viewer");
    expect((await calendar(viewer.id, { year: 2027, month: 13 })).status).toBe(422);
    const missing = await request(server.url)
      .get("/api/birthdays?year=2027")
      .set("Cookie", await authCookieFor(viewer.id));
    expect(missing.status).toBe(422);
  });

  it("shows a colleague's shared birthday in Group scope with the age, and not in Mine scope", async () => {
    const { viewer, colleague, groupId } = await seedGroup();
    await saveBirthday(viewer.id, { month: 2, day: 20, year: null, shared: false });

    const group = await rowsFor(viewer.id, { year: 2027, month: 2, groupId });
    expect(group).toEqual([
      {
        userId: colleague.id,
        user: expect.objectContaining({ id: colleague.id, name: "Petra Colleague" }),
        date: "2027-02-14",
        month: 2,
        day: 14,
        year: 1990,
        age: 37,
      },
      {
        userId: viewer.id,
        user: expect.objectContaining({ id: viewer.id, name: "Vera Viewer" }),
        date: "2027-02-20",
        month: 2,
        day: 20,
        year: null,
        age: null,
      },
    ]);

    const mine = await rowsFor(viewer.id, { year: 2027, month: 2 });
    expect(mine.map((row) => row.userId)).toEqual([viewer.id]);
  });

  it("shows the caller's own birthday in Mine scope even when it is not shared", async () => {
    const viewer = await makeUser("Solo");
    await saveBirthday(viewer.id, { month: 2, day: 29, year: 1992, shared: false });

    expect(await rowsFor(viewer.id, { year: 2027, month: 2 })).toEqual([
      expect.objectContaining({ userId: viewer.id, date: "2027-02-28", age: 35 }),
    ]);
    expect(await rowsFor(viewer.id, { year: 2028, month: 2 })).toEqual([
      expect.objectContaining({ userId: viewer.id, date: "2028-02-29", age: 36 }),
    ]);
  });

  it("covers the six padded days on each side of the month", async () => {
    const { viewer, colleague, groupId } = await seedGroup();
    await saveBirthday(colleague.id, { month: 1, day: 3, year: null, shared: true });

    const december = await rowsFor(viewer.id, { year: 2026, month: 12, groupId });
    expect(december).toEqual([
      expect.objectContaining({ userId: colleague.id, date: "2027-01-03" }),
    ]);
    expect(await rowsFor(viewer.id, { year: 2027, month: 2, groupId })).toEqual([]);
  });

  it("drops the birthday once the colleague stops sharing it", async () => {
    const { viewer, colleague, groupId } = await seedGroup();
    expect(await rowsFor(viewer.id, { year: 2027, month: 2, groupId })).toHaveLength(1);

    const unshare = await request(server.url)
      .put("/api/users/me/birthday")
      .set("Cookie", await authCookieFor(colleague.id))
      .send({ month: 2, day: 14, year: 1990, shared: false });
    expect(unshare.status).toBe(200);

    expect(await rowsFor(viewer.id, { year: 2027, month: 2, groupId })).toEqual([]);
  });

  it("never shows a shared birthday to somebody outside the group", async () => {
    const { groupId } = await seedGroup();
    const outsider = await makeUser("Outsider");

    const res = await calendar(outsider.id, { year: 2027, month: 2, groupId });
    expect(res.status).toBe(403);
    expect(await rowsFor(outsider.id, { year: 2027, month: 2 })).toEqual([]);
  });

  it("answers 403 to a plain member, who does not see the group in full", async () => {
    const { colleague, groupId } = await seedGroup();
    const plain = await makeUser("Plain");
    await addMember(groupId, plain.id);

    expect((await calendar(plain.id, { year: 2027, month: 2, groupId })).status).toBe(403);
    expect(await rowsFor(colleague.id, { year: 2027, month: 2 })).toEqual([
      expect.objectContaining({ userId: colleague.id }),
    ]);
  });

  it("keeps showing a shared birthday in a group whose organization lapsed", async () => {
    const { viewer, colleague, groupId } = await seedGroup({ plan: "lapsed" });

    expect(await rowsFor(viewer.id, { year: 2027, month: 2, groupId })).toEqual([
      expect.objectContaining({ userId: colleague.id, age: 37 }),
    ]);
  });

  it("shows no shared birthday in a group whose organization never paid", async () => {
    const { viewer, groupId } = await seedGroup({ plan: "never" });

    expect(await rowsFor(viewer.id, { year: 2027, month: 2, groupId })).toEqual([]);
  });

  it("leaves out a removed birthday", async () => {
    const { viewer, colleague, groupId } = await seedGroup();
    const removed = await request(server.url)
      .delete("/api/users/me/birthday")
      .set("Cookie", await authCookieFor(colleague.id));
    expect(removed.status).toBe(204);

    expect(await rowsFor(viewer.id, { year: 2027, month: 2, groupId })).toEqual([]);
  });
});
