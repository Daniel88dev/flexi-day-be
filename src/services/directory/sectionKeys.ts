import { directoryPermissionRow } from "../../db/schema/directory-schema.js";
import type { SectionRow } from "./permissionResolver.js";

/** Each Section row's key in `DirectoryProfile.sections`, request paths and bodies. */
export const SECTION_KEYS = {
  [directoryPermissionRow.Card]: "card",
  [directoryPermissionRow.Photo]: "photo",
  [directoryPermissionRow.WorkContact]: "workContact",
  [directoryPermissionRow.Job]: "job",
  [directoryPermissionRow.Contact]: "contact",
  [directoryPermissionRow.Personal]: "personal",
} as const satisfies Record<SectionRow, string>;

export type ProfileSectionKey = (typeof SECTION_KEYS)[SectionRow];

const ROW_BY_KEY = new Map(
  (Object.entries(SECTION_KEYS) as [SectionRow, ProfileSectionKey][]).map(([row, key]) => [
    key,
    row,
  ])
);

export const sectionRowOf = (key: ProfileSectionKey): SectionRow => ROW_BY_KEY.get(key)!;

/** The Sections that open with Show and leave a read-log row. */
export const SENSITIVE_SECTION_KEYS = [
  "contact",
  "personal",
] as const satisfies readonly ProfileSectionKey[];

export type SensitiveSectionName = (typeof SENSITIVE_SECTION_KEYS)[number];

export const isSensitiveSectionKey = (key: string): key is SensitiveSectionName =>
  (SENSITIVE_SECTION_KEYS as readonly string[]).includes(key);
