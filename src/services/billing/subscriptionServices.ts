import { db, type DbTransaction } from "../../db/db.js";
import { subscriptions } from "../../db/schema/subscription-schema.js";
import { paddleEvents } from "../../db/schema/paddle-event-schema.js";
import { eq } from "drizzle-orm";
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
