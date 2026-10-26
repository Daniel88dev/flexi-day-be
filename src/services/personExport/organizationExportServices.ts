import { and, asc, desc, eq, gt, isNull, or } from "drizzle-orm";
import { db, type DbTransaction } from "../../db/db.js";
import { employments } from "../../db/schema/employment-schema.js";
import {
  personExports,
  personExportScope,
  personExportStatus,
} from "../../db/schema/person-export-schema.js";
import { readLog, readLogAudience, readLogKind } from "../../db/schema/read-log-schema.js";
import { logger } from "../../middleware/logger.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { lockOrganization } from "../organization/organizationServices.js";
import { organizationDataStore } from "../organizationData/organizationDataStore.js";
import { organizationExportsPrefix } from "./personExportBuild.js";
import type { PersonExportRow } from "./types.js";

/**
 * Every person with an account the organization holds an Employment for, open
 * or ended, with their spells oldest first. Account-less Employments are left
 * out: the Read log names its subject by user id.
 */
export const organizationPeople = async (
  organizationId: string,
  tx?: DbTransaction
): Promise<{ userId: string; employmentIds: string[] }[]> => {
  const rows = await (tx ?? db)
    .select({ id: employments.id, userId: employments.userId })
    .from(employments)
    .where(eq(employments.organizationId, organizationId))
    .orderBy(asc(employments.startedAt), asc(employments.id));

  const byUser = new Map<string, string[]>();
  for (const row of rows) {
    if (row.userId === null) continue;
    const spells = byUser.get(row.userId) ?? [];
    spells.push(row.id);
    byUser.set(row.userId, spells);
  }
  return [...byUser].map(([userId, employmentIds]) => ({ userId, employmentIds }));
};

/**
 * Records an Organization export request and one `export` row in the Read log
 * for each person in it, in the caller's transaction. A second request while
 * one is still preparing returns that one and logs nothing new.
 */
export const requestOrganizationExport = async (
  input: { organizationId: string; requestedByUserId: string },
  tx: DbTransaction
): Promise<{ row: PersonExportRow; created: boolean }> => {
  // Erase holds this lock, so a request racing one waits and then reads the people without them.
  await lockOrganization(input.organizationId, tx);
  const [pending] = await tx
    .select()
    .from(personExports)
    .where(
      and(
        eq(personExports.organizationId, input.organizationId),
        eq(personExports.scope, personExportScope.Organization),
        eq(personExports.requestedByUserId, input.requestedByUserId),
        eq(personExports.status, personExportStatus.Pending)
      )
    )
    .limit(1);
  if (pending) return { row: pending, created: false };

  const [row] = await tx
    .insert(personExports)
    .values({
      id: generateRandomUUID(),
      organizationId: input.organizationId,
      scope: personExportScope.Organization,
      subjectUserId: null,
      requestedByUserId: input.requestedByUserId,
    })
    .returning();

  const people = await organizationPeople(input.organizationId, tx);
  if (people.length > 0) {
    await tx.insert(readLog).values(
      people.map((person) => ({
        id: generateRandomUUID(),
        organizationId: input.organizationId,
        kind: readLogKind.Export,
        readerUserId: input.requestedByUserId,
        subjectUserId: person.userId,
        employmentIds: person.employmentIds,
        audience: readLogAudience.Owner,
        personExportId: row!.id,
      }))
    );
  }

  return { row: row!, created: true };
};

/** The caller's newest Organization export of the organization that has not expired, if any. */
export const latestOrganizationExport = async (
  organizationId: string,
  requestedByUserId: string
): Promise<PersonExportRow | undefined> => {
  const [row] = await db
    .select()
    .from(personExports)
    .where(
      and(
        eq(personExports.organizationId, organizationId),
        eq(personExports.scope, personExportScope.Organization),
        eq(personExports.requestedByUserId, requestedByUserId),
        or(isNull(personExports.expiresAt), gt(personExports.expiresAt, new Date()))
      )
    )
    .orderBy(desc(personExports.createdAt))
    .limit(1);
  return row;
};

/**
 * Removes every export file of deleted organizations. Runs after the deletion
 * commits: the rows are gone by then and the lifecycle rule would take 7 days.
 * Logs and carries on, because the organization is gone either way.
 */
export const removeOrganizationExports = async (organizationIds: string[]): Promise<void> => {
  const store = organizationDataStore;
  if (!store) return;
  for (const organizationId of organizationIds) {
    try {
      await store.deletePrefix(organizationExportsPrefix(organizationId));
    } catch (error) {
      logger.error("Could not remove a deleted organization's exports", { organizationId, error });
    }
  }
};
