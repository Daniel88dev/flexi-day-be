import { describe, it, expect } from "vitest";
import {
  calendarProvider,
  calendarSyncEventKind,
} from "../../../db/schema/calendar-connection-schema.js";
import {
  buildGroupEventDesired,
  seriesShapeOf,
  type GroupEventBuildInput,
} from "../eventBuilder.js";
import type { GroupEventFeedRecord } from "../types.js";

const EVENT_ID = "ge-1";
const CONFIG_ID = "cfg-1";
const LEDGER_ID = "ledger-1";

/** The research doc's weekly retro: Tuesdays 09:00 to 10:00 until 29 June 2027, 22 Dec skipped. */
const retro = (overrides: Partial<GroupEventFeedRecord> = {}): GroupEventFeedRecord => ({
  kind: "groupEvent",
  id: EVENT_ID,
  groupId: "group-1",
  groupName: "Dev Team",
  title: "Team retro",
  note: "Bring notes",
  startDate: "2026-10-20",
  endDate: "2026-10-20",
  startTime: "09:00:00",
  endTime: "10:00:00",
  repeat: { freq: "weekly", interval: 1, weekdays: [1], monthlyMode: null, until: "2027-06-29" },
  skippedDates: ["2026-12-22"],
  ...overrides,
});

const input = (overrides: Partial<GroupEventBuildInput> = {}): GroupEventBuildInput => ({
  record: retro(),
  provider: calendarProvider.Google,
  timeZone: "Europe/Prague",
  groupLine: "Group: Dev Team",
  configId: CONFIG_ID,
  ledgerId: LEDGER_ID,
  ...overrides,
});

const google = (record: Partial<GroupEventFeedRecord> = {}) =>
  buildGroupEventDesired(input({ record: retro(record), provider: calendarProvider.Google }));
const microsoft = (record: Partial<GroupEventFeedRecord> = {}, timeZone = "Europe/Prague") =>
  buildGroupEventDesired(
    input({ record: retro(record), provider: calendarProvider.Microsoft, timeZone })
  );

const oneOff = { repeat: null, skippedDates: [] };

describe("buildGroupEventDesired, Google", () => {
  it("writes a weekly timed series as a free default event in the target's zone", () => {
    const built = google();

    expect(built.kind).toBe(calendarSyncEventKind.GroupEvent);
    expect(built.payload).toEqual({
      eventType: "default",
      summary: "Team retro",
      description: "Bring notes\nGroup: Dev Team\nSynced from Flexi Day",
      start: { dateTime: "2026-10-20T09:00:00", timeZone: "Europe/Prague" },
      end: { dateTime: "2026-10-20T10:00:00", timeZone: "Europe/Prague" },
      transparency: "transparent",
      reminders: { useDefault: false },
      recurrence: [
        "RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20270629T070000Z",
        "EXDATE;TZID=Europe/Prague:20261222T090000",
      ],
      extendedProperties: {
        private: { flexiDaySourceKey: `ge:${EVENT_ID}`, flexiDayConfigId: CONFIG_ID },
      },
    });
  });

  it("writes an all-day run of days with an exclusive end and no recurrence", () => {
    const built = google({
      ...oneOff,
      note: null,
      startDate: "2026-11-10",
      endDate: "2026-11-12",
      startTime: null,
      endTime: null,
    });

    expect(built.payload).toMatchObject({
      eventType: "default",
      description: "Group: Dev Team\nSynced from Flexi Day",
      start: { date: "2026-11-10" },
      end: { date: "2026-11-13" },
      transparency: "transparent",
    });
    expect(built.payload).not.toHaveProperty("recurrence");
  });

  it("writes an all-day series with DATE exceptions and end", () => {
    const built = google({
      startTime: null,
      endTime: null,
      startDate: "2027-01-30",
      endDate: "2027-01-30",
      repeat: { freq: "monthly", interval: 1, weekdays: [], monthlyMode: "day", until: null },
      skippedDates: ["2027-03-30"],
    });

    expect(built.payload).toMatchObject({
      start: { date: "2027-01-30" },
      end: { date: "2027-01-31" },
      recurrence: [
        "RRULE:FREQ=MONTHLY;BYMONTHDAY=28,29,30;BYSETPOS=-1",
        "EXDATE;VALUE=DATE:20270330",
      ],
    });
  });

  it("changes its content hash when a date is skipped", () => {
    expect(google({ skippedDates: [] }).contentHash).not.toBe(google().contentHash);
    expect(google().contentHash).toBe(google().contentHash);
  });
});

