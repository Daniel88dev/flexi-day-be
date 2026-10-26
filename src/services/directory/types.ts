import { z } from "zod";
import {
  contractType,
  profileHistoryActor,
  workingTime,
} from "../../db/schema/directory-profile-schema.js";
import { directoryRole, roleChangeReason } from "../../db/schema/directory-role-schema.js";
import { AttachmentRejectionReason } from "../attachment/processor.js";
import {
  directoryAudience,
  directoryPermissionRow,
  directoryPermissionValue,
} from "../../db/schema/directory-schema.js";
import { readLogAudience, readLogKind } from "../../db/schema/read-log-schema.js";
import type { UserSummary } from "../../utils/userPresentation.js";
import type { CountryView, PhoneView } from "./contactFormat.js";
import { retentionPeriod } from "../../db/schema/directory-retention-schema.js";
import { SECTION_ROWS, type SectionRow } from "./permissionResolver.js";

export const validateDirectoryAgreementBody = z.object({
  /** The agreement version the owner was shown and accepted. */
  agreementVersion: z.number().int().min(1),
});

export type DirectoryAgreementBody = z.infer<typeof validateDirectoryAgreementBody>;

export type DirectoryAgreementState = {
  currentVersion: number;
  acceptedVersion: number | null;
  acceptedAt: Date | null;
  acceptedByName: string | null;
  /** On, and the latest acceptance is older than the current version. */
  newVersionReady: boolean;
};

export type DirectoryState = {
  organizationId: string;
  enabled: boolean;
  enabledAt: Date | null;
  disabledAt: Date | null;
  /** Enterprise or Custom right now: turning on and adding data are open. */
  writable: boolean;
  agreement: DirectoryAgreementState;
  /** Live counts for the enable dialog's summary. */
  people: { open: number; former: number };
};

export type DirectoryListKind = "departments" | "locations";

const entryName = z.string().trim().min(1).max(100);
const entryCountry = z.string().trim().toUpperCase().nullable().optional();
const atLeastOne = (body: object) => Object.keys(body).length > 0;

export const validatePostDepartment = z.object({ name: entryName }).strict();
export const validatePostLocation = z.object({ name: entryName, country: entryCountry }).strict();
export const validatePatchDepartment = z
  .object({ name: entryName.optional(), archived: z.boolean().optional() })
  .strict()
  .refine(atLeastOne, "Nothing to change");
export const validatePatchLocation = z
  .object({ name: entryName.optional(), archived: z.boolean().optional(), country: entryCountry })
  .strict()
  .refine(atLeastOne, "Nothing to change");

export type PostListEntry = { name: string; country?: string | null };
export type PatchListEntry = { name?: string; archived?: boolean; country?: string | null };

/** An entry of a Department or Location list. */
export type DirectoryListEntry = {
  id: string;
  name: string;
  archived: boolean;
  /** Locations only. */
  country?: CountryView | null;
  /** A Profile, open or former, holds it. Sent only to viewers who manage the lists. */
  inUse?: boolean;
};

export type DirectoryList = {
  /** The viewer may add, rename, archive and delete entries. */
  editable: boolean;
  /** The plan passes the directory gate; while lapsed nothing can be added. */
  writable: boolean;
  entries: DirectoryListEntry[];
};

/** A Department or Location as a record shows it. */
export type DirectoryEntryRef = { id: string; name: string; archived: boolean };

export type DirectoryOrganizationRole = "OWNER" | "ORGANIZATION_ADMIN" | "MEMBER";

export type DirectoryOrganization = {
  organizationId: string;
  name: string;
  role: DirectoryOrganizationRole;
  enabled: boolean;
  writable: boolean;
  /** Only ever true for the owner. */
  newAgreementVersionReady: boolean;
};

