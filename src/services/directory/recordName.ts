import { sql } from "drizzle-orm";
import { alias, type AnyPgColumn } from "drizzle-orm/pg-core";
import { user } from "../../db/schema/auth-schema.js";
import { employments } from "../../db/schema/employment-schema.js";
import { personName, type PersonColumns } from "../person/personName.js";
import { boundEmployment } from "../employment/boundEmployment.js";

/**
 * The name a record shows: the account's while it is bound, open and not
 * deleted, otherwise the Employment's own copy, which Card writers may edit.
 */
export const recordName = (
  employment: Record<"userId" | "endedAt" | "accountDeletedAt" | "name", AnyPgColumn>,
  person: PersonColumns,
  organizationId: string
) => sql<string>`case
  when ${boundEmployment(employment)} then ${personName(person, { organizationId })}
  else coalesce(${employment.name}, ${personName(person, { organizationId })}, '') end`;

/** The record a profile reports to, joined as these aliases. */
export const reportsTo = alias(employments, "reports_to");
export const reportsToUser = alias(user, "reports_to_user");

export const reportsToName = (organizationId: string) =>
  sql<
    string | null
  >`case when ${reportsTo.id} is null then null else ${recordName(reportsTo, reportsToUser, organizationId)} end`;
