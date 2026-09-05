import { and, eq, isNull, lt, notExists, sql, type SQL } from "drizzle-orm";
import { db } from "../../db/db.js";
import { logger } from "../../middleware/logger.js";
import { attachments, AttachmentStatus } from "../../db/schema/attachment-schema.js";
import { vacation } from "../../db/schema/vacation-schema.js";
import { deleteStoredBytes } from "./attachmentServices.js";
import { ATTACHMENT_RETENTION_MONTHS, STALE_UPLOAD_MS } from "./types.js";

export type AttachmentSweepResult = {
  /** Twelve months past the Request's last day. */
  expired: number;
  /** The Request has no day left that is neither cancelled nor rejected. */
  noLiveDay: number;
  /** `UPLOADING` for over ten minutes: the bytes never came. */
  stale: number;
};

const retentionCutoffDay = (now: Date): string => {
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - ATTACHMENT_RETENTION_MONTHS);
  return cutoff.toISOString().slice(0, 10);
};

// Deleted rows qualify too: once the Request is past retention, or gone, its
// attachment history goes with it.
const expired = (now: Date): SQL =>
  sql`(SELECT MAX(${vacation.requestedDay}) FROM ${vacation} WHERE ${vacation.requestId} = ${
    attachments.requestId
  }) <= ${retentionCutoffDay(now)}`;

const noLiveDay: SQL = notExists(
  db
    .select({ one: sql`1` })
    .from(vacation)
    .where(
      and(
        eq(vacation.requestId, attachments.requestId),
        isNull(vacation.deletedAt),
        isNull(vacation.rejectedAt)
      )
    )
);

const stale = (now: Date): SQL =>
  and(
    eq(attachments.status, AttachmentStatus.Uploading),
    isNull(attachments.deletedAt),
    lt(attachments.createdAt, new Date(now.getTime() - STALE_UPLOAD_MS))
  )!;

/**
 * Removes one row and its object, re-checking `qualifies` under the row lock:
 * a stale upload may have settled since the candidate query ran, and an upload
 * settling right now waits for this transaction, then finds no row.
 */
const remove = async (attachmentId: string, qualifies: SQL): Promise<boolean> =>
  db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        id: attachments.id,
        storageKey: attachments.storageKey,
        status: attachments.status,
      })
      .from(attachments)
      .where(and(eq(attachments.id, attachmentId), qualifies))
      .for("update", { skipLocked: true });
    if (!row) return false;
    await deleteStoredBytes(row);
    await tx.delete(attachments).where(eq(attachments.id, row.id));
    return true;
  });

// One row's failure, most likely the store refusing the delete, must not end
// the night's sweep: the row stays for the next tick and the rest carry on.
const removeAll = async (qualifies: SQL): Promise<number> => {
  const candidates = await db.select({ id: attachments.id }).from(attachments).where(qualifies);
  let removed = 0;
  for (const { id } of candidates) {
    try {
      if (await remove(id, qualifies)) removed += 1;
    } catch (error) {
      logger.error("Attachment sweep could not remove an attachment", {
        attachmentId: id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return removed;
};

/**
 * The retention sweep the nightly job runs. Each case removes the object and
 * the row; a row matching two cases is counted under the first. Safe to run
 * from several instances at once: rows are taken one at a time under
 * `SKIP LOCKED`, so two sweeps share the work rather than fighting over it.
 */
export const sweepAttachments = async (now = new Date()): Promise<AttachmentSweepResult> => ({
  expired: await removeAll(expired(now)),
  noLiveDay: await removeAll(noLiveDay),
  stale: await removeAll(stale(now)),
});
