import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { authCookieFor } from "./helpers/authHelper.js";
import {
  addLeave,
  addMember,
  addQuota,
  makeGroup,
  makeUser,
  resetReportData,
} from "./helpers/reportFixtures.js";

const nextYear = new Date().getUTCFullYear() + 1;

const firstWednesdayOfMarch = (year: number): string => {
  const day = new Date(Date.UTC(year, 2, 1));
  while (day.getUTCDay() !== 3) day.setUTCDate(day.getUTCDate() + 1);
  return day.toISOString().slice(0, 10);
};

const WED = firstWednesdayOfMarch(nextYear);
const THU = new Date(Date.parse(`${WED}T00:00:00Z`) + 24 * 60 * 60 * 1000)
  .toISOString()
  .slice(0, 10);
const RANGE = { from: `${nextYear.toString()}-03-01`, to: `${nextYear.toString()}-04-01` };

/**
 * Bob is a member with view access and an approved Thursday. Carol sees the
 * group as a teammate. Dave belongs without view access. Olga belongs to no
 * group at all.
 */
const seed = async () => {
  const mia = await makeUser("Mia Manager");
  const bob = await makeUser("Bob Member");
  const carol = await makeUser("Carol Viewer");
  const dave = await makeUser("Dave Member");
  const olga = await makeUser("Olga Outsider");

  const team = await makeGroup("Team", mia.id);
  await addMember(team, bob.id, { viewAccess: true });
  await addMember(team, carol.id, { viewAccess: true });
  await addMember(team, dave.id);
  await addQuota(team, bob.id, nextYear, { vacationDays: 20 });

  const bobThursday = await addLeave(team, bob.id, THU);
  const daveThursday = await addLeave(team, dave.id, THU, { approved: false });

  return { bob, carol, dave, olga, team, bobThursday, daveThursday };
};

type Seeded = Awaited<ReturnType<typeof seed>>;
type Row = { id: string; userId: string; requestedDay: string; approvedAt: string | null };
type Bucket = { type: string; allocated: number; used: number; pending: number };

describe("the request operations the tool layer calls, through their REST routes", () => {
  let server: LoopbackServer;
  let s: Seeded;

  beforeAll(async () => {
    server = await listenOnLoopback(createServer());
  });

  beforeEach(async () => {
    await resetReportData();
    s = await seed();
  });

  afterAll(async () => {
    await server?.close();
    await resetReportData();
  });

  const as = async (userId: string) => ({ Cookie: await authCookieFor(userId) });

  describe("create a request", () => {
    const create = async (userId: string) =>
      request(server.url)
        .post("/api/vacation/create-vacation")
        .set(await as(userId))
        .send({ groupId: s.team, from: WED, to: WED });

    it("books the caller's own day", async () => {
      const res = await create(s.bob.id);

      expect(res.status).toBe(201);
      expect((res.body as Row[]).map((row) => [row.userId, row.requestedDay])).toEqual([
        [s.bob.id, WED],
      ]);
    });

    it("refuses a caller outside the group", async () => {
      const res = await create(s.olga.id);

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ errors: [{ message: "No access for related group" }] });
    });
  });

  describe("cancel your own request", () => {
    const cancel = async (userId: string, vacationId: string) =>
      request(server.url)
        .delete(`/api/vacation/${vacationId}`)
        .set(await as(userId))
        .send({});

    it("cancels the caller's own request", async () => {
      const res = await cancel(s.dave.id, s.daveThursday);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ message: "Vacation cancelled" });
    });

    it("refuses a teammate cancelling someone else's request", async () => {
      const res = await cancel(s.carol.id, s.daveThursday);

      expect(res.status).toBe(403);
      expect(res.body).toEqual({
        errors: [{ message: "You are not allowed to cancel this vacation" }],
      });
    });
  });

  describe("read your balance", () => {
    const balances = async (userId: string) =>
      request(server.url)
        .get("/api/users/me/balances")
        .query({ year: nextYear })
        .set(await as(userId));

    const vacationBucket = (body: { buckets: Bucket[] }) =>
      body.buckets.find((bucket) => bucket.type === "VACATION");

    it("sums the caller's allowance and usage in their groups", async () => {
      const res = await balances(s.bob.id);

      expect(res.status).toBe(200);
      expect(vacationBucket(res.body as { buckets: Bucket[] })).toEqual({
        type: "VACATION",
        allocated: 20,
        used: 1,
        pending: 0,
      });
    });

    it("gives a caller outside every group nothing of the group's", async () => {
      const res = await balances(s.olga.id);

      expect(res.status).toBe(200);
      expect(vacationBucket(res.body as { buckets: Bucket[] })).toEqual({
        type: "VACATION",
        allocated: 0,
        used: 0,
        pending: 0,
      });
    });

    it("refuses a caller without a session", async () => {
      const res = await request(server.url).get("/api/users/me/balances");

      expect(res.status).toBe(401);
    });
  });

  describe("read who is away in a date range", () => {
    const away = async (userId: string) =>
      request(server.url)
        .get("/api/vacation")
        .query({ ...RANGE, groupId: s.team })
        .set(await as(userId));

    it("lists the group's days to a caller who may view it", async () => {
      const res = await away(s.carol.id);

      expect(res.status).toBe(200);
      expect((res.body as Row[]).map((row) => row.id).sort()).toEqual(
        [s.bobThursday, s.daveThursday].sort()
      );
    });

    it("refuses a member who cannot see the whole group", async () => {
      const res = await away(s.dave.id);

      expect(res.status).toBe(403);
      expect(res.body).toEqual({
        errors: [{ message: "No access to view this group's records" }],
      });
    });
  });

  describe("read your own requests and their status", () => {
    const mine = async (userId: string) =>
      request(server.url)
        .get("/api/vacation")
        .query(RANGE)
        .set(await as(userId));

    const detail = async (userId: string, vacationId: string) =>
      request(server.url)
        .get(`/api/vacation/${vacationId}`)
        .set(await as(userId));

    it("lists only the caller's own rows, with their status", async () => {
      const res = await mine(s.dave.id);

      expect(res.status).toBe(200);
      const rows = res.body as Row[];
      expect(rows.map((row) => row.id)).toEqual([s.daveThursday]);
      expect(rows[0]?.approvedAt).toBeNull();
    });

    it("refuses a caller without a session", async () => {
      const res = await request(server.url).get("/api/vacation").query(RANGE);

      expect(res.status).toBe(401);
    });

    it("opens the caller's own request", async () => {
      const res = await detail(s.dave.id, s.daveThursday);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: s.daveThursday, userId: s.dave.id, approvedAt: null });
    });

    it("refuses a member without view access opening someone else's request", async () => {
      const res = await detail(s.dave.id, s.bobThursday);

      expect(res.status).toBe(403);
      expect(res.body).toEqual({
        errors: [{ message: "You are not allowed to view this vacation" }],
      });
    });
  });
});
