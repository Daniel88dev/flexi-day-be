import { sql } from "drizzle-orm";
import { index, integer, pgEnum, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { user } from "./auth-schema.js";
import { directoryAudienceEnum } from "./directory-schema.js";
import { employments } from "./employment-schema.js";
import { organizations } from "./organization-schema.js";
import { enumToPgEnum } from "../../utils/enumToPgEnum.js";

export enum directoryPhotoStatus {
  Uploading = "UPLOADING",
  Ready = "READY",
  Rejected = "REJECTED",
}

export const directoryPhotoStatusEnum = pgEnum(
  "directory_photo_status",
  enumToPgEnum(directoryPhotoStatus)
);

/**
 * One upload of an Employment's Profile photo. The row exists as `UPLOADING`
 * before its bytes do (docs/adr/0003). At most one row per Employment is
 * `READY`: that one is the Profile photo. Its two JPEGs live in the
 * organization-data store under `photos/<organizationId>/<employmentId>/<id>/`.
 * `uploadedByUserId` and `audience` wait here for the profile history row
 * written when the photo settles.
 */
export const directoryPhotos = pgTable(
  "directory_photos",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    employmentId: text("employment_id")
      .notNull()
      .references(() => employments.id, { onDelete: "cascade" }),
    status: directoryPhotoStatusEnum("status").notNull().default(directoryPhotoStatus.Uploading),
    rejectionReason: text("rejection_reason"),
    contentType: text("content_type").notNull(),
    size: integer("size").notNull(),
    uploadedByUserId: text("uploaded_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    audience: directoryAudienceEnum("audience").notNull(),
    readyAt: timestamp("ready_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("uq_directory_photos_ready_employment")
      .on(table.employmentId)
      .where(sql`${table.status} = 'READY'`),
    index("idx_directory_photos_employment").on(table.employmentId),
    index("idx_directory_photos_organization").on(table.organizationId),
  ]
);
