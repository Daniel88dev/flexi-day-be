import { index, integer, pgEnum, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth-schema.js";
import { organizations } from "./organization-schema.js";
import { enumToPgEnum } from "../../utils/enumToPgEnum.js";

export enum AttachmentStatus {
  Uploading = "UPLOADING",
  Ready = "READY",
  Rejected = "REJECTED",
}

export const attachmentStatusEnum = pgEnum("attachment_status", enumToPgEnum(AttachmentStatus));

/**
 * A file bound to one Request (CONTEXT.md). `requestId` carries no foreign key:
 * a Request is the set of `vacation` rows sharing that id, not a table. The row
 * exists as `UPLOADING` before its bytes do — see docs/adr/0003.
 */
export const attachments = pgTable(
  "attachments",
  {
    id: text("id").primaryKey(),
    requestId: text("request_id").notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    uploadedByUserId: text("uploaded_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    fileName: text("file_name").notNull(),
    contentType: text("content_type").notNull(),
    size: integer("size").notNull(),
    storageKey: text("storage_key").notNull(),
    status: attachmentStatusEnum("status").notNull().default(AttachmentStatus.Uploading),
    rejectionReason: text("rejection_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedByUserId: text("deleted_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
  },
  (table) => [index("attachments_request_id_idx").on(table.requestId)]
);
