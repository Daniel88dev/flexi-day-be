import { and, eq, inArray } from "drizzle-orm";
import { db, type DbTransaction } from "../../db/db.js";
import { directorySensitiveProfiles } from "../../db/schema/directory-sensitive-profile-schema.js";
import { appLanguage } from "../../db/schema/user-settings-schema.js";
import {
  fieldContext,
  openOrganizationCipher,
} from "../fieldEncryption/fieldEncryptionServices.js";
import { countryView, phoneView } from "./contactFormat.js";
import type { ContactSectionValues, PersonalSectionValues } from "./types.js";

export const SENSITIVE_TABLE = "directory_sensitive_profiles";

/** The Contact Section as stored, sealed: phones in E.164, the email lowercase. */
export type StoredContact = {
  privatePhone: string | null;
  privateEmail: string | null;
  emergencyContact1: { name: string; phone: string } | null;
  emergencyContact2: { name: string; phone: string } | null;
};

export type StoredAddress = {
  line1: string;
  line2: string | null;
  postalCode: string | null;
  city: string;
  region: string | null;
  country: string;
};

/** The Personal Section as stored, sealed. Employees only. */
export type StoredPersonal = {
  homeAddress: StoredAddress | null;
  /** `YYYY-MM-DD`. */
  dateOfBirth: string | null;
};

export type StoredSensitive = { contact: StoredContact | null; personal: StoredPersonal | null };

export const EMPTY_CONTACT: StoredContact = {
  privatePhone: null,
  privateEmail: null,
  emergencyContact1: null,
  emergencyContact2: null,
};

export const EMPTY_PERSONAL: StoredPersonal = { homeAddress: null, dateOfBirth: null };

type SensitiveColumn = "contact" | "personal";

const contextOf = (column: SensitiveColumn, employmentId: string) =>
  fieldContext(SENSITIVE_TABLE, column, employmentId);

/**
 * The Sensitive sections of some Employments of one organization, opened. The
 * cipher share-locks the organization's key until `tx` ends, so a re-key
 * can't slip in between.
 */
export const readSensitiveSections = async (
  organizationId: string,
  employmentIds: string[],
  tx: DbTransaction
): Promise<Map<string, StoredSensitive>> => {
  if (employmentIds.length === 0) return new Map();
  const rows = await tx
    .select()
    .from(directorySensitiveProfiles)
    .where(
      and(
        eq(directorySensitiveProfiles.organizationId, organizationId),
        inArray(directorySensitiveProfiles.employmentId, employmentIds)
      )
    );
  if (rows.length === 0) return new Map();
  const cipher = await openOrganizationCipher(organizationId, tx);
  const open = <T>(row: (typeof rows)[number], column: SensitiveColumn): T | null => {
    const stored = row[column];
    return stored === null
      ? null
      : (JSON.parse(cipher.decrypt(stored, contextOf(column, row.employmentId))) as T);
  };
  return new Map(
    rows.map((row) => [
      row.employmentId,
      {
        contact: open<StoredContact>(row, "contact"),
        personal: open<StoredPersonal>(row, "personal"),
      },
    ])
  );
};

export const readSensitiveSection = async (
  organizationId: string,
  employmentId: string,
  tx: DbTransaction
): Promise<StoredSensitive> =>
  (await readSensitiveSections(organizationId, [employmentId], tx)).get(employmentId) ?? {
    contact: null,
    personal: null,
  };

const isEmpty = (value: object) => Object.values(value).every((field) => field === null);

/** Seals and stores both Sections of one Employment. An empty Section is stored as null. */
export const writeSensitiveSections = async (
  organizationId: string,
  employmentId: string,
  values: StoredSensitive,
  tx: DbTransaction
): Promise<void> => {
  const cipher = await openOrganizationCipher(organizationId, tx);
  const seal = (column: SensitiveColumn, value: object | null) =>
    value === null || isEmpty(value)
      ? null
      : cipher.encrypt(JSON.stringify(value), contextOf(column, employmentId));
  const sealed = {
    contact: seal("contact", values.contact),
    personal: seal("personal", values.personal),
  };
  await tx
    .insert(directorySensitiveProfiles)
    .values({ employmentId, organizationId, ...sealed })
    .onConflictDoUpdate({ target: directorySensitiveProfiles.employmentId, set: sealed });
};

/** The Contact Section as the API sends it, every phone with its display form. */
export const contactValuesView = (
  contact: StoredContact | null,
  language: appLanguage
): ContactSectionValues => {
  const value = contact ?? EMPTY_CONTACT;
  const slot = (entry: StoredContact["emergencyContact1"]) =>
    entry === null ? null : { name: entry.name, phone: phoneView(entry.phone, language) };
  return {
    privatePhone: value.privatePhone === null ? null : phoneView(value.privatePhone, language),
    privateEmail: value.privateEmail,
    emergencyContact1: slot(value.emergencyContact1),
    emergencyContact2: slot(value.emergencyContact2),
  };
};

/** The Personal Section as the API sends it, the country with its name. */
export const personalValuesView = (
  personal: StoredPersonal | null,
  language: appLanguage
): PersonalSectionValues => {
  const value = personal ?? EMPTY_PERSONAL;
  return {
    homeAddress:
      value.homeAddress === null
        ? null
        : { ...value.homeAddress, country: countryView(value.homeAddress.country, language) },
    dateOfBirth: value.dateOfBirth,
  };
};

/**
 * The Sensitive sections of the given spells for an export, keyed by
 * Employment id, as stored: phones in E.164, countries as codes.
 */
export const collectSensitiveExport = (
  organizationId: string,
  employmentIds: string[]
): Promise<Map<string, StoredSensitive>> =>
  employmentIds.length === 0
    ? Promise.resolve(new Map<string, StoredSensitive>())
    : db.transaction((tx) => readSensitiveSections(organizationId, employmentIds, tx));
