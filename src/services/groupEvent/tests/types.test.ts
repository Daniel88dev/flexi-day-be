import { describe, expect, it } from "vitest";
import { validateCreateGroupEvent, validateGroupEventsQuery } from "../types.js";

const GROUP_ID = "6f1c2a52-1d7e-4c0b-9a51-3a8f0b7c2d11";

const body = (patch: Record<string, unknown> = {}) => ({
  groupId: GROUP_ID,
  title: "Standup",
  startDate: "2026-10-05",
  ...patch,
});

const weekly = (patch: Record<string, unknown> = {}) => ({
  freq: "weekly",
  interval: 1,
  weekdays: [0],
  until: null,
  ...patch,
});

const parse = (patch: Record<string, unknown> = {}) =>
  validateCreateGroupEvent.safeParse(body(patch));

describe("validateCreateGroupEvent", () => {
  it("reads a one-day all-day event with only a title and a start", () => {
    const result = parse();
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      title: "Standup",
      note: null,
      startDate: "2026-10-05",
      endDate: "2026-10-05",
      startTime: null,
      endTime: null,
      repeat: null,
    });
  });

  it("trims the title and refuses one that is blank or over 100 characters", () => {
    expect(parse({ title: "  Retro  " }).data?.title).toBe("Retro");
    expect(parse({ title: "   " }).success).toBe(false);
    expect(parse({ title: "x".repeat(100) }).success).toBe(true);
    expect(parse({ title: "x".repeat(101) }).success).toBe(false);
  });

  it("takes a note up to 1000 characters and reads a blank one as none", () => {
    expect(parse({ note: "x".repeat(1000) }).success).toBe(true);
    expect(parse({ note: "x".repeat(1001) }).success).toBe(false);
    expect(parse({ note: "   " }).data?.note).toBeNull();
  });

  it("refuses an end date before the start and a date that does not exist", () => {
    expect(parse({ endDate: "2026-10-04" }).success).toBe(false);
    expect(parse({ startDate: "2026-02-30" }).success).toBe(false);
  });

  it("needs both times or neither", () => {
    expect(parse({ startTime: "09:00" }).success).toBe(false);
    expect(parse({ endTime: "10:00" }).success).toBe(false);
    expect(parse({ startTime: "09:00", endTime: "10:00" }).success).toBe(true);
  });

  it("refuses a single-day end at or before its start", () => {
    expect(parse({ startTime: "10:00", endTime: "09:00" }).success).toBe(false);
    expect(parse({ startTime: "10:00", endTime: "10:00" }).success).toBe(false);
  });

  it("lets a multi-day timed event end earlier in the day than it started", () => {
    const result = parse({ endDate: "2026-10-07", startTime: "17:00", endTime: "09:00" });
    expect(result.success).toBe(true);
  });

  it("refuses a repeat rule on a multi-day event", () => {
    expect(parse({ endDate: "2026-10-06", repeat: weekly() }).success).toBe(false);
  });

  it("refuses a weekly rule without the start's weekday", () => {
    // 5 Oct 2026 is a Monday (0).
    expect(parse({ repeat: weekly({ weekdays: [2] }) }).success).toBe(false);
    expect(parse({ repeat: weekly({ weekdays: [] }) }).success).toBe(false);
  });

  it("sorts and deduplicates weekly weekdays", () => {
    const result = parse({ repeat: weekly({ weekdays: [4, 0, 2, 0] }) });
    expect(result.data?.repeat?.weekdays).toEqual([0, 2, 4]);
  });

  it("refuses an interval outside 1 to 99 and an until before the start", () => {
    expect(parse({ repeat: weekly({ interval: 0 }) }).success).toBe(false);
    expect(parse({ repeat: weekly({ interval: 100 }) }).success).toBe(false);
    expect(parse({ repeat: weekly({ interval: 99 }) }).success).toBe(true);
    expect(parse({ repeat: weekly({ until: "2026-10-04" }) }).success).toBe(false);
    expect(parse({ repeat: weekly({ until: "2026-10-05" }) }).success).toBe(true);
  });

  it("needs a monthly mode on a monthly rule and drops it elsewhere", () => {
    const monthly = { freq: "monthly", interval: 1, until: null };
    expect(parse({ repeat: monthly }).success).toBe(false);
    expect(parse({ repeat: { ...monthly, monthlyMode: "day" } }).success).toBe(true);
    const daily = parse({
      repeat: { freq: "daily", interval: 1, monthlyMode: "day", weekdays: [3] },
    });
    expect(daily.data?.repeat).toEqual({
      freq: "daily",
      interval: 1,
      weekdays: [],
      monthlyMode: null,
      until: null,
    });
  });

  it("offers only the last weekday from a 5th weekday", () => {
    // 29 Oct 2026 is the 5th and last Thursday.
    const monthly = (monthlyMode: string) => ({ freq: "monthly", interval: 1, monthlyMode });
    expect(parse({ startDate: "2026-10-29", repeat: monthly("weekday") }).success).toBe(false);
    expect(parse({ startDate: "2026-10-29", repeat: monthly("lastWeekday") }).success).toBe(true);
  });

  it("refuses the last weekday from a start that is not the last of its month", () => {
    // 13 Oct 2026 is the 2nd Tuesday.
    const repeat = { freq: "monthly", interval: 1, monthlyMode: "lastWeekday" };
    expect(parse({ startDate: "2026-10-13", repeat }).success).toBe(false);
  });

  it("refuses a group id that is not a UUID", () => {
    expect(parse({ groupId: "dev-team" }).success).toBe(false);
  });
});

describe("validateGroupEventsQuery", () => {
  it("coerces year and month and takes an optional group id", () => {
    expect(validateGroupEventsQuery.parse({ year: "2026", month: "10" })).toEqual({
      year: 2026,
      month: 10,
    });
    expect(
      validateGroupEventsQuery.parse({ year: "2026", month: "10", groupId: GROUP_ID }).groupId
    ).toBe(GROUP_ID);
  });

  it("refuses a month outside 1 to 12", () => {
    expect(validateGroupEventsQuery.safeParse({ year: "2026", month: "13" }).success).toBe(false);
  });
});