/** Badges on a directory row. Everyone in reach sees `EXTERNAL_WORKER`; the rest go to the owner, org admins and HR only. */
export type DirectoryMarker = "EXTERNAL_WORKER" | "NO_ACCOUNT" | "ACCOUNT_DELETED" | "REJOINED";

/** A Section the viewer reads, at their level. Later tickets add the Section's fields beside `level`. */
export type DirectorySectionView = { level: "READ" | "WRITE" };

export type DirectoryPerson = {
  employmentId: string;
  name: string;
  /** A Card field, so everyone who reaches the person reads it. */
  jobTitle: string | null;
  /** Card fields too; an archived entry still shows on the record that holds it. */
  department: DirectoryEntryRef | null;
  location: DirectoryEntryRef | null;
  /** The Account picture: the avatar when there is no Profile photo. */
  image: string | null;
  /** The small Profile photo; null without one or without a read on the Photo Section. */
  photoUrl: string | null;
  user: UserSummary;
  markers: DirectoryMarker[];
  /** In no group of the organization; sent to the owner and org admins only. */
  noGroup?: boolean;
};

export type FormerDirectoryPerson = DirectoryPerson & {
  startedAt: Date;
  endedAt: Date;
  /** The earliest coming Retention purge among the Sections the viewer reads; null under a hold. */
  nextRemoval: { section: ProfileSectionKey; date: string } | null;
  /** A Retention hold is on. */
  hold: boolean;
};

export type DirectoryCardView = DirectorySectionView & {
  jobTitle: string | null;
  /** Null when unset. `name` is null when the viewer can't reach that person. */
  reportsTo: { employmentId: string; name: string | null } | null;
  /** The name follows a bound, open account and nobody edits it here. */
  nameFromAccount: boolean;
  department: DirectoryEntryRef | null;
  location: (DirectoryEntryRef & { country: CountryView | null }) | null;
};

export type DirectoryWorkContactView = DirectorySectionView & {
  /** Lowercase. Never the sign-in email unless someone copied it in. */
  workEmail: string | null;
  workPhone: PhoneView | null;
  /** Only for viewers who write Work contact: where the edit form's phone country starts. */
  phoneCountryDefault?: CountryView | null;
};

export type DirectoryJobView = DirectorySectionView & {
  spell: { startedAt: Date; endedAt: Date | null };
  legalName: string | null;
  employeeNumber: string | null;
  /** `YYYY-MM-DD`. Never filled in from the spell start. */
  startDate: string | null;
  leavingDate: string | null;
  probationEndDate: string | null;
  contractType: contractType | null;
  workingTime: workingTime | null;
};

export type DirectoryPhotoView = DirectorySectionView & {
  /** Signed links, each the same for an hour. Null without a photo. */
  photo: { smallUrl: string; fullUrl: string } | null;
};

export type EmergencyContactView = { name: string; phone: PhoneView };

/** The Contact values, only ever in a Show response. */
export type ContactSectionValues = {
  privatePhone: PhoneView | null;
  /** Lowercase. */
  privateEmail: string | null;
  emergencyContact1: EmergencyContactView | null;
  emergencyContact2: EmergencyContactView | null;
};

export type HomeAddressView = {
  line1: string;
  line2: string | null;
  postalCode: string | null;
  city: string;
  region: string | null;
  country: CountryView;
};

/** The Personal values, only ever in a Show response. */
export type PersonalSectionValues = {
  homeAddress: HomeAddressView | null;
  /** `YYYY-MM-DD`. */
  dateOfBirth: string | null;
};

/**
 * The Contact Section on a profile: never its values, which only Show returns.
 * Whoever writes it gets the Art. 14 notice and the phone picker's start.
 */
export type DirectoryContactView = DirectorySectionView & {
  notice?: string;
  phoneCountryDefault?: CountryView | null;
};

export type SensitiveSectionName = "contact" | "personal";

