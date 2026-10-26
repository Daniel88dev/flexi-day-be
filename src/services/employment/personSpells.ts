import { and, asc, eq, isNull, or, sql, type SQL } from "drizzle-orm";
import { db, type DbTransaction } from "../../db/db.js";
import { employments } from "../../db/schema/employment-schema.js";

export type SpellIdentity = { userId: string | null; email: string | null };

/**
 * Employments of the same person as `spell`: the same user, or the same email
 * when either spell has no account. Undefined when nothing can match.
 */
export const samePersonAs = (spell: SpellIdentity): SQL | undefined => {
  const sameEmail =
    spell.email === null ? undefined : sql`lower(${employments.email}) = lower(${spell.email})`;
  if (spell.userId === null) return sameEmail;
  const sameUser = eq(employments.userId, spell.userId);
  return sameEmail === undefined
    ? sameUser
    : or(sameUser, and(isNull(employments.userId), sameEmail));
};

/**
 * Every spell of one person in the organization, oldest first: the subject's
 * own spells and every spell `samePersonAs` links to one of them. One hop, so
 * a link never chains through a third person.
 */
export const personSpellIds = async (
  organizationId: string,
  subject: { userId: string } | { employmentId: string },
  tx?: DbTransaction
): Promise<string[]> => {
  const client = tx ?? db;
  const seeds = await client
    .select({ id: employments.id, userId: employments.userId, email: employments.email })
    .from(employments)
    .where(
      and(
        eq(employments.organizationId, organizationId),
        "userId" in subject
          ? eq(employments.userId, subject.userId)
          : eq(employments.id, subject.employmentId)
      )
    );
  if (seeds.length === 0) return [];
  const rows = await client
    .select({ id: employments.id })
    .from(employments)
    .where(
      and(
        eq(employments.organizationId, organizationId),
        or(...seeds.map((seed) => or(eq(employments.id, seed.id), samePersonAs(seed))))
      )
    )
    .orderBy(asc(employments.startedAt), asc(employments.id));
  return rows.map((row) => row.id);
};
