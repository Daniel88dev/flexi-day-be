import { describe, it, expect } from "vitest";
import { timeZoneSchema, validateCalendarProviderParam } from "../types.js";
import { calendarProvider } from "../../../db/schema/calendar-connection-schema.js";

describe("timeZoneSchema", () => {
  it("accepts an IANA zone and stores its canonical spelling", () => {
    expect(timeZoneSchema.parse("Europe/Prague")).toBe("Europe/Prague");
    expect(timeZoneSchema.parse(" europe/prague ")).toBe("Europe/Prague");
  });

  it("refuses offsets, which are not IANA names", () => {
    expect(timeZoneSchema.safeParse("+01:00").success).toBe(false);
    expect(timeZoneSchema.safeParse("GMT+1").success).toBe(false);
  });

  it("accepts UTC", () => {
    expect(timeZoneSchema.parse("UTC")).toBe("UTC");
  });

  it("rejects a name that is not a zone", () => {
    expect(timeZoneSchema.safeParse("Mars/Olympus").success).toBe(false);
    expect(timeZoneSchema.safeParse("").success).toBe(false);
  });
});

describe("validateCalendarProviderParam", () => {
  it("maps the URL segment to the stored provider", () => {
    expect(validateCalendarProviderParam.parse("google")).toBe(calendarProvider.Google);
    expect(validateCalendarProviderParam.parse("microsoft")).toBe(calendarProvider.Microsoft);
  });

  it("rejects apple and upper-case values", () => {
    expect(validateCalendarProviderParam.safeParse("apple").success).toBe(false);
    expect(validateCalendarProviderParam.safeParse("GOOGLE").success).toBe(false);
  });
});