/** What Show returns for one Sensitive section. `recorded` says a read-log row was written. */
export type ShownSection =
  | ({ section: "CONTACT"; level: "READ" | "WRITE"; recorded: boolean } & ContactSectionValues)
  | ({ section: "PERSONAL"; level: "READ" | "WRITE"; recorded: boolean } & PersonalSectionValues);

export type DirectoryPeople = {
  people: DirectoryPerson[];
  formerList: boolean;
  /** The viewer opens Directory settings: the owner, org admins and HR. */
  settings: boolean;
  /** The rows carry `noGroup`: the owner and org admins. */
  noGroupFilter: boolean;
};

export type ProfileActions = {
  /** End employment, by the End act cell, on an open record that isn't the owner's. */
  end: boolean;
  /** The Person export: the owner and org admins, for a person with an account. */
  export: boolean;
  /** Erase: the owner and org admins, for a Deleted account. */
  erase: boolean;
  /** Set or lift the Retention hold: the owner and org admins, on an ended record. */
  hold: boolean;
};

export type DirectoryAccountStatus = "ACTIVE" | "NO_ACCOUNT" | "DELETED";

export type DirectoryProfile = DirectoryPerson & {
  organizationId: string;
  self: boolean;
  ended: boolean;
  /** Only the Sections the viewer reads are present. */
  sections: {
    card?: DirectoryCardView;
    photo?: DirectoryPhotoView;
    workContact?: DirectoryWorkContactView;
    job?: DirectoryJobView;
    contact?: DirectoryContactView;
    /** Absent on an External worker's record: Personal applies to employees only. */
    personal?: DirectorySectionView;
  };
  /** The owner, org admins and HR read the profile history. */
  canReadHistory: boolean;
  /** What the viewer may do to this record from its profile. */
  actions: ProfileActions;
  /** On an ended record only: the Retention hold and when each Section goes or went. */
  retention?: ProfileRetention;
  /** For the owner, org admins, HR and the person. */
  account?: {
    status: DirectoryAccountStatus;
    signInEmail: string | null;
    directoryRoles: ("HR" | "LEADERSHIP")[];
  };
};

/** A value sets the field, `null` clears it, and a missing key leaves it as it is. */
const text = (max: number) => z.string().trim().min(1).max(max).nullable().optional();
const day = z.iso.date().nullable().optional();
const optionalLine = (max: number) => z.string().trim().max(max).nullable().optional();
const phone = z.string().trim().min(1).max(40);
const emergencyContact = z
  .object({ name: z.string().trim().min(1).max(100), phone })
  .strict()
  .nullable()
  .optional();

export const validatePatchDirectoryProfile = z
  .object({
    card: z
      .object({
        name: z.string().trim().min(1).max(200).optional(),
        jobTitle: text(100),
        reportsToEmploymentId: z.string().min(1).nullable().optional(),
        departmentId: z.string().min(1).nullable().optional(),
        locationId: z.string().min(1).nullable().optional(),
      })
      .strict()
      .optional(),
    workContact: z
      .object({
        workEmail: z.string().trim().toLowerCase().pipe(z.email().max(254)).nullable().optional(),
        /** International form; the service parses it and stores E.164. */
        workPhone: z.string().trim().min(1).max(40).nullable().optional(),
      })
      .strict()
      .optional(),
    job: z
      .object({
        legalName: text(200),
        employeeNumber: text(50),
        startDate: day,
        leavingDate: day,
        probationEndDate: day,
        contractType: z.enum(contractType).nullable().optional(),
        workingTime: z.enum(workingTime).nullable().optional(),
      })
      .strict()
      .optional(),
    contact: z
      .object({
        /** International form; the service parses it and stores E.164. */
        privatePhone: phone.nullable().optional(),
        privateEmail: z
          .string()
          .trim()
          .toLowerCase()
          .pipe(z.email().max(254))
          .nullable()
          .optional(),
        /** A filled slot needs both a name and a phone. */
        emergencyContact1: emergencyContact,
        emergencyContact2: emergencyContact,
      })
      .strict()
      .optional(),
    personal: z
      .object({
        /** Line 1, city and country are needed once any part is filled. */
        homeAddress: z
          .object({
            line1: z.string().trim().min(1).max(200),
            line2: optionalLine(200),
            postalCode: optionalLine(16),
            city: z.string().trim().min(1).max(100),
            region: optionalLine(100),
            /** ISO 3166-1 alpha-2. */
            country: z.string().trim().toUpperCase().length(2),
          })
          .strict()
          .nullable()
          .optional(),
        dateOfBirth: day,
      })
      .strict()
      .optional(),
  })
  .strict();

