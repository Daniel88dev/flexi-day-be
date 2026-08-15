import { db, type DbTransaction } from "../../db/db.js";
import { organizations } from "../../db/schema/organization-schema.js";
import { eq } from "drizzle-orm";
import { getUserById } from "../user/userServices.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import AppError from "../../utils/appError.js";
import type { OrganizationType } from "./types.js";

export const getOrganizationById = async (
  organizationId: string,
  tx?: DbTransaction
): Promise<OrganizationType | undefined> => {
  const [row] = await (tx ?? db)
    .select()
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);

  return row;
};

export const getOrganizationForOwner = async (
  ownerUserId: string,
  tx?: DbTransaction
): Promise<OrganizationType | undefined> => {
  const [row] = await (tx ?? db)
    .select()
    .from(organizations)
    .where(eq(organizations.ownerUserId, ownerUserId))
    .limit(1);

  return row;
};

/**
 * Lazily creates the user's organization on first need (group creation).
 * Users with no groups get no row. Safe under concurrency: the unique index
 * on `owner_user_id` makes the insert a no-op for the loser, who re-selects.
 */
export const ensureOrganizationForUser = async (
  userId: string,
  tx?: DbTransaction
): Promise<OrganizationType> => {
  const existing = await getOrganizationForOwner(userId, tx);
  if (existing) return existing;

  const owner = await getUserById(userId, tx);
  if (!owner) {
    throw new AppError({
      message: "User not found",
      logging: true,
      code: 404,
      context: { userId },
    });
  }

  const [created] = await (tx ?? db)
    .insert(organizations)
    .values({
      id: generateRandomUUID(),
      name: owner.name,
      ownerUserId: userId,
      billingEmail: owner.email,
    })
    .onConflictDoNothing({ target: organizations.ownerUserId })
    .returning();

  if (created) return created;

  const raced = await getOrganizationForOwner(userId, tx);
  if (!raced) {
    throw new AppError({
      message: "Failed to create organization",
      logging: true,
      code: 500,
      context: { userId },
    });
  }
  return raced;
};

export const setOrganizationPaddleCustomerId = async (
  organizationId: string,
  paddleCustomerId: string,
  tx?: DbTransaction
): Promise<OrganizationType | undefined> => {
  const [row] = await (tx ?? db)
    .update(organizations)
    .set({ paddleCustomerId })
    .where(eq(organizations.id, organizationId))
    .returning();

  return row;
};

/**
 * Row-locks the organization for the rest of the transaction. The group cap is
 * a plain `count(*)`, so without this two concurrent creates both see the
 * pre-insert count and both succeed, leaving the org permanently over its plan.
 */
export const lockOrganization = async (
  organizationId: string,
  tx: DbTransaction
): Promise<void> => {
  const [row] = await tx
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .for("update");

  // `FOR UPDATE` matching no row locks nothing and returns silently, which
  // would quietly turn every caller's count-then-act back into a race.
  if (!row) {
    throw new AppError({
      message: "Organization not found",
      logging: true,
      code: 500,
      context: { organizationId },
    });
  }
};
