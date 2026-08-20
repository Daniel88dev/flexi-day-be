import { date, index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { isNull } from "drizzle-orm";

export const bankHolidays = pgTable(
  "bank_holidays",
  {
    id: text("id").primaryKey(),
    date: date("date").notNull(),
    name: text("name").notNull(),
    country: text("country").notNull(),
    region: text("region"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
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
    // The index above never fires for NULL regions (Postgres treats NULLs as
    // distinct), yet the dataset fill writes exactly those rows — without this
    // partial index, concurrent first fills would duplicate every holiday.
    uniqueIndex("bank_holidays_country_date_no_region_uidx")
      .on(table.country, table.date)
      .where(isNull(table.region)),
  ]
);