export type PatchDirectoryProfile = z.infer<typeof validatePatchDirectoryProfile>;

export type ProfileHistoryEntry = {
  id: string;
  at: Date;
  /** Null once the actor's user row is gone. */
  actorName: string | null;
  section: directoryPermissionRow;
  fields: string[];
  /** RETENTION for a Retention purge, which has no actor and no Audience. */
  actor: profileHistoryActor;
  audience: directoryAudience | null;
};

export const validatePatchPermissionCell = z
  .object({
    row: z.enum(directoryPermissionRow),
    audience: z.enum(directoryAudience),
    value: z.enum(directoryPermissionValue),
  })
  .strict();

export type PatchPermissionCell = z.infer<typeof validatePatchPermissionCell>;

export type PermissionTableCell = {
  row: directoryPermissionRow;
  audience: directoryAudience;
  value: directoryPermissionValue;
  /** The owner can't change it. */
  fixed: boolean;
  /** The values the owner may set; a fixed cell offers only its own. */
  options: directoryPermissionValue[];
};

export type PermissionTable = {
  /** Only the owner edits the table and assigns roles. */
  editable: boolean;
  /** The plan passes the directory gate; while lapsed the owner may only narrow. */
  writable: boolean;
  cells: PermissionTableCell[];
};

export const validatePutDirectoryRoles = z
  .object({ roles: z.array(z.enum(directoryRole)).max(2) })
  .strict();

export type PutDirectoryRoles = z.infer<typeof validatePutDirectoryRoles>;

export type DirectoryRoleHolder = {
  employmentId: string;
  name: string;
  roles: directoryRole[];
};

export type DirectoryRoles = {
  editable: boolean;
  writable: boolean;
  /** Every open Employment with a live account, the only ones that may hold a role. */
  people: DirectoryRoleHolder[];
};

export type PermissionHistoryEntry =
  | {
      kind: "CELL";
      id: string;
      at: Date;
      actorName: string | null;
      row: directoryPermissionRow;
      audience: directoryAudience;
      before: directoryPermissionValue | null;
      after: directoryPermissionValue;
    }
  | {
      kind: "ROLE";
      id: string;
      at: Date;
      actorName: string | null;
      role: directoryRole;
      /** Null once the person was erased. */
      employmentId: string | null;
      personName: string | null;
      before: boolean;
      after: boolean;
      reason: roleChangeReason;
    };

export const validatePostProfilePhoto = z.object({
  // Free-form on purpose: an unsupported type answers 422 with a reason the
  // client can show, not a schema error.
  contentType: z.string().min(1).max(100),
  size: z.number().int().positive(),
});

export type PostProfilePhoto = z.infer<typeof validatePostProfilePhoto>;

const photoReady = z.object({ status: z.literal("READY") });
const photoRejected = z.object({
  status: z.literal("REJECTED"),
  rejectionReason: z.enum(AttachmentRejectionReason),
});

export const validatePhotoOutcome = z.discriminatedUnion("status", [photoReady, photoRejected]);

export type PhotoProcessedOutcome = z.infer<typeof validatePhotoOutcome>;

/** What the Lambda reports once a Profile photo's bytes are checked and both sizes stored. */
export const validatePhotoProcessed = z.discriminatedUnion("status", [
  photoReady.extend({ photoId: z.uuid() }),
  photoRejected.extend({ photoId: z.uuid() }),
]);

