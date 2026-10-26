import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { db, type DbTransaction } from "../../db/db.js";
import { employments } from "../../db/schema/employment-schema.js";
import { refuse } from "../../utils/appError.js";

export const ACCOUNTLESS_EMPLOYMENT_EMAIL = "ACCOUNTLESS_EMPLOYMENT_EMAIL";

/**
 * Serializes every write that decides whether an email is free among an
 * organization's open Employments. Whatever creates an account-less Employment
 * takes this lock before its own check, so it and a join path cannot both find
 * the address free.
 */
export const lockEmploymentEmail = async (
  organizationId: string,
  email: string,
  tx: DbTransaction | typeof db
): Promise<void> => {
  const key = `employment-email:${organizationId}:${email.trim().toLowerCase()}`;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
};

/** The open account-less Employment in the organization that holds this email, if any. */
export const findOpenAccountlessEmployment = async (
  organizationId: string,
  email: string,
  tx?: DbTransaction
): Promise<{ id: string } | undefined> => {
  const [row] = await (tx ?? db)
    .select({ id: employments.id })
    .from(employments)
    .where(
      and(
        eq(employments.organizationId, organizationId),
        isNull(employments.userId),
        isNull(employments.endedAt),
        sql`lower(${employments.email}) = ${email.trim().toLowerCase()}`
      )
    )
    .limit(1);
  return row;
};

/**
 * Refuses to open an Employment for an account whose email an open account-less
 * Employment in the organization already holds. Only a directory invite binds
 * the two, so a join path must not quietly create a second record of the
 * person. The caller holds {@link lockEmploymentEmail} for the address.
 */
export const assertNoAccountlessClash = async (
  organizationId: string,
  email: string,
  context: { userId: string },
  tx?: DbTransaction
): Promise<void> => {
  const clash = await findOpenAccountlessEmployment(organizationId, email, tx);
  if (!clash) return;

  throw refuse(
    409,
    ACCOUNTLESS_EMPLOYMENT_EMAIL,
    "This email belongs to a person in the organization's directory who has no account yet. Send them a directory invite or erase that record, then try again.",
    { organizationId, ...context, employmentId: clash.id }
  );
};

export const EMPLOYMENT_EMAIL_TAKEN = "EMPLOYMENT_EMAIL_TAKEN";

/**
 * Refuses an address an open Employment of the organization already holds,
 * bound or not, ignoring case: 409 `EMPLOYMENT_EMAIL_TAKEN`. For whatever
 * gives an account-less Employment its email. Takes {@link lockEmploymentEmail}
 * itself; `exceptEmploymentId` is the record being edited.
 */
export const assertEmploymentEmailFree = async (
  organizationId: string,
  email: string,
  context: Record<string, unknown>,
  tx: DbTransaction,
  exceptEmploymentId?: string
): Promise<void> => {
  await lockEmploymentEmail(organizationId, email, tx);
  const [held] = await tx
    .select({ id: employments.id })
    .from(employments)
    .where(
      and(
        eq(employments.organizationId, organizationId),
        isNull(employments.endedAt),
        sql`lower(${employments.email}) = ${email.trim().toLowerCase()}`,
        exceptEmploymentId === undefined ? undefined : ne(employments.id, exceptEmploymentId)
      )
    )
    .limit(1);
  if (held) {
    throw refuse(
      409,
      EMPLOYMENT_EMAIL_TAKEN,
      "Another open Employment in the organization holds this email",
      context
    );
  }
};
