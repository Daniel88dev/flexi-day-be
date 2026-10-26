import { z } from "zod";

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
