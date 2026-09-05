import { and, count, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, type DbTransaction } from "../../db/db.js";
import { attachments, AttachmentStatus } from "../../db/schema/attachment-schema.js";
import type { AttachmentInsertType, AttachmentType, AttachmentView } from "./types.js";
import { attachmentStore } from "./attachmentStore.js";
import {
  AttachmentRejectionReason,
  isAttachmentContentType,
  processAttachment,
} from "./processor.js";
import AppError from "../../utils/appError.js";

const live = isNull(attachments.deletedAt);

export const toAttachmentView = (row: AttachmentType): AttachmentView => ({
  id: row.id,
  requestId: row.requestId,
  fileName: row.fileName,
  contentType: row.contentType,
  size: row.size,
  status: row.status,
  rejectionReason: row.rejectionReason,
  uploadedByUserId: row.uploadedByUserId,
  createdAt: row.createdAt,
});

export const getAttachmentById = async (
  attachmentId: string,
  tx?: DbTransaction
): Promise<AttachmentType | undefined> => {
  const [row] = await (tx ?? db)
    .select()
    .from(attachments)
    .where(and(eq(attachments.id, attachmentId), live));
  return row;
};

export const listAttachmentsForRequest = async (
  requestId: string,
  tx?: DbTransaction
): Promise<AttachmentView[]> => {
  const rows = await (tx ?? db)
    .select()
    .from(attachments)
    .where(and(eq(attachments.requestId, requestId), live))
    .orderBy(attachments.createdAt);
  return rows.map(toAttachmentView);
};

/**
 * Serialises attachment creation per Request for the rest of the transaction,
 * so two parallel creates cannot both read four rows and both insert a fifth.
 */
export const lockRequestForAttachments = async (
  requestId: string,
  tx: DbTransaction
): Promise<void> => {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${requestId}))`);
};

/** Uploading and ready rows both hold a slot; a rejected one frees it. */
export const holdsAttachmentSlot = (status: AttachmentStatus): boolean =>
  status === AttachmentStatus.Uploading || status === AttachmentStatus.Ready;

export const countAttachmentSlotsUsed = async (
  requestId: string,
  tx?: DbTransaction
): Promise<number> => {
  const [row] = await (tx ?? db)
    .select({ used: count() })
    .from(attachments)
    .where(
      and(
        eq(attachments.requestId, requestId),
        live,
        inArray(attachments.status, Object.values(AttachmentStatus).filter(holdsAttachmentSlot))
      )
    );
  return row?.used ?? 0;
};

export const createAttachment = async (
  data: AttachmentInsertType,
  tx?: DbTransaction
): Promise<AttachmentType> => {
  const [row] = await (tx ?? db).insert(attachments).values(data).returning();
  if (!row) {
    throw new AppError({ message: "Failed to create attachment", logging: true, code: 500 });
  }
  return row;
};

const settle = async (
  attachmentId: string,
  patch: Partial<Pick<AttachmentType, "status" | "rejectionReason" | "contentType" | "size">>,
  tx: DbTransaction
): Promise<AttachmentType | undefined> => {
  const [row] = await tx
    .update(attachments)
    .set(patch)
    .where(eq(attachments.id, attachmentId))
    .returning();
  return row;
};

/**
 * What the S3 event does in production (docs/adr/0003), run in-process by the
 * disk store: check the bytes, rewrite images, store the result and settle the
 * row. The row is locked for the whole step, so a second delivery of the same
 * upload waits, finds the row settled, and gets undefined instead of
 * overwriting or deleting the first delivery's bytes.
 */
export const completeUpload = async (
  attachmentId: string,
  bytes: Buffer
): Promise<AttachmentType | undefined> =>
  db.transaction(async (tx) => {
    const [attachment] = await tx
      .select()
      .from(attachments)
      .where(and(eq(attachments.id, attachmentId), live))
      .for("update");
    if (!attachment || attachment.status !== AttachmentStatus.Uploading) return undefined;

    const rejected = (rejectionReason: AttachmentRejectionReason) =>
      settle(attachment.id, { status: AttachmentStatus.Rejected, rejectionReason }, tx);

    if (!isAttachmentContentType(attachment.contentType)) {
      return rejected(AttachmentRejectionReason.TypeMismatch);
    }
    const processed = await processAttachment(bytes, attachment.contentType);
    if (!processed.ok) return rejected(processed.reason);

    await attachmentStore.putObject(attachment.storageKey, processed.bytes);
    return settle(
      attachment.id,
      {
        status: AttachmentStatus.Ready,
        contentType: processed.contentType,
        size: processed.bytes.length,
      },
      tx
    );
  });

/** The original name, with the extension corrected for images the processor rewrote to JPEG. */
export const downloadFileName = (attachment: Pick<AttachmentType, "fileName" | "contentType">) => {
  if (attachment.contentType !== "image/jpeg") return attachment.fileName;
  const base = attachment.fileName.replace(/\.(png|webp|jpe?g|heic|heif)$/i, "");
  return `${base}.jpg`;
};