export type PhotoProcessedPayload = z.infer<typeof validatePhotoProcessed>;
export const validateReadLogQuery = z.object({
  employmentId: z.string().min(1).optional(),
  readerUserId: z.string().min(1).optional(),
  /** The id of the last row of the previous page. */
  before: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export type ReadLogEntry = {
  id: string;
  kind: readLogKind;
  at: Date;
  /** `name` is null once the reader's user row is gone. */
  reader: { userId: string; name: string | null };
  /** `name` is null once the person was erased. */
  person: { employmentId: string | null; name: string | null };
  /** The Sections a read opened; null on an export. */
  sections: directoryPermissionRow[] | null;
  audience: readLogAudience;
};

export type ReadLogPage = {
  entries: ReadLogEntry[];
  /** Pass as `before` for the next page; null on the last. */
  nextBefore: string | null;
  /** Everyone the log holds rows about, for the person filter. */
  people: { employmentId: string; name: string }[];
  /** Everyone the log holds rows by, for the reader filter. */
  readers: { userId: string; name: string | null }[];
};

const noticeText = z.string().trim().min(1).max(2000).nullable().optional();

export const validatePutDirectoryGeneralSettings = z
  .object({
    /** The organization's own Art. 14 notice per language; null goes back to the default. */
    emergencyContactNotice: z.object({ en: noticeText, cs: noticeText }).strict(),
  })
  .strict();

export type PutDirectoryGeneralSettings = z.infer<typeof validatePutDirectoryGeneralSettings>;

export const validatePutRetentionPeriod = z
  .object({
    section: z.enum(SECTION_ROWS),
    period: z.enum(retentionPeriod),
  })
  .strict();

export type PutRetentionPeriod = z.infer<typeof validatePutRetentionPeriod>;

export const validateRetentionPreviewQuery = validatePutRetentionPeriod;

export type RetentionSettings = {
  /** The owner and org admins change these; HR reads them. */
  editable: boolean;
  periods: Record<SectionRow, retentionPeriod>;
  defaults: Record<SectionRow, retentionPeriod>;
};

export type RetentionPreview = PutRetentionPeriod & {
  /** Ended Employments whose Section the period would remove at the next nightly run. */
  affected: number;
};

/** Where the Section keys are those of `DirectoryProfile.sections`. */
export type ProfileSectionKey = "card" | "photo" | "workContact" | "job" | "contact" | "personal";

/**
 * One Section's retention on an ended record. `REMOVES_ON`: the nightly run of
 * that day empties it. `REMOVED_ON`: a Retention purge emptied it that day.
 * `KEPT_UNTIL_ERASED`: its period is until erased. `ON_HOLD`: it holds data
 * that a hold keeps.
 */
export type SectionRetention =
  | { status: "REMOVES_ON" | "REMOVED_ON"; date: string }
  | { status: "KEPT_UNTIL_ERASED" | "ON_HOLD" };

export type ProfileRetention = {
  hold: RetentionHoldView | null;
  /** Only Sections the viewer reads; a Section with nothing to say is absent. */
  sections: Partial<Record<ProfileSectionKey, SectionRetention>>;
};

export type RetentionHoldView = {
  setAt: Date;
  /** Null once the setter's account is gone; `name` is null when it can't be read. */
  setBy: { userId: string; name: string | null } | null;
};

export type DirectoryGeneralSettings = {
  /** The owner and org admins change these; HR reads them. */
  editable: boolean;
  /** The organization's own texts; null where it uses the default. */
  emergencyContactNotice: { en: string | null; cs: string | null };
  /** The product defaults, with `{organization}` and `{period}` unfilled. */
  defaults: { en: string; cs: string };
  /** What `{period}` reads as: how long Contact is kept after an Employment ends. */
  period: { en: string; cs: string };
};
