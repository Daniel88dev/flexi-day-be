import { integer, pgEnum, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { organizations } from "./organization-schema.js";
import { enumToPgEnum } from "../../utils/enumToPgEnum.js";

export enum dataKeyWrapping {
  Kms = "kms",
  Local = "local",
}

export const dataKeyWrappingEnum = pgEnum("data_key_wrapping", enumToPgEnum(dataKeyWrapping));

/**
 * The organization's data key for Sensitive section fields, only ever stored
 * wrapped. The cascade is the guarantee that deleting the organization deletes
 * the key in the same transaction, which leaves its ciphertext in backups
 * unreadable. `docs/field-encryption.md` has the rest.
 */
export const organizationDataKeys = pgTable("organization_data_keys", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  version: integer("version").notNull().default(1),
  wrapping: dataKeyWrappingEnum("wrapping").notNull(),
  wrappedKey: text("wrapped_key").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  rotatedAt: timestamp("rotated_at", { withTimezone: true }),
});
