import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { setupTestEnvironment, cleanupTestData, type TestContext } from "./helpers/testSetup.js";
import { authCookieFor } from "./helpers/authHelper.js";
import { db } from "../../db/db.js";
import { bankHolidays } from "../../db/schema/bank-holiday-schema.js";
import { groups } from "../../db/schema/group-schema.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
import { vacation, vacationType } from "../../db/schema/vacation-schema.js";
import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";

const YEAR = new Date().getFullYear();

// A working day comfortably inside the feed window (all future + 12 months back).
const vacationDay = (() => {
  const day = new Date();
  day.setUTCDate(day.getUTCDate() + 14);
  while (day.getUTCDay() === 0 || day.getUTCDay() === 6) day.setUTCDate(day.getUTCDate() + 1);
  return day.toISOString().slice(0, 10);
})();

describe("Calendar feed E2E", () => {
  let context: TestContext;
  let cookie: string;
  let feedToken: string;

  beforeAll(async () => {
    context = await setupTestEnvironment();
    cookie = await authCookieFor(context.user1.id);

    // TEAM scope requires membership, and the org-owner manager holds no row.
    await db.insert(groupUsers).values({
      id: uuidv4(),
      userId: context.user1.id,
      groupId: context.group.id,
      viewAccess: true,
      adminAccess: true,
      approverAccess: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await db.update(groups).set({ holidayCountry: "CZ" }).where(eq(groups.id, context.group.id));

    // Warm the holiday cache so rows exist that a leaky feed could pick up.
    await request(context.app)
      .get(`/api/bank-holidays?country=CZ&year=${YEAR}`)
      .set("Cookie", cookie)
      .expect(200);

    await db.insert(vacation).values({
      id: uuidv4(),
      userId: context.user1.id,
      groupId: context.group.id,
      requestedDay: vacationDay,
      vacationType: vacationType.Vacation,
      approvedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // The feed deliberately *includes* BANK_HOLIDAY, the worst case: holidays
    // must still stay out because they are never vacation rows.
    const created = await request(context.app)
      .post("/api/calendar-sync")
      .set("Cookie", cookie)
      .send({
        name: "Team feed",
        scope: "TEAM",
        teamIds: [context.group.id],
        types: [
          { type: "VACATION", color: "blue" },
          { type: "BANK_HOLIDAY", color: "green" },
        ],
      })
      .expect(201);

    const match = (created.body.feedUrl as string).match(
      /\/calendars\/(flx_live_[a-f0-9]{40})\.ics$/
    );
    expect(match).not.toBeNull();
    feedToken = match![1]!;
  });

  afterAll(async () => {
    await db.delete(bankHolidays);
    await cleanupTestData();
  });

  it("exports approved vacations but never bank holidays", async () => {
    const stored = await db.select().from(bankHolidays).where(eq(bankHolidays.country, "CZ"));
    expect(stored.length).toBeGreaterThan(5);

    const response = await request(context.app).get(`/calendars/${feedToken}.ics`).expect(200);
    const body = response.text || String(response.body);

    expect(body).toContain("BEGIN:VCALENDAR");
    expect(body).toContain(vacationDay.replaceAll("-", ""));
    expect((body.match(/BEGIN:VEVENT/g) ?? []).length).toBe(1);
    for (const holiday of stored) {
      expect(body).not.toContain(holiday.name);
    }
  });
});
