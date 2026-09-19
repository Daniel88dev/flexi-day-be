import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { v4 as uuidv4 } from "uuid";
import { and, eq } from "drizzle-orm";
import { createServer } from "../../server.js";
import { db } from "../../db/db.js";
import { bankHolidays } from "../../db/schema/bank-holiday-schema.js";
import { encodeSyncCursor } from "../../services/sync/syncCursor.js";
import { authCookieFor } from "./helpers/authHelper.js";
import {
  addMember,
  ageEverything,
  makeGroup,
  makeUser,
  resetReportData,
} from "./helpers/reportFixtures.js";

type BankHolidayRow = {
  id: string;
  date: string;
  name: string;
  country: string;
  region: string | null;
  createdAt: string;
  updatedAt: string;
};

const BANK_HOLIDAY_KEYS = ["id", "date", "name", "country", "region", "createdAt", "updatedAt"];

/** The pull reads its bank holiday window off the server clock, in UTC. */
const THIS_YEAR = new Date().getUTCFullYear();
const LAST_YEAR = THIS_YEAR - 1;
const NEXT_YEAR = THIS_YEAR + 1;

const MINUTE = 60 * 1000;
const ago = (ms: number): Date => new Date(Date.now() - ms);

const yearOf = (row: BankHolidayRow): number => Number(row.date.slice(0, 4));

const storedCountry = async (country: string) =>
  db.select().from(bankHolidays).where(eq(bankHolidays.country, country));

