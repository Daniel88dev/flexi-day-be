import { describe, expect, it } from "vitest";
import { appLanguage } from "../../../db/schema/user-settings-schema.js";
import { countryView, parsePhone, phoneCountryDefault, phoneView } from "../contactFormat.js";

describe("parsePhone", () => {
  it("stores a valid international number in E.164, whatever the spacing", () => {
    expect(parsePhone("+420 601 123 456")).toBe("+420601123456");
    expect(parsePhone("+420601123456")).toBe("+420601123456");
    expect(parsePhone(" +44 20 7946 0958 ")).toBe("+442079460958");
  });

  it("refuses a number that is too short, has no country code, or is not a number", () => {
    expect(parsePhone("+420 601 12")).toBeNull();
    expect(parsePhone("601 123 456")).toBeNull();
    expect(parsePhone("call me")).toBeNull();
    expect(parsePhone("")).toBeNull();
  });

  it("refuses an extension, since a field holds one number and nothing else", () => {
    expect(parsePhone("+420 601 123 456 ext. 12")).toBeNull();
  });
});

describe("phoneView", () => {
  it("sends the international display form and the country, named in the viewer's language", () => {
    expect(phoneView("+420601123456", appLanguage.English)).toEqual({
      e164: "+420601123456",
      display: "+420 601 123 456",
      country: { code: "CZ", name: "Czechia" },
    });
    expect(phoneView("+491701234567", appLanguage.Czech)).toEqual({
      e164: "+491701234567",
      display: "+49 170 1234567",
      country: { code: "DE", name: "Německo" },
    });
  });

  it("keeps a stored number the library no longer reads, rather than hiding it", () => {
    expect(phoneView("+999123", appLanguage.English)).toEqual({
      e164: "+999123",
      display: "+999123",
      country: null,
    });
  });
});

describe("countryView", () => {
  it("names a country in English and in Czech", () => {
    expect(countryView("CZ", appLanguage.English)).toEqual({ code: "CZ", name: "Czechia" });
    expect(countryView("CZ", appLanguage.Czech)).toEqual({ code: "CZ", name: "Česko" });
    expect(countryView("de", appLanguage.Czech)).toEqual({ code: "DE", name: "Německo" });
  });
});

describe("phoneCountryDefault", () => {
  it("takes the Location's country first", () => {
    expect(phoneCountryDefault({ locationCountry: "SK", language: appLanguage.Czech })).toBe("SK");
    expect(phoneCountryDefault({ locationCountry: "DE", language: appLanguage.English })).toBe(
      "DE"
    );
  });

  it("falls back to the interface language, and is empty for English", () => {
    expect(phoneCountryDefault({ locationCountry: null, language: appLanguage.Czech })).toBe("CZ");
    expect(
      phoneCountryDefault({ locationCountry: null, language: appLanguage.English })
    ).toBeNull();
  });
});
