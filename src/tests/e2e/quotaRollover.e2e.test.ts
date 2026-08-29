import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../db/db.js";
import { userYearQuotas } from "../../db/schema/user-year-quotas-schema.js";
import { changesSchema } from "../../db/schema/changes-schema.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
import { groups } from "../../db/schema/group-schema.js";
import { CalendarRecordType } from "../../db/schema/vacation-schema.js";
import { rolloverQuotasForYear } from "../../services/quotaRollover/quotaRolloverServices.js";
import {
  addLeave,
  addLeaveRange,
  addMember,
  addQuota,
  dayIn,
  makeGroup,
  makeUser,
  resetReportData,
} from "./helpers/reportFixtures.js";

const YEAR = new Date().getFullYear() + 2;
const PREVIOUS = YEAR - 1;

const quotaFor = async (userId: string, groupId: string, year: number) => {
  const [row] = await db
    .select()
    .from(userYearQuotas)
    .where(
      and(
        eq(userYearQuotas.userId, userId),
        eq(userYearQuotas.groupId, groupId),
        eq(userYearQuotas.relatedYear, year.toString())
      )
    );
  return row;
};

describe("Quota rollover E2E", () => {
  beforeEach(async () => {
    await resetReportData();
  });

  afterAll(async () => {
    await resetReportData();
  });

  it("opens the new year for every active member, carrying unused days forward", async () => {
    const manager = await makeUser("Manager");
    const member = await makeUser("Member");
    const groupId = await makeGroup("Engineering", manager.id);
    await addMember(groupId, manager.id);
    await addMember(groupId, member.id);
    await addQuota(groupId, manager.id, PREVIOUS, { vacationDays: 20, homeOfficeDays: 5 });
    await addQuota(groupId, member.id, PREVIOUS, { vacationDays: 25, homeOfficeDays: 0 });
    await addLeaveRange(groupId, manager.id, [
      dayIn(PREVIOUS, 3, 10),
      dayIn(PREVIOUS, 3, 11),
      dayIn(PREVIOUS, 3, 12),
    ]);

    const result = await rolloverQuotasForYear(YEAR);

    expect(result).toMatchObject({ year: YEAR, created: 2, skipped: false });
    expect(await quotaFor(manager.id, groupId, YEAR)).toMatchObject({
      vacationDays: 20,
      homeOfficeDays: 5,
      carriedOverDays: 17,
    });
    expect(await quotaFor(member.id, groupId, YEAR)).toMatchObject({
      vacationDays: 25,
      carriedOverDays: 25,
    });
  });

  it("keeps a member's manually raised allowance instead of resetting to the group default", async () => {
    const manager = await makeUser("Manager");
    const groupId = await makeGroup("Engineering", manager.id);
    await addMember(groupId, manager.id);
    // Group default is 20; this member was granted 30 by an admin.
    await addQuota(groupId, manager.id, PREVIOUS, { vacationDays: 30 });

    await rolloverQuotasForYear(YEAR);

    expect((await quotaFor(manager.id, groupId, YEAR))?.vacationDays).toBe(30);
  });

  it("seeds a member with no previous year from the group defaults", async () => {
    const manager = await makeUser("Manager");
    const joiner = await makeUser("Joiner");
    const groupId = await makeGroup("Engineering", manager.id);
    await addMember(groupId, joiner.id);

    await rolloverQuotasForYear(YEAR);

    // makeGroup leaves the schema defaults in place: 20 vacation, 0 home office.
    expect(await quotaFor(joiner.id, groupId, YEAR)).toMatchObject({
      vacationDays: 20,
      homeOfficeDays: 0,
      carriedOverDays: 20,
    });
  });

  it("counts half days as 0.5 when working out what is left over", async () => {
    const manager = await makeUser("Manager");
    const groupId = await makeGroup("Engineering", manager.id);
    await addMember(groupId, manager.id);
    await addQuota(groupId, manager.id, PREVIOUS, { vacationDays: 10 });
    await addLeave(groupId, manager.id, dayIn(PREVIOUS, 3, 10), { halfDay: true });

    await rolloverQuotasForYear(YEAR);

    // 10 − 0.5 = 9.5, floored to a whole day.
    expect((await quotaFor(manager.id, groupId, YEAR))?.carriedOverDays).toBe(9);
  });

  it("treats pending days as spent but ignores rejected ones", async () => {
    const manager = await makeUser("Manager");
    const groupId = await makeGroup("Engineering", manager.id);
    await addMember(groupId, manager.id);
    await addQuota(groupId, manager.id, PREVIOUS, { vacationDays: 10 });
    await addLeave(groupId, manager.id, dayIn(PREVIOUS, 3, 10), { approved: false });
    await addLeave(groupId, manager.id, dayIn(PREVIOUS, 3, 11), {
      approved: false,
      rejected: true,
    });

    await rolloverQuotasForYear(YEAR);

    expect((await quotaFor(manager.id, groupId, YEAR))?.carriedOverDays).toBe(9);
  });

  it("only counts vacation against the carry-over, not other leave types", async () => {
    const manager = await makeUser("Manager");
    const groupId = await makeGroup("Engineering", manager.id);
    await addMember(groupId, manager.id);
    await addQuota(groupId, manager.id, PREVIOUS, { vacationDays: 10 });
    await addLeave(groupId, manager.id, dayIn(PREVIOUS, 3, 10), { type: CalendarRecordType.Sick });
    await addLeave(groupId, manager.id, dayIn(PREVIOUS, 3, 11), {
      type: CalendarRecordType.HomeOffice,
    });

    await rolloverQuotasForYear(YEAR);

    expect((await quotaFor(manager.id, groupId, YEAR))?.carriedOverDays).toBe(10);
  });

  it("records a system audit entry with no actor", async () => {
    const manager = await makeUser("Manager");
    const groupId = await makeGroup("Engineering", manager.id);
    await addMember(groupId, manager.id);
    await addQuota(groupId, manager.id, PREVIOUS, { vacationDays: 20 });
    await addLeave(groupId, manager.id, dayIn(PREVIOUS, 3, 10));

    await rolloverQuotasForYear(YEAR);

    const audit = await db.select().from(changesSchema).where(eq(changesSchema.userId, manager.id));

    expect(audit).toHaveLength(1);
    expect(audit[0]?.changingUserId).toBeNull();
    expect(audit[0]?.changeDetail).toBe(
      `Quota for ${YEAR.toString()} opened automatically: 20 vacation / 0 home office days, ` +
        `19 carried over from ${PREVIOUS.toString()}`
    );
  });

  it("is idempotent — a second run creates nothing and adds no audit noise", async () => {
    const manager = await makeUser("Manager");
    const groupId = await makeGroup("Engineering", manager.id);
    await addMember(groupId, manager.id);
    await addQuota(groupId, manager.id, PREVIOUS, { vacationDays: 20 });

    const first = await rolloverQuotasForYear(YEAR);
    const second = await rolloverQuotasForYear(YEAR);

    expect(first.created).toBe(1);
    expect(second.created).toBe(0);
    expect(await db.select().from(changesSchema)).toHaveLength(1);
  });

  it("never overwrites an allowance an admin already set for the year", async () => {
    const manager = await makeUser("Manager");
    const groupId = await makeGroup("Engineering", manager.id);
    await addMember(groupId, manager.id);
    await addQuota(groupId, manager.id, PREVIOUS, { vacationDays: 20 });
    await addQuota(groupId, manager.id, YEAR, { vacationDays: 99, carriedOverDays: 7 });

    const result = await rolloverQuotasForYear(YEAR);

    expect(result.created).toBe(0);
    expect(await quotaFor(manager.id, groupId, YEAR)).toMatchObject({
      vacationDays: 99,
      carriedOverDays: 7,
    });
  });

  it("skips members whose membership has been removed", async () => {
    const manager = await makeUser("Manager");
    const leaver = await makeUser("Leaver");
    const groupId = await makeGroup("Engineering", manager.id);
    await addMember(groupId, manager.id);
    await addMember(groupId, leaver.id);
    await db
      .update(groupUsers)
      .set({ deletedAt: new Date() })
      .where(eq(groupUsers.userId, leaver.id));

    const result = await rolloverQuotasForYear(YEAR);

    expect(result.created).toBe(1);
    expect(await quotaFor(leaver.id, groupId, YEAR)).toBeUndefined();
  });

  it("skips groups that have been deleted", async () => {
    const manager = await makeUser("Manager");
    const liveGroup = await makeGroup("Engineering", manager.id);
    const deadGroup = await makeGroup("Archived", manager.id);
    await addMember(liveGroup, manager.id);
    await addMember(deadGroup, manager.id);
    await db.update(groups).set({ deletedAt: new Date() }).where(eq(groups.id, deadGroup));

    const result = await rolloverQuotasForYear(YEAR);

    expect(result.created).toBe(1);
    expect(await quotaFor(manager.id, deadGroup, YEAR)).toBeUndefined();
  });

  it("gives a member in two groups one allowance per group", async () => {
    const manager = await makeUser("Manager");
    const groupA = await makeGroup("Engineering", manager.id);
    const groupB = await makeGroup("Design", manager.id);
    await addMember(groupA, manager.id);
    await addMember(groupB, manager.id);
    await addQuota(groupA, manager.id, PREVIOUS, { vacationDays: 20 });
    await addQuota(groupB, manager.id, PREVIOUS, { vacationDays: 5 });

    const result = await rolloverQuotasForYear(YEAR);

    expect(result.created).toBe(2);
    expect((await quotaFor(manager.id, groupA, YEAR))?.vacationDays).toBe(20);
    expect((await quotaFor(manager.id, groupB, YEAR))?.vacationDays).toBe(5);
  });

  it("lets only one of two concurrent runs do the work", async () => {
    const manager = await makeUser("Manager");
    const groupId = await makeGroup("Engineering", manager.id);
    await addMember(groupId, manager.id);

    const [first, second] = await Promise.all([
      rolloverQuotasForYear(YEAR),
      rolloverQuotasForYear(YEAR),
    ]);

    // One does the work; the other either loses the advisory lock or finds
    // nothing left to create. Either way exactly one row exists.
    expect(first.created + second.created).toBe(1);
    expect(await db.select().from(userYearQuotas)).toHaveLength(1);
  });
});
