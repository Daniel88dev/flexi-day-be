import { index, pgEnum, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth-schema.js";
import { vacation } from "./vacation-schema.js";
import { enumToPgEnum } from "../../utils/enumToPgEnum.js";

/**
 * What happened to a vacation row. The vacation table only keeps the current
 * state (`approvedAt`, `rejectedAt`, `deletedAt`), which cannot answer "who
 * cancelled this and when" once a later transition overwrites it — these rows
 * are the append-only record the request timeline is built from.
 */
export enum vacationEventType {
  Created = "CREATED",
  Approved = "APPROVED",
  Rejected = "REJECTED",
  Cancelled = "CANCELLED",
  Comment = "COMMENT",
  Updated = "UPDATED",
}

export const vacationEventTypeEnum = pgEnum("vacation_event_type", enumToPgEnum(vacationEventType));

export const vacationEvents = pgTable(
  "vacation_events",
  {
    id: text("id").primaryKey(),
    vacationId: text("vacation_id")
      .notNull()
      .references(() => vacation.id, { onDelete: "cascade" }),
    eventType: vacationEventTypeEnum("event_type").notNull(),
    // Null when the actor's account is later removed; the event itself stays.
    actorUserId: text("actor_user_id").references(() => user.id, { onDelete: "set null" }),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("vacation_events_vacation_id_idx").on(table.vacationId, table.createdAt)]
);
