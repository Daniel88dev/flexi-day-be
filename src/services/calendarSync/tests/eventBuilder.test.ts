import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  calendarCapability,
  calendarProvider,
  calendarSyncEventKind,
} from "../../../db/schema/calendar-connection-schema.js";
import { CalendarRecordType } from "../../../db/schema/vacation-schema.js";
import { buildDesired, type BuildInput } from "../eventBuilder.js";
import { recordTypeLabels } from "../labels.js";

const VACATION_ID = "vac-1";
const CONFIG_ID = "cfg-1";
const LEDGER_ID = "ledger-1";

const record = (overrides: Partial<BuildInput["record"]> = {}): BuildInput["record"] => ({
  id: VACATION_ID,
  vacationType: CalendarRecordType.Vacation,
  requestedDay: "2026-10-12",
  startTime: null,
  endTime: null,
  note: null,
  ...overrides,
});

const input = (overrides: Partial<BuildInput> = {}): BuildInput => ({
  record: record(),
  provider: calendarProvider.Google,
  capability: calendarCapability.Status,
  timeZone: "Europe/Prague",
  labels: recordTypeLabels("en"),
  configId: CONFIG_ID,
  ledgerId: LEDGER_ID,
  ...overrides,
});

const google = (overrides: Partial<BuildInput> = {}) =>
  buildDesired(input({ provider: calendarProvider.Google, ...overrides }));
const microsoft = (overrides: Partial<BuildInput> = {}) =>
  buildDesired(input({ provider: calendarProvider.Microsoft, ...overrides }));

const privateIds = {
  private: { flexiDayVacationId: VACATION_ID, flexiDayConfigId: CONFIG_ID },
};

const timed = { startTime: "09:00:00", endTime: "13:30:00" };
const homeOffice = { vacationType: CalendarRecordType.HomeOffice };

describe("buildDesired, Google with status types", () => {
  it.each([calendarCapability.Status, calendarCapability.Unknown])(
    "writes a full day as a working-location chip labelled with the type (%s)",
    (capability) => {
      const built = google({
        capability,
        record: record({ vacationType: CalendarRecordType.StudyLeave, note: "Exam" }),
      });

      expect(built?.kind).toBe(calendarSyncEventKind.Absence);
      expect(built?.payload).toEqual({
        eventType: "workingLocation",
        summary: "Study leave",
        start: { date: "2026-10-12" },
        end: { date: "2026-10-13" },
        transparency: "transparent",
        visibility: "public",
        workingLocationProperties: {
          type: "customLocation",
          customLocation: { label: "Study leave" },
        },
        extendedProperties: privateIds,
      });
    }
  );

  it("writes Home office as the native home-office working location", () => {
    const built = google({ record: record(homeOffice) });

    expect(built?.kind).toBe(calendarSyncEventKind.HomeOffice);
    expect(built?.payload).toEqual({
      eventType: "workingLocation",
      summary: "Home office",
      start: { date: "2026-10-12" },
      end: { date: "2026-10-13" },
      transparency: "transparent",
      visibility: "public",
      workingLocationProperties: { type: "homeOffice", homeOffice: {} },
      extendedProperties: privateIds,
    });
  });

  it("keeps Home office all-day even when the row carries times", () => {
    const built = google({ record: record({ ...homeOffice, ...timed }) });

    expect(built?.payload).toMatchObject({
      eventType: "workingLocation",
      start: { date: "2026-10-12" },
      end: { date: "2026-10-13" },
    });
  });

  it("writes a timed row as Out of office in the target's zone", () => {
    const built = google({
      capability: calendarCapability.Unknown,
      record: record({ vacationType: CalendarRecordType.Sick, note: "Dentist", ...timed }),
    });

    expect(built?.kind).toBe(calendarSyncEventKind.Absence);
    expect(built?.payload).toEqual({
      eventType: "outOfOffice",
      summary: "Sick",
      description: "Dentist\nSynced from Flexi Day",
      start: { dateTime: "2026-10-12T09:00:00", timeZone: "Europe/Prague" },
      end: { dateTime: "2026-10-12T13:30:00", timeZone: "Europe/Prague" },
      transparency: "opaque",
      outOfOfficeProperties: { autoDeclineMode: "declineNone" },
      extendedProperties: privateIds,
    });
  });
});

describe("buildDesired, Google without status types", () => {
  const plain = (overrides: Partial<BuildInput> = {}) =>
    google({ capability: calendarCapability.Plain, ...overrides });

  it("writes a full day as a plain all-day Busy event", () => {
    const built = plain({ record: record({ note: "Lake trip" }) });

    expect(built?.kind).toBe(calendarSyncEventKind.Absence);
    expect(built?.payload).toEqual({
      eventType: "default",
      summary: "Vacation",
      description: "Lake trip\nSynced from Flexi Day",
      start: { date: "2026-10-12" },
      end: { date: "2026-10-13" },
      transparency: "opaque",
      reminders: { useDefault: false },
      extendedProperties: privateIds,
    });
  });

  it("writes a timed row as a plain timed Busy event", () => {
    const built = plain({ record: record(timed) });

    expect(built?.payload).toEqual({
      eventType: "default",
      summary: "Vacation",
      description: "Synced from Flexi Day",
      start: { dateTime: "2026-10-12T09:00:00", timeZone: "Europe/Prague" },
      end: { dateTime: "2026-10-12T13:30:00", timeZone: "Europe/Prague" },
      transparency: "opaque",
      reminders: { useDefault: false },
      extendedProperties: privateIds,
    });
  });

  it("writes nothing for Home office", () => {
    expect(plain({ record: record(homeOffice) })).toBeNull();
  });
});

