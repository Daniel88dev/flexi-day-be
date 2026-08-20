import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { setupTestEnvironment, cleanupTestData, type TestContext } from "./helpers/testSetup.js";
import { authCookieFor } from "./helpers/authHelper.js";
import { db } from "../../db/db.js";
import { bankHolidays } from "../../db/schema/bank-holiday-schema.js";
import { groups } from "../../db/schema/group-schema.js";
import { eq } from "drizzle-orm";

const YEAR = new Date().getFullYear();

describe("Bank holidays E2E", () => {
  let context: TestContext;
  let cookie: string;

  beforeAll(async () => {
    context = await setupTestEnvironment();
    // user1 owns the group's organization, so they hold group admin rights.
    cookie = await authCookieFor(context.user1.id);
    // Self-heal from an interrupted previous run; the first test asserts on
    // an empty table.
    await db.delete(bankHolidays);
  });

  afterAll(async () => {
    await db.delete(bankHolidays);
    await cleanupTestData();
  });

  describe("GET /api/bank-holidays", () => {
    it("fills the table from the dataset on first request", async () => {
      const before = await db.select().from(bankHolidays).where(eq(bankHolidays.country, "CZ"));
      expect(before).toHaveLength(0);

      const response = await request(context.app)
        .get(`/api/bank-holidays?country=CZ&year=${YEAR}`)
        .set("Cookie", cookie)
        .expect(200);

      expect(response.body.length).toBeGreaterThan(5);
      expect(response.body[0]).toMatchObject({ country: "CZ" });
      expect(response.body.map((h: { date: string }) => h.date)).toContain(`${YEAR}-01-01`);

      const stored = await db.select().from(bankHolidays).where(eq(bankHolidays.country, "CZ"));
      expect(stored).toHaveLength(response.body.length);
    });

    it("serves the cached rows on subsequent requests", async () => {
      const first = await request(context.app)
        .get(`/api/bank-holidays?country=CZ&year=${YEAR}`)
        .set("Cookie", cookie)
        .expect(200);
      const second = await request(context.app)
        .get(`/api/bank-holidays?country=CZ&year=${YEAR}`)
        .set("Cookie", cookie)
        .expect(200);

      expect(second.body).toEqual(first.body);
    });

    it("never duplicates rows: repeat and region-filtered requests leave the table unchanged", async () => {
      await request(context.app)
        .get(`/api/bank-holidays?country=CZ&year=${YEAR}`)
        .set("Cookie", cookie)
        .expect(200);
      const filled = await db.select().from(bankHolidays).where(eq(bankHolidays.country, "CZ"));

      // A region-filtered miss on a cached country must not trigger a refill.
      const regionResponse = await request(context.app)
        .get(`/api/bank-holidays?country=CZ&year=${YEAR}&region=PR`)
        .set("Cookie", cookie)
        .expect(200);
      expect(regionResponse.body).toEqual([]);

      await request(context.app)
        .get(`/api/bank-holidays?country=CZ&year=${YEAR}`)
        .set("Cookie", cookie)
        .expect(200);

      const after = await db.select().from(bankHolidays).where(eq(bankHolidays.country, "CZ"));
      expect(after).toHaveLength(filled.length);
      expect(new Set(after.map((r) => r.date)).size).toBe(after.length);
    });

    it("returns an empty array for an unsupported country", async () => {
      const response = await request(context.app)
        .get(`/api/bank-holidays?country=ZZ&year=${YEAR}`)
        .set("Cookie", cookie)
        .expect(200);

      expect(response.body).toEqual([]);
    });
  });

  describe("GET /api/bank-holidays/countries", () => {
    it("lists supported countries", async () => {
      const response = await request(context.app)
        .get("/api/bank-holidays/countries")
        .set("Cookie", cookie)
        .expect(200);

      expect(response.body.length).toBeGreaterThan(50);
      expect(response.body).toContainEqual(expect.objectContaining({ code: "CZ" }));
    });
  });

  describe("PUT /api/group/:groupId/holiday-country", () => {
    it("persists the country, upper-cased, and returns it on group reads", async () => {
      const putResponse = await request(context.app)
        .put(`/api/group/${context.group.id}/holiday-country`)
        .set("Cookie", cookie)
        .send({ holidayCountry: "cz" })
        .expect(200);

      expect(putResponse.body.holidayCountry).toBe("CZ");

      const getResponse = await request(context.app)
        .get(`/api/group/${context.group.id}`)
        .set("Cookie", cookie)
        .expect(200);

      expect(getResponse.body.holidayCountry).toBe("CZ");
    });

    it("clears the country with null", async () => {
      const response = await request(context.app)
        .put(`/api/group/${context.group.id}/holiday-country`)
        .set("Cookie", cookie)
        .send({ holidayCountry: null })
        .expect(200);

      expect(response.body.holidayCountry).toBeNull();

      const [row] = await db.select().from(groups).where(eq(groups.id, context.group.id));
      expect(row?.holidayCountry).toBeNull();
    });

    it("rejects an unsupported country code with 422", async () => {
      await request(context.app)
        .put(`/api/group/${context.group.id}/holiday-country`)
        .set("Cookie", cookie)
        .send({ holidayCountry: "XX" })
        .expect(422);
    });

    it("refuses a caller without group admin rights", async () => {
      const outsiderCookie = await authCookieFor(context.user2.id);

      await request(context.app)
        .put(`/api/group/${context.group.id}/holiday-country`)
        .set("Cookie", outsiderCookie)
        .send({ holidayCountry: "CZ" })
        .expect(403);
    });
  });
});
