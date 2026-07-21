/**
 * Tests for utils/ics.ts
 * Testing framework: Jest-style APIs (describe/test/it/expect). Compatible with Vitest.
 * Focus: the minimal iCalendar serializer used by the calendar-sync feed.
 */

import { buildIcsCalendar } from "../../utils/ics";

describe("buildIcsCalendar", () => {
  test("wraps events in a VCALENDAR with the calendar name", () => {
    const out = buildIcsCalendar({ name: "My time off", events: [] });
    expect(out.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(out.trimEnd().endsWith("END:VCALENDAR")).toBe(true);
    expect(out).toContain("X-WR-CALNAME:My time off");
    expect(out).toContain("VERSION:2.0");
  });

  test("emits all-day events with an exclusive DTEND (day after last day)", () => {
    const out = buildIcsCalendar({
      name: "Feed",
      events: [
        {
          uid: "v1@flexiday",
          startDate: "2026-06-03",
          endDate: "2026-06-05",
          summary: "Dana — Vacation",
        },
      ],
    });
    expect(out).toContain("DTSTART;VALUE=DATE:20260603");
    // 3rd–5th inclusive -> DTEND is the 6th (exclusive)
    expect(out).toContain("DTEND;VALUE=DATE:20260606");
    expect(out).toContain("UID:v1@flexiday");
  });

  test("single-day event ends the next day", () => {
    const out = buildIcsCalendar({
      name: "Feed",
      events: [{ uid: "s@f", startDate: "2026-06-10", summary: "Sam — Sick" }],
    });
    expect(out).toContain("DTSTART;VALUE=DATE:20260610");
    expect(out).toContain("DTEND;VALUE=DATE:20260611");
  });

  test("escapes commas, semicolons and backslashes in text values", () => {
    const out = buildIcsCalendar({
      name: "Feed",
      events: [
        {
          uid: "e@f",
          startDate: "2026-06-01",
          summary: "Trip; away",
          description: "note, with, commas \\ backslash",
        },
      ],
    });
    expect(out).toContain("SUMMARY:Trip\\; away");
    expect(out).toContain("DESCRIPTION:note\\, with\\, commas \\\\ backslash");
  });

  test("joins multiple categories with commas", () => {
    const out = buildIcsCalendar({
      name: "Feed",
      events: [
        {
          uid: "e@f",
          startDate: "2026-06-01",
          summary: "x",
          categories: ["Vacation", "Paid time off"],
        },
      ],
    });
    expect(out).toContain("CATEGORIES:Vacation,Paid time off");
  });

  test("uses CRLF line endings throughout", () => {
    const out = buildIcsCalendar({
      name: "Feed",
      events: [{ uid: "e@f", startDate: "2026-06-01", summary: "x" }],
    });
    // every line break is a CRLF, none are bare LF
    expect(out.split("\n").every((line) => line === "" || line.endsWith("\r"))).toBe(true);
  });
});
