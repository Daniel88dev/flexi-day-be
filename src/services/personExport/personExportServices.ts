import { and, asc, desc, eq, gt, isNull, or } from "drizzle-orm";
import { db, type DbTransaction } from "../../db/db.js";
import { employments } from "../../db/schema/employment-schema.js";
import { organizations } from "../../db/schema/organization-schema.js";
import {
  personExports,
  personExportScope,
  personExportStatus,
} from "../../db/schema/person-export-schema.js";
import { readLog, readLogAudience, readLogKind } from "../../db/schema/read-log-schema.js";
import { refuse } from "../../utils/appError.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { isOrganizationAdmin, lockOrganization } from "../organization/organizationServices.js";
import { organizationDataStore } from "../organizationData/organizationDataStore.js";
import {
  DOWNLOAD_LINK_TTL_MS,
  ZIP_CONTENT_TYPE,
  type OwnExportOrganization,
  type PersonExportRow,
  type PersonExportView,
} from "./types.js";

export const presentPersonExport = (row: PersonExportRow): PersonExportView => ({
  id: row.id,
  organizationId: row.organizationId,
  scope: row.scope,
  subjectUserId: row.subjectUserId,
  subjectEmploymentId: row.subjectEmploymentId,
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

/** Who a Person export is about: an account, or the one Employment of a person without one. */
export type ExportSubject = { subjectUserId: string } | { subjectEmploymentId: string };

/**
 * Records a request and its `export` row in the Read log, in the caller's
 * transaction. A second request while one is still preparing for the same
 * requester and person returns that one and logs nothing new.
 */
export const requestPersonExport = async (
  input: {
    organizationId: string;
    requestedByUserId: string;
    audience: readLogAudience;
  } & ExportSubject,
  tx: DbTransaction
): Promise<{ row: PersonExportRow; created: boolean }> => {
  const subjectUserId = "subjectUserId" in input ? input.subjectUserId : null;
  const subjectEmploymentId = "subjectEmploymentId" in input ? input.subjectEmploymentId : null;
  // Erase holds this lock, so a request racing one waits and then finds no Employment.
  await lockOrganization(input.organizationId, tx);
  const [pending] = await tx
    .select()
    .from(personExports)
    .where(
      and(
        eq(personExports.organizationId, input.organizationId),
        eq(personExports.scope, personExportScope.Person),
        subjectUserId !== null
          ? eq(personExports.subjectUserId, subjectUserId)
          : eq(personExports.subjectEmploymentId, subjectEmploymentId!),
        eq(personExports.requestedByUserId, input.requestedByUserId),
        eq(personExports.status, personExportStatus.Pending)
      )
    )
    .limit(1);
  if (pending) return { row: pending, created: false };

  const employmentIds =
    subjectUserId !== null
      ? await employmentIdsOf(input.organizationId, subjectUserId, tx)
      : [subjectEmploymentId!];
  if (employmentIds.length === 0) {
    throw refuse(404, "NOT_FOUND", "No employment for that person", { ...input });
  }

  const [row] = await tx
    .insert(personExports)
    .values({
      id: generateRandomUUID(),
      organizationId: input.organizationId,
      subjectUserId,
      subjectEmploymentId,
      requestedByUserId: input.requestedByUserId,
    })
    .returning();

  await tx.insert(readLog).values({
    id: generateRandomUUID(),
    organizationId: input.organizationId,
    kind: readLogKind.Export,
    readerUserId: input.requestedByUserId,
    subjectUserId,
    employmentIds,
    audience: input.audience,
    personExportId: row!.id,
  });

  return { row: row!, created: true };
};

/**
 * An admin's Person export of the Employment's person, every spell of theirs
 * in the organization, or that one Employment for a person without an
 * account. The Read log records the owner or an org admin as the audience.
 */
export const requestEmploymentExport = async (
  input: { employmentId: string; requestedByUserId: string },
  tx: DbTransaction
): Promise<{ row: PersonExportRow; created: boolean }> => {
  const context = { userId: input.requestedByUserId, employmentId: input.employmentId };
  const [employment] = await tx
    .select({
      organizationId: employments.organizationId,
      userId: employments.userId,
      ownerUserId: organizations.ownerUserId,
    })
    .from(employments)
    .innerJoin(organizations, eq(organizations.id, employments.organizationId))
    .where(eq(employments.id, input.employmentId));
  if (!employment) throw refuse(404, "NOT_FOUND", "Employment not found", context);
  if (!(await isOrganizationAdmin(input.requestedByUserId, employment.organizationId, tx))) {
    throw refuse(403, "FORBIDDEN", "No permission for related organization", context);
  }
  return requestPersonExport(
    {
      organizationId: employment.organizationId,
      ...(employment.userId === null
        ? { subjectEmploymentId: input.employmentId }
        : { subjectUserId: employment.userId }),
      requestedByUserId: input.requestedByUserId,
      audience:
        employment.ownerUserId === input.requestedByUserId
          ? readLogAudience.Owner
          : readLogAudience.OrganizationAdmin,
    },
    tx
  );
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
        eq(personExports.scope, personExportScope.Person),
        or(isNull(personExports.expiresAt), gt(personExports.expiresAt, new Date()))
      )
    )
    .orderBy(desc(personExports.createdAt));

  const newest = new Map<string, PersonExportRow>();
  for (const row of rows) {
    const subject = row.subjectUserId ?? row.subjectEmploymentId;
    if (subject && !newest.has(subject)) newest.set(subject, row);
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

export const exportFileName = (
  row: Pick<PersonExportRow, "id" | "scope" | "readyAt" | "createdAt">
) =>
  `flexi-day-${row.scope === personExportScope.Organization ? "organization" : "person"}-export-${(row.readyAt ?? row.createdAt).toISOString().slice(0, 10)}-${row.id.slice(0, 8)}.zip`;

/**
 * Whether the requester still holds the standing the export was requested
 * with: the owner for an Organization export, an org admin for someone
 * else's Person export. Your own Person export needs nothing more.
 */
const stillEntitled = async (row: PersonExportRow, userId: string): Promise<boolean> => {
  if (row.scope === personExportScope.Organization) {
    const [organization] = await db
      .select({ ownerUserId: organizations.ownerUserId })
      .from(organizations)
      .where(eq(organizations.id, row.organizationId));
    return organization?.ownerUserId === userId;
  }
  if (row.subjectUserId === userId) return true;
  return isOrganizationAdmin(userId, row.organizationId);
};

/** A fresh one-hour link for the requester, while the file lives and they keep their standing. */
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
  if (!(await stillEntitled(row, userId))) {
    throw refuse(403, "FORBIDDEN", "You no longer administer the export's organization", context);
  }

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