describe("buildDesired, Microsoft", () => {
  it.each([calendarCapability.Unknown, calendarCapability.Status, calendarCapability.Plain])(
    "writes a full day as an all-day Out of office event from midnight to midnight (%s)",
    (capability) => {
      const built = microsoft({ capability, record: record({ note: "Lake trip" }) });

      expect(built?.kind).toBe(calendarSyncEventKind.Absence);
      expect(built?.payload).toEqual({
        subject: "Vacation",
        body: { contentType: "text", content: "Lake trip\nSynced from Flexi Day" },
        start: { dateTime: "2026-10-12T00:00:00", timeZone: "Europe/Prague" },
        end: { dateTime: "2026-10-13T00:00:00", timeZone: "Europe/Prague" },
        isAllDay: true,
        showAs: "oof",
        isReminderOn: false,
        transactionId: LEDGER_ID,
      });
    }
  );

  it("writes a timed row as a timed Out of office event", () => {
    const built = microsoft({
      record: record({ vacationType: CalendarRecordType.Other, ...timed }),
    });

    expect(built?.payload).toEqual({
      subject: "Other",
      body: { contentType: "text", content: "Synced from Flexi Day" },
      start: { dateTime: "2026-10-12T09:00:00", timeZone: "Europe/Prague" },
      end: { dateTime: "2026-10-12T13:30:00", timeZone: "Europe/Prague" },
      isAllDay: false,
      showAs: "oof",
      isReminderOn: false,
      transactionId: LEDGER_ID,
    });
  });

  it("writes nothing for Home office", () => {
    expect(microsoft({ record: record(homeOffice) })).toBeNull();
    expect(microsoft({ record: record({ ...homeOffice, ...timed }) })).toBeNull();
  });
});

describe("buildDesired, day shape", () => {
  it("treats a half day without times as a full day", () => {
    const halfDay = { ...record(), halfDay: true };

    expect(google({ record: halfDay })?.payload).toMatchObject({
      eventType: "workingLocation",
      start: { date: "2026-10-12" },
    });
    expect(microsoft({ record: halfDay })?.payload).toMatchObject({ isAllDay: true });
  });

  it("treats a row with only one of the two times as a full day", () => {
    expect(google({ record: record({ startTime: "09:00:00" }) })?.payload).toMatchObject({
      eventType: "workingLocation",
    });
    expect(microsoft({ record: record({ endTime: "12:00:00" }) })?.payload).toMatchObject({
      isAllDay: true,
    });
  });

  it("clamps a timed row that crosses midnight to the end of its day", () => {
    const night = record({ startTime: "22:00:00", endTime: "02:00:00" });

    expect(google({ record: night })?.payload).toMatchObject({
      start: { dateTime: "2026-10-12T22:00:00", timeZone: "Europe/Prague" },
      end: { dateTime: "2026-10-13T00:00:00", timeZone: "Europe/Prague" },
    });
    expect(microsoft({ record: night })?.payload).toMatchObject({
      start: { dateTime: "2026-10-12T22:00:00" },
      end: { dateTime: "2026-10-13T00:00:00" },
      isAllDay: false,
    });
  });

  it("rolls the all-day end over a month and a year boundary", () => {
    expect(google({ record: record({ requestedDay: "2026-12-31" }) })?.payload).toMatchObject({
      start: { date: "2026-12-31" },
      end: { date: "2027-01-01" },
    });
  });

  it("accepts times without seconds", () => {
    expect(
      microsoft({ record: record({ startTime: "08:15", endTime: "16:45" }) })?.payload
    ).toMatchObject({
      start: { dateTime: "2026-10-12T08:15:00" },
      end: { dateTime: "2026-10-12T16:45:00" },
    });
  });
});

describe("buildDesired, content hash", () => {
  it("is the same for identical inputs across runs", () => {
    const first = google({ record: record({ note: "Exam", ...timed }) });
    const second = google({ record: record({ note: "Exam", ...timed }) });

    expect(first?.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(second?.contentHash).toBe(first?.contentHash);
  });

  it("hashes the kind and payload as JSON with keys sorted at every level", () => {
    const canonical =
      '{"kind":"ABSENCE","payload":{"description":"Synced from Flexi Day",' +
      '"end":{"date":"2026-10-13"},"eventType":"default",' +
      '"extendedProperties":{"private":{"flexiDayConfigId":"cfg-1","flexiDayVacationId":"vac-1"}},' +
      '"reminders":{"useDefault":false},"start":{"date":"2026-10-12"},' +
      '"summary":"Vacation","transparency":"opaque"}}';

    expect(google({ capability: calendarCapability.Plain })?.contentHash).toBe(
      createHash("sha256").update(canonical).digest("hex")
    );
  });

  it("changes when the event a provider would show changes", () => {
    const base = google()!.contentHash;

    expect(google({ record: record({ note: "x" }) })!.contentHash).toBe(base);
    expect(google({ capability: calendarCapability.Plain })!.contentHash).not.toBe(base);
    expect(google({ timeZone: "Europe/London", record: record(timed) })!.contentHash).not.toBe(
      google({ record: record(timed) })!.contentHash
    );
    expect(google({ record: record({ requestedDay: "2026-10-13" }) })!.contentHash).not.toBe(base);
  });

  it("does not change with the Microsoft transaction id, which never changes after insert", () => {
    expect(microsoft({ ledgerId: "a" })!.contentHash).toBe(
      microsoft({ ledgerId: "b" })!.contentHash
    );
  });
});
