import { and, eq, isNull, sql } from "drizzle-orm";
import type { DbTransaction } from "../../db/db.js";
import { user } from "../../db/schema/auth-schema.js";
import { employments } from "../../db/schema/employment-schema.js";
import { refuse } from "../../utils/appError.js";
import { findOpenAccountlessEmployment, lockEmploymentEmail } from "./accountlessClash.js";
import { getOpenEmployment } from "./employmentServices.js";

export const ALREADY_EMPLOYED = "ALREADY_EMPLOYED";

export type Claim = { employmentId: string; organizationId: string };

/**
 * The Claim: binds the account to an open account-less Employment of the
 * organization. A directory invite names its Employment; any other invite
 * claims the one holding the invited address, if there is one. Writes the
 * account's name and email over the copy, which then follows the account.
 * Refused with 409 `ALREADY_EMPLOYED` when the account already has an open
 * Employment there: the admin resolves the duplicate. Never plan-gated and
 * independent of the directory toggle. The caller holds the organization lock.
 */
export const claimEmployment = async (
  input: {
    organizationId: string;
    userId: string;
    /** The invited address, lower-cased; the account's own address. */
    email: string;
    targetEmploymentId: string | null;
  },
  tx: DbTransaction
): Promise<Claim | null> => {
  const { organizationId, userId, email } = input;
  const context = { organizationId, userId, employmentId: input.targetEmploymentId };
  await lockEmploymentEmail(organizationId, email, tx);

  let employmentId: string;
  if (input.targetEmploymentId !== null) {
    const [target] = await tx
      .select({ id: employments.id, userId: employments.userId, endedAt: employments.endedAt })
      .from(employments)
      .where(
        and(
          eq(employments.id, input.targetEmploymentId),
          eq(employments.organizationId, organizationId),
          sql`lower(${employments.email}) = ${email}`
        )
      )
      .for("update");
    if (!target || target.userId !== null || target.endedAt !== null) {
      throw refuse(410, "INVITE_REVOKED", "This invite is revoked", context);
    }
    employmentId = target.id;
  } else {
    const match = await findOpenAccountlessEmployment(organizationId, email, tx);
    if (!match) return null;
    employmentId = match.id;
  }

  if (await getOpenEmployment(organizationId, userId, tx)) {
    throw refuse(
      409,
      ALREADY_EMPLOYED,
      "You already belong to this organization under another record. Ask its admin to resolve the duplicate.",
      { ...context, employmentId }
    );
  }

  const [account] = await tx
    .select({ name: user.name, email: user.email })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  await tx
    .update(employments)
    .set({ userId, name: account!.name, email: account!.email, updatedAt: new Date() })
    .where(
      and(eq(employments.id, employmentId), isNull(employments.userId), isNull(employments.endedAt))
    );
  return { employmentId, organizationId };
};
