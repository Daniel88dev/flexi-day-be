import { describe, it, expect } from "vitest";
import {
  computePublicHolidays,
  getSupportedCountries,
  isSupportedCountry,
} from "../holidayDataset.js";

describe("getSupportedCountries", () => {
  it("returns code/name pairs sorted by name", () => {
    const countries = getSupportedCountries();

    expect(countries.length).toBeGreaterThan(50);
    for (const country of countries.slice(0, 5)) {
      expect(country.code).toMatch(/^[A-Z]{2}$/);
      expect(country.name.length).toBeGreaterThan(0);
    }
    const names = countries.map((c) => c.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it("returns English names, matching the API doc", () => {
    const byCode = new Map(getSupportedCountries().map((c) => [c.code, c.name]));

    expect(byCode.get("CZ")).toBe("Czech Republic");
    expect(byCode.get("DE")).toBe("Germany");
  });
});

describe("isSupportedCountry", () => {
  it("accepts common countries", () => {
    expect(isSupportedCountry("CZ")).toBe(true);
    expect(isSupportedCountry("DE")).toBe(true);
    expect(isSupportedCountry("US")).toBe(true);
  });

  it("rejects unknown codes", () => {
    expect(isSupportedCountry("XX")).toBe(false);
    expect(isSupportedCountry("")).toBe(false);
  });
});

describe("computePublicHolidays", () => {
  it("returns public holidays with plain YYYY-MM-DD dates", () => {
    const rows = computePublicHolidays("CZ", 2026);

    expect(rows.length).toBeGreaterThan(5);
    for (const row of rows) {
      expect(row.date).toMatch(/^2026-\d{2}-\d{2}$/);
      expect(row.country).toBe("CZ");
      expect(row.name.length).toBeGreaterThan(0);
      expect(row.id.length).toBeGreaterThan(0);
    }
    expect(rows.map((r) => r.date)).toContain("2026-01-01");
  });

  it("never emits two rows for the same date", () => {
    const rows = computePublicHolidays("US", 2026);
    const dates = rows.map((r) => r.date);

    expect(new Set(dates).size).toBe(dates.length);
  });

  it("returns an empty array for an unsupported country", () => {
    expect(computePublicHolidays("XX", 2026)).toEqual([]);
  });
});
