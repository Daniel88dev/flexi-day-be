import { z } from "zod";
import { contractType, workingTime } from "../../db/schema/directory-profile-schema.js";
import { directoryRole, roleChangeReason } from "../../db/schema/directory-role-schema.js";
import {
  directoryAudience,
  directoryPermissionRow,
  directoryPermissionValue,
} from "../../db/schema/directory-schema.js";
import type { UserSummary } from "../../utils/userPresentation.js";

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
  /** The Account picture; the Profile photo arrives with the Photo Section. */
  image: string | null;
  user: UserSummary;
  markers: DirectoryMarker[];
};

export type FormerDirectoryPerson = DirectoryPerson & { startedAt: Date; endedAt: Date };

export type DirectoryCardView = DirectorySectionView & {
  jobTitle: string | null;
  /** Null when unset. `name` is null when the viewer can't reach that person. */
  reportsTo: { employmentId: string; name: string | null } | null;
  /** The name follows a bound, open account and nobody edits it here. */
  nameFromAccount: boolean;
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

export type DirectoryPeople = {
  people: DirectoryPerson[];
  formerList: boolean;
  /** The viewer opens Directory settings: the owner, org admins and HR. */
  settings: boolean;
};

export type DirectoryAccountStatus = "ACTIVE" | "NO_ACCOUNT" | "DELETED";

export type DirectoryProfile = DirectoryPerson & {
  organizationId: string;
  self: boolean;
  ended: boolean;
  /** Only the Sections the viewer reads are present. */
  sections: {
    card?: DirectoryCardView;
    photo?: DirectorySectionView;
    workContact?: DirectorySectionView;
    job?: DirectoryJobView;
    contact?: DirectorySectionView;
    personal?: DirectorySectionView;
  };
  /** The owner, org admins and HR read the profile history. */
  canReadHistory: boolean;
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

export const validatePatchDirectoryProfile = z
  .object({
    card: z
      .object({
        name: z.string().trim().min(1).max(200).optional(),
        jobTitle: text(100),
        reportsToEmploymentId: z.string().min(1).nullable().optional(),
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
  audience: directoryAudience;
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
