import { z } from "zod";
import type { personExportStatus } from "../../db/schema/person-export-schema.js";

/** A signed download link lasts an hour; it can be signed again while the file lives. */
export const DOWNLOAD_LINK_TTL_MS = 60 * 60 * 1000;
/** Matches the `exports/` lifecycle rule on the organization-data bucket. */
export const EXPORT_FILE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const ZIP_CONTENT_TYPE = "application/zip";

export type PersonExportRow = {
  id: string;
  organizationId: string;
  subjectUserId: string;
  requestedByUserId: string;
  status: personExportStatus;
  attempts: number;
  storageKey: string | null;
  sizeBytes: number | null;
  readyAt: Date | null;
  expiresAt: Date | null;
  failedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/** What the API answers for one export. */
export type PersonExportView = {
  id: string;
  organizationId: string;
  subjectUserId: string;
  status: personExportStatus;
  createdAt: Date;
  readyAt: Date | null;
  expiresAt: Date | null;
};

export type OwnExportOrganization = {
  organizationId: string;
  organizationName: string;
  employmentId: string;
  startedAt: Date;
  endedAt: Date | null;
  export: PersonExportView | null;
};

export const validateOwnPersonExportRequest = z.object({
  organizationId: z.string().min(1),
});

export type ValidatedOwnPersonExportRequest = z.infer<typeof validateOwnPersonExportRequest>;

export const validatePersonExportListQuery = z.object({
  organizationId: z.string().min(1),
});
