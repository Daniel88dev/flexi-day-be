import { and, eq, inArray } from "drizzle-orm";
import { db, type DbTransaction } from "../../db/db.js";
import { directoryRetentionHolds } from "../../db/schema/directory-retention-schema.js";
import { employments } from "../../db/schema/employment-schema.js";
import { refuse } from "../../utils/appError.js";
import { getPersonContacts } from "../person/personName.js";
import { administersOrganization, type DirectoryViewer } from "./directoryViewer.js";
import type { RetentionHoldView } from "./types.js";

/** The holds on the given Employments, with who set them, keyed by Employment id. */
export const readRetentionHolds = async (
  organizationId: string,
  employmentIds: string[],
  tx?: DbTransaction
): Promise<Map<string, RetentionHoldView>> => {
  if (employmentIds.length === 0) return new Map();
  const rows = await (tx ?? db)
    .select()
    .from(directoryRetentionHolds)
    .where(
      and(
        eq(directoryRetentionHolds.organizationId, organizationId),
        inArray(directoryRetentionHolds.employmentId, employmentIds)
      )
    );
  const setterIds = [...new Set(rows.flatMap((row) => (row.setByUserId ? [row.setByUserId] : [])))];
  const names = new Map(
    (await getPersonContacts(setterIds, { organizationId }, tx)).map((row) => [row.id, row.name])
  );
  return new Map(
    rows.map((row) => [
      row.employmentId,
      {
        setAt: row.setAt,
        setBy:
          row.setByUserId === null
            ? null
            : { userId: row.setByUserId, name: names.get(row.setByUserId) ?? null },
      },
    ])
  );
};

/** 403 unless the owner or an org admin, 404 outside the organization, 422 on an open record. */
const lockHoldable = async (viewer: DirectoryViewer, employmentId: string, tx: DbTransaction) => {
  const context = {
    organizationId: viewer.organizationId,
    employmentId,
    viewerUserId: viewer.standing.userId,
  };
  if (!administersOrganization(viewer)) {
    throw refuse(403, "HOLD_DENIED", "Only the owner and org admins set a retention hold", context);
  }
  const [row] = await tx
    .select({ id: employments.id, endedAt: employments.endedAt })
    .from(employments)
    .where(
      and(eq(employments.id, employmentId), eq(employments.organizationId, viewer.organizationId))
    )
    .for("update");
  if (!row) throw refuse(404, "PERSON_NOT_FOUND", "Person not found", context);
  if (row.endedAt === null) {
    throw refuse(
      422,
      "EMPLOYMENT_OPEN",
      "A retention hold applies to an ended Employment",
      context
    );
  }
};

/**
 * Puts a Retention hold on one ended Employment: every Retention purge skips
 * it until it is lifted. Setting it again keeps the first setter and time.
 * The owner and org admins, on every plan.
 */
export const setRetentionHold = async (
  viewer: DirectoryViewer,
  employmentId: string,
  tx: DbTransaction
): Promise<{ hold: RetentionHoldView | null }> => {
  await lockHoldable(viewer, employmentId, tx);
  await tx
    .insert(directoryRetentionHolds)
    .values({
      employmentId,
      organizationId: viewer.organizationId,
      setByUserId: viewer.standing.userId,
    })
    .onConflictDoNothing();
  const holds = await readRetentionHolds(viewer.organizationId, [employmentId], tx);
  return { hold: holds.get(employmentId) ?? null };
};

/** Lifts the hold, so the next nightly run purges whatever is due. */
export const liftRetentionHold = async (
  viewer: DirectoryViewer,
  employmentId: string,
  tx: DbTransaction
): Promise<{ hold: null }> => {
  await lockHoldable(viewer, employmentId, tx);
  await tx
    .delete(directoryRetentionHolds)
    .where(eq(directoryRetentionHolds.employmentId, employmentId));
  return { hold: null };
};
