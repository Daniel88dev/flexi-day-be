import {
  pgTable,
  text,
  timestamp,
  date,
  index,
  uniqueIndex,
  time,
  pgEnum,
} from "drizzle-orm/pg-core";
import { user } from "./auth-schema.js";
import { groups } from "./group-schema.js";
import { enumToPgEnum } from "../../utils/enumToPgEnum.js";

export enum vacationType {
  Vacation = "VACATION",
  HomeOffice = "HOME_OFFICE",
  Sick = "SICK",
  BankHoliday = "BANK_HOLIDAY",
  NonPaidLeave = "NON_PAID_LEAVE",
  PaidTimeOff = "PAID_TIME_OFF",
  SickLeave = "SICK_LEAVE",
  StudyLeave = "STUDY_LEAVE",
  Other = "OTHER",
}

export const vacationEnum = pgEnum("vacation_type", enumToPgEnum(vacationType));

export const vacation = pgTable(
  "vacation",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    requestedDay: date("requested_day").notNull(),
    startTime: time("start_time"),
    endTime: time("end_time"),
    vacationType: vacationEnum("vacation_type")
      .notNull()
      .default(vacationType.Vacation),
    approvedAt: timestamp("approved_at"),
    approvedBy: text("approved_by").references(() => user.id, {
      onDelete: "set null",
    }),
    deletedAt: timestamp("deleted_at"),
    rejectedAt: timestamp("rejected_at"),
    rejectedBy: text("rejected_by").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index("requested_day_idx").on(table.requestedDay),
    uniqueIndex("uniq_vacation_user_day").on(table.userId, table.requestedDay),
  ]
);