/** A row the dataset fill would never write, so a test can assert on the read alone. */
const insertHoliday = async (values: {
  date: string;
  country: string;
  region?: string | null;
  name?: string;
}): Promise<string> => {
  const id = uuidv4();
  await db.insert(bankHolidays).values({
    id,
    date: values.date,
    name: values.name ?? "Seeded day",
    country: values.country,
    region: values.region ?? null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
};

describe("Sync pull bank holidays E2E", () => {
  let app: Express;

  beforeAll(() => {
    app = createServer();
  });

  beforeEach(async () => {
    await resetReportData();
  });

  afterAll(async () => {
    await resetReportData();
  });

  describe("GET /api/sync/pull bank holidays", () => {
    it("returns the scoped group's country for the previous, current and next year only", async () => {
      const manager = await makeUser("Manager");
      const groupId = await makeGroup("Engineering", manager.id, { holidayCountry: "CZ" });
      await addMember(groupId, manager.id, { adminAccess: true });
      const outOfWindow = await insertHoliday({ date: `${LAST_YEAR - 1}-01-01`, country: "CZ" });

      const res = await request(app)
        .get("/api/sync/pull")
        .set("Cookie", await authCookieFor(manager.id))
        .expect(200);

      const rows = res.body.bankHolidays as BankHolidayRow[];
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((row) => row.country === "CZ")).toBe(true);
      expect([...new Set(rows.map(yearOf))].sort()).toEqual([LAST_YEAR, THIS_YEAR, NEXT_YEAR]);
      expect(rows.map((row) => row.id)).not.toContain(outOfWindow);
    });

    it("keeps 31 December of the next year and drops the day after", async () => {
      const manager = await makeUser("Manager");
      const groupId = await makeGroup("Engineering", manager.id, { holidayCountry: "CZ" });
      await addMember(groupId, manager.id, { adminAccess: true });
      const cookie = await authCookieFor(manager.id);

      // Seeded after the first pull: a stored row of a year makes the fill
      // skip it, and the fill is what the window is asserted against.
      await request(app).get("/api/sync/pull").set("Cookie", cookie).expect(200);
      const lastDay = await insertHoliday({ date: `${NEXT_YEAR}-12-31`, country: "CZ" });
      const dayAfter = await insertHoliday({ date: `${NEXT_YEAR + 1}-01-01`, country: "CZ" });
      const dayBefore = await insertHoliday({ date: `${LAST_YEAR - 1}-12-31`, country: "CZ" });

      const res = await request(app).get("/api/sync/pull").set("Cookie", cookie).expect(200);

      const ids = (res.body.bankHolidays as BankHolidayRow[]).map((row) => row.id);
      expect(ids).toContain(lastDay);
      expect(ids).not.toContain(dayAfter);
      expect(ids).not.toContain(dayBefore);
    });

    it("fills a country the server has never computed on the pull that asks for it", async () => {
      const manager = await makeUser("Manager");
      const groupId = await makeGroup("Engineering", manager.id, { holidayCountry: "SK" });
      await addMember(groupId, manager.id, { adminAccess: true });
      expect(await storedCountry("SK")).toHaveLength(0);

      const res = await request(app)
        .get("/api/sync/pull")
        .set("Cookie", await authCookieFor(manager.id))
        .expect(200);

      const rows = res.body.bankHolidays as BankHolidayRow[];
      expect(rows.map((row) => row.date)).toContain(`${THIS_YEAR}-01-01`);
      expect(await storedCountry("SK")).toHaveLength(rows.length);
    });

    it("leaves out a country that only a group the caller does not belong to holds", async () => {
      const manager = await makeUser("Manager");
      const outsider = await makeUser("Outsider");
      const mine = await makeGroup("Engineering", manager.id, { holidayCountry: "CZ" });
      await makeGroup("Sales", outsider.id, { holidayCountry: "SK" });
      await addMember(mine, manager.id, { adminAccess: true });
      const foreign = await insertHoliday({ date: `${THIS_YEAR}-01-01`, country: "SK" });

      const res = await request(app)
        .get("/api/sync/pull")
        .set("Cookie", await authCookieFor(manager.id))
        .expect(200);

      const rows = res.body.bankHolidays as BankHolidayRow[];
      expect(rows.map((row) => row.country)).not.toContain("SK");
      expect(rows.map((row) => row.id)).not.toContain(foreign);
    });

    it("carries region-less rows only, and no organizationId", async () => {
      const manager = await makeUser("Manager");
      const groupId = await makeGroup("Engineering", manager.id, { holidayCountry: "CZ" });
      await addMember(groupId, manager.id, { adminAccess: true });
      const cookie = await authCookieFor(manager.id);

      // The fill skips a country already stored, so the regional row goes in
      // after the pull that filled CZ rather than before it.
      await request(app).get("/api/sync/pull").set("Cookie", cookie).expect(200);
      const regional = await insertHoliday({
        date: `${THIS_YEAR}-03-03`,
        country: "CZ",
        region: "PR",
      });

      const res = await request(app).get("/api/sync/pull").set("Cookie", cookie).expect(200);

      const rows = res.body.bankHolidays as BankHolidayRow[];
      expect(rows.map((row) => row.id)).not.toContain(regional);
      expect(rows.every((row) => row.region === null)).toBe(true);
      expect(Object.keys(rows[0]!)).toEqual(BANK_HOLIDAY_KEYS);
    });

    it("returns no bank holidays for a group without a holiday country", async () => {
      const manager = await makeUser("Manager");
      const groupId = await makeGroup("Engineering", manager.id);
      await addMember(groupId, manager.id, { adminAccess: true });

      const res = await request(app)
        .get("/api/sync/pull")
        .set("Cookie", await authCookieFor(manager.id))
        .expect(200);

      expect(res.body.bankHolidays).toEqual([]);
    });

    it("answers a delta with the rows changed since the cursor and nothing else", async () => {
      const manager = await makeUser("Manager");
      const groupId = await makeGroup("Engineering", manager.id, { holidayCountry: "CZ" });
      await addMember(groupId, manager.id, { adminAccess: true });
      const cookie = await authCookieFor(manager.id);

      await request(app).get("/api/sync/pull").set("Cookie", cookie).expect(200);
      await ageEverything();
      const [renamed] = await db
        .select()
        .from(bankHolidays)
        .where(and(eq(bankHolidays.country, "CZ"), eq(bankHolidays.date, `${THIS_YEAR}-01-01`)));
      await db
        .update(bankHolidays)
        .set({ name: "Renamed", updatedAt: ago(1 * MINUTE) })
        .where(eq(bankHolidays.id, renamed!.id));

      const res = await request(app)
        .get("/api/sync/pull")
        .query({ cursor: encodeSyncCursor(ago(10 * MINUTE)) })
        .set("Cookie", cookie)
        .expect(200);

      expect(res.body.reset).toBe(false);
      expect((res.body.bankHolidays as BankHolidayRow[]).map((row) => row.id)).toEqual([
        renamed!.id,
      ]);
    });
  });
});
