import {
  date,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const bankHolidays = pgTable(
  "bank_holidays",
  {
    id: text("id").primaryKey(),
    date: date("date").notNull(),
    name: text("name").notNull(),
    country: text("country").notNull(),
    region: text("region"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index("bank_holidays_country_idx").on(table.country),
    index("bank_holidays_date_idx").on(table.date),
    uniqueIndex("bank_holidays_country_region_date_uidx").on(
      table.country,
      table.region,
      table.date
    ),
  ]
);
