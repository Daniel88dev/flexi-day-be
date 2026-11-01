import { isNull, notExists, sql, type SQL } from "drizzle-orm";
import { db } from "../db/db.js";
import { schema } from "../db/schema/index.js";

/** Fixture for `noRealDatabase.test.ts`. Stands in for an ordinary service module. */

export const runSelect = async (): Promise<unknown> => db.select().from(schema.groups).limit(1);

export const runTransaction = async (): Promise<unknown> => db.transaction(async () => undefined);

// Built once at import and never executed, the way the attachment retention service
// builds its retention fragment.
export const composedAtImport: SQL = notExists(
  db
    .select({ one: sql`1` })
    .from(schema.groups)
    .where(isNull(schema.groups.deletedAt))
);

export const runWithSelect = async (): Promise<unknown> =>
  db
    .with(db.$with("live").as(db.select().from(schema.groups)))
    .select()
    .from(schema.groups)
    .limit(1);

export const runRelationalQuery = async (): Promise<unknown> =>
  db.query.groups.findMany({ limit: 1 });
