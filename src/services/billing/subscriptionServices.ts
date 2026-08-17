import { db, type DbTransaction } from "../../db/db.js";
import { subscriptions } from "../../db/schema/subscription-schema.js";
import { paddleEvents } from "../../db/schema/paddle-event-schema.js";
import { eq, inArray } from "drizzle-orm";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import type { Subscription, SubscriptionPatch } from "./types.js";

export const getSubscriptionForOrganization = async (
  organizationId: string,
  tx?: DbTransaction
): Promise<Subscription | undefined> => {
  const [row] = await (tx ?? db)
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.organizationId, organizationId))
    .limit(1);

  return row;
};

/** Bulk variant for the per-group organization badge — one query, not one per group. */
export const getSubscriptionsForOrganizations = async (
  organizationIds: string[],
  tx?: DbTransaction
): Promise<Subscription[]> => {
  if (organizationIds.length === 0) return [];
  return (tx ?? db)
    .select()
    .from(subscriptions)
    .where(inArray(subscriptions.organizationId, organizationIds));
};

export const getSubscriptionByPaddleId = async (
  paddleSubscriptionId: string,
  tx?: DbTransaction
): Promise<Subscription | undefined> => {
  const [row] = await (tx ?? db)
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.paddleSubscriptionId, paddleSubscriptionId))
    .limit(1);

  return row;
};

/**
 * One row per organization (unique index) — always an upsert, so webhook
 * events arriving in any order converge on the same row.
 */
export const upsertSubscription = async (
  organizationId: string,
  patch: SubscriptionPatch,
  tx?: DbTransaction
): Promise<Subscription | undefined> => {
  // Drizzle rejects an empty `set`, and an empty patch has nothing to write
  // anyway — but the row must still exist afterwards, so fall back to a plain
  // insert that no-ops on conflict.
  if (Object.keys(patch).length === 0) {
    await (tx ?? db)
      .insert(subscriptions)
      .values({ id: generateRandomUUID(), organizationId })
      .onConflictDoNothing({ target: subscriptions.organizationId });

    return getSubscriptionForOrganization(organizationId, tx);
  }

  const [row] = await (tx ?? db)
    .insert(subscriptions)
    .values({ id: generateRandomUUID(), organizationId, ...patch })
    .onConflictDoUpdate({
      target: subscriptions.organizationId,
      set: patch,
    })
    .returning();

  return row;
};

/**
 * Idempotency gate for the webhook: returns false when the event id was seen
 * before, in which case the caller must answer 200 without reprocessing.
 */
export const recordPaddleEvent = async (
  eventId: string,
  eventType: string,
  tx?: DbTransaction
): Promise<boolean> => {
  const [row] = await (tx ?? db)
    .insert(paddleEvents)
    .values({ eventId, eventType })
    .onConflictDoNothing()
    .returning();

  return Boolean(row);
};
