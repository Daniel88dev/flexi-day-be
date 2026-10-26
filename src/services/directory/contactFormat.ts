import { parsePhoneNumberFromString } from "libphonenumber-js/max";
import { appLanguage } from "../../db/schema/user-settings-schema.js";

/** A country as the API sends it: ISO 3166-1 alpha-2 and its name in the viewer's language. */
export type CountryView = { code: string; name: string };

/**
 * A stored phone as the API sends it. The phone app has no phone library and
 * Hermes no `Intl.DisplayNames`, so the server formats both strings.
 */
export type PhoneView = { e164: string; display: string; country: CountryView | null };

const INTERNATIONAL = /^\+[\d\s().-]+$/;

/** E.164 for a valid number in international form, else null. One number, no extension. */
export const parsePhone = (input: string): string | null => {
  const value = input.trim();
  if (!INTERNATIONAL.test(value)) return null;
  const phone = parsePhoneNumberFromString(value);
  if (!phone || !phone.isValid() || phone.ext) return null;
  return phone.number;
};

const regionNames = new Map<appLanguage, Intl.DisplayNames>();

export const countryView = (code: string, language: appLanguage): CountryView => {
  let names = regionNames.get(language);
  if (!names) {
    names = new Intl.DisplayNames([language], { type: "region", fallback: "code" });
    regionNames.set(language, names);
  }
  const upper = code.toUpperCase();
  return { code: upper, name: names.of(upper) ?? upper };
};

const knownRegions = new Intl.DisplayNames(["en"], { type: "region", fallback: "none" });
// Region codes Intl names that are not countries.
const NOT_COUNTRIES = new Set(["EU", "EZ", "UN", "ZZ", "QO", "XA", "XB"]);

/** An ISO 3166-1 alpha-2 country code, upper case. */
export const isCountryCode = (code: string): boolean =>
  /^[A-Z]{2}$/.test(code) && !NOT_COUNTRIES.has(code) && knownRegions.of(code) !== undefined;

export const phoneView = (e164: string, language: appLanguage): PhoneView => {
  const phone = parsePhoneNumberFromString(e164);
  return {
    e164,
    display: phone?.isValid() ? phone.formatInternational() : e164,
    country: phone?.isValid() && phone.country ? countryView(phone.country, language) : null,
  };
};

const LANGUAGE_COUNTRY: Record<appLanguage, string | null> = {
  [appLanguage.Czech]: "CZ",
  // English is spoken in too many countries to pick one.
  [appLanguage.English]: null,
};

/**
 * The country the edit form's phone picker starts on: the Location's country,
 * then the interface language, otherwise none.
 */
export const phoneCountryDefault = ({
  locationCountry,
  language,
}: {
  locationCountry: string | null;
  language: appLanguage;
}): string | null => locationCountry ?? LANGUAGE_COUNTRY[language];
