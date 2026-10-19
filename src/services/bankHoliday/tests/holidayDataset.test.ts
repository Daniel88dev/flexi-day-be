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

  const datesOf = (country: string, year: number) =>
    computePublicHolidays(country, year).map((row) => row.date);

  const namesByDate = (country: string, year: number) =>
    new Map(computePublicHolidays(country, year).map((row) => [row.date, row.name]));

  it("covers every day of a multi-day holiday, not only its first", () => {
    expect(datesOf("KR", 2027)).toEqual(
      expect.arrayContaining(["2027-02-08", "2027-09-15", "2027-09-16"])
    );
  });

  it("names each covered day after its holiday", () => {
    const ae = namesByDate("AE", 2027);
    const eidAlFitr = ae.get("2027-03-09");
    expect(eidAlFitr).toBeDefined();
    expect(ae.get("2027-03-10")).toBe(eidAlFitr);
    expect(ae.get("2027-03-11")).toBe(eidAlFitr);

    const eg = namesByDate("EG", 2027);
    const eidAlAdha = eg.get("2027-05-16");
    expect(eidAlAdha).toBeDefined();
    for (const date of ["2027-05-17", "2027-05-18", "2027-05-19"]) {
      expect(eg.get(date)).toBe(eidAlAdha);
    }
    expect(eg.get("2027-05-20")).not.toBe(eidAlAdha);
  });

  it("lists a day two holidays cover once, under the first holiday", () => {
    const dates = datesOf("KR", 2027);
    expect(dates.filter((date) => date === "2027-02-09")).toHaveLength(1);
    const kr = namesByDate("KR", 2027);
    expect(kr.get("2027-02-09")).toBe(kr.get("2027-02-07"));
  });

  it("keeps a holiday shorter than a day, or shortened by a DST change, to one row", () => {
    const cn = datesOf("CN", 2027);
    expect(cn.filter((date) => date === "2027-03-08")).toHaveLength(1);
    expect(cn).not.toContain("2027-03-09");

    // PL's Easter Sunday lasts 23 hours: the clocks go forward that night.
    const pl = datesOf("PL", 2027);
    expect(pl.filter((date) => date === "2027-03-28")).toHaveLength(1);
  });

  it("adds no day for a DST hour gained inside a holiday", () => {
    const cz = datesOf("CZ", 2029);
    expect(cz).toContain("2029-10-28");
    expect(cz).not.toContain("2029-10-29");
  });

  it("keeps a year's days inside that year, the tail of the previous year's holiday included", () => {
    const sz2027 = datesOf("SZ", 2027);
    expect(sz2027).toEqual(expect.arrayContaining(["2027-12-28", "2027-12-31"]));
    expect(sz2027.every((date) => date.startsWith("2027-"))).toBe(true);

    const sz2028 = datesOf("SZ", 2028);
    expect(sz2028).toEqual(expect.arrayContaining(["2028-01-01", "2028-01-02"]));
    expect(sz2028).not.toContain("2028-01-03");
    expect(sz2028.every((date) => date.startsWith("2028-"))).toBe(true);
  });

  it("drops the trailing part-day a holiday's span ends on", () => {
    const tr = datesOf("TR", 2027);
    expect(tr).toEqual(expect.arrayContaining(["2027-03-09", "2027-03-10", "2027-03-11"]));
    expect(tr).not.toContain("2027-03-12");
  });
});
