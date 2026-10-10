import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { v4 as uuidv4 } from "uuid";
import { eq } from "drizzle-orm";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { db } from "../../db/db.js";
import { vacation } from "../../db/schema/vacation-schema.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
import {
  cleanupTestData,
  createTestGroup,
  createTestUser,
  createTestVacation,
} from "./helpers/testSetup.js";
import { authCookieFor } from "./helpers/authHelper.js";

type Caller = "manager" | "viewer" | "member" | "outsider";

describe("GET /api/vacation/calendar", () => {
  let server: LoopbackServer;
  let groupId: string;
  const ids = {} as Record<Caller, string>;
  const cookies = {} as Record<Caller, string>;

  const calendarDays = async (
    query: Record<string, string | number>,
    caller: Caller = "member"
  ) => {
    const res = await request(server.url)
      .get("/api/vacation/calendar")
      .set("Cookie", cookies[caller])
      .query(query)
      .expect(200);
    return (res.body as { requestedDay: string }[]).map((row) => row.requestedDay);
  };

  const fromBothRoutes = async (
    caller: Caller,
    query: Record<string, string | number>,
    status: number
  ) => {
    const [monthList, calendar] = await Promise.all(
      ["/api/vacation", "/api/vacation/calendar"].map((path) =>
        request(server.url)
          .get(path)
          .set("Cookie", cookies[caller])
          .query({ year: 2026, month: 10, ...query })
          .expect(status)
      )
    );
    return { monthList: monthList!.body, calendar: calendar!.body };
  };

  const book = (caller: Caller, ...requestedDays: string[]) =>
    Promise.all(requestedDays.map((day) => createTestVacation(ids[caller], groupId, day)));

  beforeAll(async () => {
    await cleanupTestData();
    server = await listenOnLoopback(createServer());

    for (const caller of ["manager", "viewer", "member", "outsider"] as const) {
      ids[caller] = (await createTestUser(`calendar-${caller}@test.com`, caller, "password123")).id;
    }

    groupId = (await createTestGroup("Calendar", ids.manager)).id;

    const membership = (userId: string, viewAccess: boolean) => ({
      id: uuidv4(),
      userId,
      groupId,
      controlledUser: true,
      viewAccess,
      adminAccess: false,
      approverAccess: false,
    });
    await db
      .insert(groupUsers)
      .values([
        membership(ids.manager, false),
        membership(ids.viewer, true),
        membership(ids.member, false),
      ]);

    for (const caller of Object.keys(ids) as Caller[]) {
      cookies[caller] = await authCookieFor(ids[caller]);
    }
  });

  afterAll(async () => {
    await server?.close();
    await cleanupTestData();
  });

  beforeEach(async () => {
    await db.delete(vacation);
  });

  it("returns the month plus 6 days either side", async () => {
    await book("member", "2026-09-24", "2026-09-25", "2026-10-15", "2026-11-06", "2026-11-07");

    expect(await calendarDays({ year: 2026, month: 10 })).toEqual([
      "2026-09-25",
      "2026-10-15",
      "2026-11-06",
    ]);
  });

  it("reaches 6 January of the next year from December", async () => {
    await book("member", "2026-11-24", "2026-11-25", "2027-01-06", "2027-01-07");

    expect(await calendarDays({ year: 2026, month: 12 })).toEqual(["2026-11-25", "2027-01-06"]);
  });

  it("reaches 26 December of the previous year from January", async () => {
    await book("member", "2026-12-25", "2026-12-26", "2027-02-06", "2027-02-07");

    expect(await calendarDays({ year: 2027, month: 1 })).toEqual(["2026-12-26", "2027-02-06"]);
  });

  it("leaves out cancelled rows", async () => {
    const [cancelled] = await book("member", "2026-10-14", "2026-10-15");
    await db
      .update(vacation)
      .set({ deletedAt: new Date(), deletedByUserId: ids.member })
      .where(eq(vacation.id, cancelled!));

    expect(await calendarDays({ year: 2026, month: 10 })).toEqual(["2026-10-15"]);
  });

  it("returns only the caller's own rows without a group id", async () => {
    await book("member", "2026-10-14");
    await book("viewer", "2026-10-15");

    expect(await calendarDays({ year: 2026, month: 10 }, "viewer")).toEqual(["2026-10-15"]);
  });

  it("returns the whole group's padded window to a caller who may view it", async () => {
    await book("member", "2026-09-24", "2026-09-25", "2026-10-14");
    await book("viewer", "2026-11-06", "2026-11-07");

    for (const caller of ["viewer", "manager"] as const) {
      expect(await calendarDays({ year: 2026, month: 10, groupId }, caller)).toEqual([
        "2026-09-25",
        "2026-10-14",
        "2026-11-06",
      ]);
    }
  });

  it("returns the same row shape as GET /api/vacation", async () => {
    await book("member", "2026-10-14");

    for (const [caller, query] of [
      ["member", {}],
      ["manager", { groupId }],
    ] as const) {
      const { monthList, calendar } = await fromBothRoutes(caller, query, 200);
      expect(calendar).toHaveLength(1);
      expect(calendar).toEqual(monthList);
    }
  });

  it.each(["member", "outsider"] as const)(
    "refuses the group to a %s who may not view it",
    async (caller) => {
      const { monthList, calendar } = await fromBothRoutes(caller, { groupId }, 403);

      expect(calendar).toEqual({
        errors: [{ message: "No access to view this group's records" }],
      });
      expect(calendar).toEqual(monthList);
    }
  );

  it.each([{ month: 10 }, { year: 2026 }, { year: 2026, month: 13 }, { year: 2022, month: 1 }])(
    "rejects the query %o",
    async (query) => {
      await request(server.url)
        .get("/api/vacation/calendar")
        .set("Cookie", cookies.member)
        .query(query)
        .expect(422);
    }
  );

  it("requires a session", async () => {
    await request(server.url)
      .get("/api/vacation/calendar")
      .query({ year: 2026, month: 10 })
      .expect(401);
  });
});
