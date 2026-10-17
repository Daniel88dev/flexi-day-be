import { pgEnum, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { session } from "./auth-schema.js";
import { enumToPgEnum } from "../../utils/enumToPgEnum.js";

/** Which APNs host a token belongs to: a debug build's tokens only work on the sandbox. */
export enum pushEnvironment {
  Sandbox = "sandbox",
  Production = "production",
}

export const pushEnvironmentEnum = pgEnum("push_environment", enumToPgEnum(pushEnvironment));

/**
 * One phone's APNs token, bound to the Native session that registered it.
 * ADR 0006: the row goes when its session row goes, by cascade.
 */
export const pushRegistrations = pgTable("push_registrations", {
  sessionId: text("session_id")
    .primaryKey()
    .references(() => session.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  environment: pushEnvironmentEnum("environment").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
});
