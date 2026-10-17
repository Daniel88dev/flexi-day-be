import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * At most one row: an HMAC keyed by the Better Auth secret, never the secret
 * itself. The boot check compares it to tell a rotated secret from a restart.
 */
export const authSecretFingerprint = pgTable("auth_secret_fingerprint", {
  fingerprint: text("fingerprint").primaryKey(),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).defaultNow().notNull(),
});
