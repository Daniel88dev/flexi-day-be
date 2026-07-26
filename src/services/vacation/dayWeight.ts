import { sql, type SQL } from "drizzle-orm";
import { vacation } from "../../db/schema/vacation-schema.js";

/**
 * How much one vacation row counts against an allowance. Every aggregation
 * that reports "days used" must go through here — the dashboard balance
 * widget and the report would otherwise disagree about the same person.
 */
export const dayWeight = (): SQL<number> =>
  sql<number>`(CASE WHEN ${vacation.halfDay} THEN 0.5 ELSE 1 END)`;

/** Weighted day total over the rows matching `predicate`. */
export const sumDaysWhere = (predicate: SQL): SQL<number> =>
  sql<number>`COALESCE(SUM(${dayWeight()}) FILTER (WHERE ${predicate}), 0)`;

/** Same as `sumDaysWhere` but over every row in the group. */
export const sumDays = (): SQL<number> => sql<number>`COALESCE(SUM(${dayWeight()}), 0)`;
