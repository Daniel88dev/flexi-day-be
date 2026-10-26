import { z } from "zod";
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
  /** The Account picture; the Profile photo arrives with the Photo Section. */
  image: string | null;
  user: UserSummary;
  markers: DirectoryMarker[];
};

export type FormerDirectoryPerson = DirectoryPerson & { startedAt: Date; endedAt: Date };

export type DirectoryPeople = { people: DirectoryPerson[]; formerList: boolean };

export type DirectoryAccountStatus = "ACTIVE" | "NO_ACCOUNT" | "DELETED";

export type DirectoryProfile = DirectoryPerson & {
  organizationId: string;
  self: boolean;
  ended: boolean;
  /** Only the Sections the viewer reads are present. */
  sections: {
    card?: DirectorySectionView;
    photo?: DirectorySectionView;
    workContact?: DirectorySectionView;
    job?: DirectorySectionView & { spell: { startedAt: Date; endedAt: Date | null } };
    contact?: DirectorySectionView;
    personal?: DirectorySectionView;
  };
  /** For the owner, org admins, HR and the person. */
  account?: {
    status: DirectoryAccountStatus;
    signInEmail: string | null;
    directoryRoles: ("HR" | "LEADERSHIP")[];
  };
};
