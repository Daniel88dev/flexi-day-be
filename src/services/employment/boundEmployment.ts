import { sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { employments } from "../../db/schema/employment-schema.js";

type BoundColumns<T> = { userId: T; endedAt: T; accountDeletedAt: T };

/**
 * A bound Employment: open, holding an account that was not deleted. Its
 * account speaks for the record, so the name follows the account and the
 * person may hold Directory roles. Each entry pairs a column with whether it
 * must be null; the SQL and TS forms below both read it.
 */
const bound = <T>(record: BoundColumns<T>) =>
  [
    [record.userId, false],
    [record.endedAt, true],
    [record.accountDeletedAt, true],
  ] as const;

export const boundEmployment = (employment: BoundColumns<AnyPgColumn> = employments) =>
  sql`(${sql.join(
    bound(employment).map(([column, mustBeNull]) =>
      mustBeNull ? sql`${column} is null` : sql`${column} is not null`
    ),
    sql` and `
  )})`;

export const isBoundEmployment = (record: BoundColumns<string | Date | null>) =>
  bound(record).every(([value, mustBeNull]) => (value === null) === mustBeNull);