describe("buildGroupEventDesired, Microsoft", () => {
  it("writes a weekly timed series with a patterned recurrence, free, and the skipped dates to cancel", () => {
    const built = microsoft();

    expect(built.kind).toBe(calendarSyncEventKind.GroupEvent);
    expect(built.payload).toEqual({
      subject: "Team retro",
      body: { contentType: "text", content: "Bring notes\nGroup: Dev Team\nSynced from Flexi Day" },
      start: { dateTime: "2026-10-20T09:00:00", timeZone: "Europe/Prague" },
      end: { dateTime: "2026-10-20T10:00:00", timeZone: "Europe/Prague" },
      isAllDay: false,
      showAs: "free",
      isReminderOn: false,
      transactionId: LEDGER_ID,
      recurrence: {
        pattern: {
          type: "weekly",
          interval: 1,
          daysOfWeek: ["tuesday"],
          firstDayOfWeek: "monday",
        },
        range: { type: "endDate", startDate: "2026-10-20", endDate: "2027-06-29" },
      },
    });
    expect(built.cancelledDates).toEqual(["2026-12-22"]);
  });

  it("stamps the target's own zone", () => {
    const built = microsoft({}, "America/New_York");

    expect(built.payload).toMatchObject({
      start: { dateTime: "2026-10-20T09:00:00", timeZone: "America/New_York" },
      end: { dateTime: "2026-10-20T10:00:00", timeZone: "America/New_York" },
    });
  });

  it("writes a timed run of days as one continuous span, with nothing to cancel", () => {
    const built = microsoft({
      ...oneOff,
      startDate: "2026-11-10",
      endDate: "2026-11-11",
      startTime: "18:00:00",
      endTime: "02:00:00",
    });

    expect(built.payload).toMatchObject({
      start: { dateTime: "2026-11-10T18:00:00", timeZone: "Europe/Prague" },
      end: { dateTime: "2026-11-11T02:00:00", timeZone: "Europe/Prague" },
      isAllDay: false,
      showAs: "free",
    });
    expect(built.payload).not.toHaveProperty("recurrence");
    expect(built.cancelledDates).toBeUndefined();
  });

  it("writes an all-day day midnight to midnight", () => {
    const built = microsoft({
      ...oneOff,
      startDate: "2026-11-10",
      endDate: "2026-11-12",
      startTime: null,
      endTime: null,
    });

    expect(built.payload).toMatchObject({
      start: { dateTime: "2026-11-10T00:00:00", timeZone: "Europe/Prague" },
      end: { dateTime: "2026-11-13T00:00:00", timeZone: "Europe/Prague" },
      isAllDay: true,
    });
  });

  it.each([
    [
      "daily every 3 days",
      { freq: "daily", interval: 3, weekdays: [], monthlyMode: null, until: null },
      "2026-10-01",
      { type: "daily", interval: 3 },
    ],
    [
      "monthly on day 31",
      { freq: "monthly", interval: 1, weekdays: [], monthlyMode: "day", until: null },
      "2027-01-31",
      { type: "absoluteMonthly", interval: 1, dayOfMonth: 31 },
    ],
    [
      "monthly on the 2nd Tuesday",
      { freq: "monthly", interval: 2, weekdays: [], monthlyMode: "weekday", until: null },
      "2026-10-13",
      { type: "relativeMonthly", interval: 2, daysOfWeek: ["tuesday"], index: "second" },
    ],
    [
      "monthly on the last Friday",
      { freq: "monthly", interval: 1, weekdays: [], monthlyMode: "lastWeekday", until: null },
      "2026-10-30",
      { type: "relativeMonthly", interval: 1, daysOfWeek: ["friday"], index: "last" },
    ],
    [
      "yearly on 29 February",
      { freq: "yearly", interval: 1, weekdays: [], monthlyMode: null, until: null },
      "2028-02-29",
      { type: "absoluteYearly", interval: 1, month: 2, dayOfMonth: 29 },
    ],
    [
      "weekly on Monday and Wednesday every two weeks",
      { freq: "weekly", interval: 2, weekdays: [0, 2], monthlyMode: null, until: null },
      "2026-10-05",
      {
        type: "weekly",
        interval: 2,
        daysOfWeek: ["monday", "wednesday"],
        firstDayOfWeek: "monday",
      },
    ],
  ] as const)("maps %s", (_, repeat, startDate, pattern) => {
    const built = microsoft({
      repeat: { ...repeat, weekdays: [...repeat.weekdays] },
      startDate,
      endDate: startDate,
      skippedDates: [],
    });

    expect(built.payload).toMatchObject({
      recurrence: { pattern, range: { type: "noEnd", startDate } },
    });
  });

  it("changes its content hash when a date is skipped, not when the ledger id moves", () => {
    const base = microsoft().contentHash;

    expect(microsoft({ skippedDates: [] }).contentHash).not.toBe(base);
    expect(
      buildGroupEventDesired(input({ provider: calendarProvider.Microsoft, ledgerId: "ledger-2" }))
        .contentHash
    ).toBe(base);
  });

  it("keeps a series' shape through a title or note change, not a skipped date, time or rule", () => {
    const shape = seriesShapeOf(microsoft().contentHash);

    expect(shape).not.toBeNull();
    expect(seriesShapeOf(microsoft({ title: "Retro", note: null }).contentHash)).toBe(shape);
    expect(seriesShapeOf(microsoft({ skippedDates: [] }).contentHash)).not.toBe(shape);
    expect(seriesShapeOf(microsoft({ startTime: "08:00:00" }).contentHash)).not.toBe(shape);
    expect(
      seriesShapeOf(
        microsoft({
          repeat: { freq: "weekly", interval: 2, weekdays: [1], monthlyMode: null, until: null },
        }).contentHash
      )
    ).not.toBe(shape);
    expect(seriesShapeOf(microsoft({ repeat: null, skippedDates: [] }).contentHash)).toBeNull();
    expect(seriesShapeOf(google().contentHash)).toBeNull();
  });
});
