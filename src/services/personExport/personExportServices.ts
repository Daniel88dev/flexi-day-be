import { and, asc, desc, eq, gt, isNull, or } from "drizzle-orm";
import { db, type DbTransaction } from "../../db/db.js";
import { employments } from "../../db/schema/employment-schema.js";
import { organizations } from "../../db/schema/organization-schema.js";
import { personExports, personExportStatus } from "../../db/schema/person-export-schema.js";
import { readLog, readLogAudience, readLogKind } from "../../db/schema/read-log-schema.js";
import AppError from "../../utils/appError.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { organizationDataStore } from "../organizationData/organizationDataStore.js";
import {
  DOWNLOAD_LINK_TTL_MS,
  ZIP_CONTENT_TYPE,
  type OwnExportOrganization,
  type PersonExportRow,
  type PersonExportView,
} from "./types.js";

const refuse = (code: number, publicCode: string, message: string, context: object) =>
  new AppError({ code, message, logging: true, context, publicContext: { code: publicCode } });

export const presentPersonExport = (row: PersonExportRow): PersonExportView => ({
  id: row.id,
  organizationId: row.organizationId,
  subjectUserId: row.subjectUserId,
  status: row.status,
  createdAt: row.createdAt,
  readyAt: row.readyAt,
  expiresAt: row.expiresAt,
});

/** Refuses up front while the store is missing (production before the bucket exists). */
export const assertExportStoreConfigured = (): void => {
  if (!organizationDataStore) {
    throw refuse(503, "EXPORT_UNAVAILABLE", "Person exports are not available yet", {});
  }
};

/** Every spell the organization holds for the person, oldest first. */
export const employmentIdsOf = async (
  organizationId: string,
  subjectUserId: string,
  tx?: DbTransaction
): Promise<string[]> => {
  const rows = await (tx ?? db)
    .select({ id: employments.id })
    .from(employments)
    .where(
      and(eq(employments.organizationId, organizationId), eq(employments.userId, subjectUserId))
    )
    .orderBy(asc(employments.startedAt));
  return rows.map((row) => row.id);
};

/**
 * Records a request and its `export` row in the Read log, in the caller's
 * transaction. A second request while one is still preparing for the same
 * requester and person returns that one and logs nothing new.
 */
export const requestPersonExport = async (
  input: {
    organizationId: string;
    subjectUserId: string;
    requestedByUserId: string;
    audience: readLogAudience;
  },
  tx: DbTransaction
): Promise<{ row: PersonExportRow; created: boolean }> => {
  const [pending] = await tx
    .select()
    .from(personExports)
    .where(
      and(
        eq(personExports.organizationId, input.organizationId),
        eq(personExports.subjectUserId, input.subjectUserId),
        eq(personExports.requestedByUserId, input.requestedByUserId),
        eq(personExports.status, personExportStatus.Pending)
      )
    )
    .limit(1);
  if (pending) return { row: pending, created: false };

  const employmentIds = await employmentIdsOf(input.organizationId, input.subjectUserId, tx);
  if (employmentIds.length === 0) {
    throw refuse(404, "NOT_FOUND", "No employment for that person", { ...input });
  }

  const [row] = await tx
    .insert(personExports)
    .values({
      id: generateRandomUUID(),
      organizationId: input.organizationId,
      subjectUserId: input.subjectUserId,
      requestedByUserId: input.requestedByUserId,
    })
    .returning();

  await tx.insert(readLog).values({
    id: generateRandomUUID(),
    organizationId: input.organizationId,
    kind: readLogKind.Export,
    readerUserId: input.requestedByUserId,
    subjectUserId: input.subjectUserId,
    employmentIds,
    audience: input.audience,
    personExportId: row!.id,
  });

  return { row: row!, created: true };
};

/** The newest export per person that the caller requested in the organization, expired ones left out. */
export const listRequestedExports = async (
  requestedByUserId: string,
  organizationId: string
): Promise<PersonExportView[]> => {
  const rows = await db
    .select()
    .from(personExports)
    .where(
      and(
        eq(personExports.requestedByUserId, requestedByUserId),
        eq(personExports.organizationId, organizationId),
        or(isNull(personExports.expiresAt), gt(personExports.expiresAt, new Date()))
      )
    )
    .orderBy(desc(personExports.createdAt));

  const newest = new Map<string, PersonExportRow>();
  for (const row of rows) {
    if (!newest.has(row.subjectUserId)) newest.set(row.subjectUserId, row);
  }
  return [...newest.values()].map(presentPersonExport);
};

/** Every organization where the caller's account is bound to an Employment, with their newest own export. */
export const listOwnExportOrganizations = async (
  userId: string
): Promise<OwnExportOrganization[]> => {
  const bound = await db
    .select({
      organizationId: employments.organizationId,
      organizationName: organizations.name,
      employmentId: employments.id,
      startedAt: employments.startedAt,
      endedAt: employments.endedAt,
    })
    .from(employments)
    .innerJoin(organizations, eq(organizations.id, employments.organizationId))
    .where(eq(employments.userId, userId))
    .orderBy(asc(organizations.name), asc(employments.startedAt));

  const own = await db
    .select()
    .from(personExports)
    .where(
      and(
        eq(personExports.requestedByUserId, userId),
        eq(personExports.subjectUserId, userId),
        or(isNull(personExports.expiresAt), gt(personExports.expiresAt, new Date()))
      )
    )
    .orderBy(desc(personExports.createdAt));

  const newest = new Map<string, PersonExportRow>();
  for (const row of own) {
    if (!newest.has(row.organizationId)) newest.set(row.organizationId, row);
  }

  const seen = new Set<string>();
  const result: OwnExportOrganization[] = [];
  for (const row of bound) {
    if (seen.has(row.organizationId)) continue;
    seen.add(row.organizationId);
    const latest = newest.get(row.organizationId);
    result.push({ ...row, export: latest ? presentPersonExport(latest) : null });
  }
  return result;
};

export const hasEmployment = async (
  organizationId: string,
  userId: string,
  tx?: DbTransaction
): Promise<boolean> => (await employmentIdsOf(organizationId, userId, tx)).length > 0;

export const exportFileName = (row: Pick<PersonExportRow, "id" | "readyAt" | "createdAt">) =>
  `flexi-day-person-export-${(row.readyAt ?? row.createdAt).toISOString().slice(0, 10)}-${row.id.slice(0, 8)}.zip`;

/** A fresh one-hour link for the requester, while the file lives. */
export const signExportDownload = async (
  exportId: string,
  userId: string
): Promise<{ url: string; expiresAt: string }> => {
  const context = { exportId, userId };
  const [row] = await db
    .select()
    .from(personExports)
    .where(and(eq(personExports.id, exportId), eq(personExports.requestedByUserId, userId)));
  if (!row) throw refuse(404, "NOT_FOUND", "Export not found", context);

  if (row.status !== personExportStatus.Ready || !row.storageKey) {
    throw refuse(409, "EXPORT_NOT_READY", "The export is not ready yet", context);
  }
  if (!row.expiresAt || row.expiresAt.getTime() <= Date.now()) {
    throw refuse(410, "EXPORT_EXPIRED", "The export has expired", context);
  }
  const store = organizationDataStore;
  if (!store) throw refuse(503, "EXPORT_UNAVAILABLE", "Person exports are not available", context);

  return store.createDownloadUrl({
    key: row.storageKey,
    fileName: exportFileName(row),
    contentType: ZIP_CONTENT_TYPE,
    ttlMs: DOWNLOAD_LINK_TTL_MS,
  });
};
