import type { Request, Response } from "express";
import { EventName, type SubscriptionNotification } from "@paddle/paddle-node-sdk";
import AppError from "../../utils/appError.js";
import { requirePaddle } from "../../utils/paddle.js";
import { derivePlanFromItems } from "../../services/billing/paddleCatalog.js";
import { subscriptionStatus } from "../../db/schema/subscription-schema.js";
import type { SubscriptionPatch } from "../../services/billing/types.js";
import { notifySubscriptionGrace } from "../../services/billing/billingNotifier.js";
import { logger } from "../../middleware/logger.js";
import { db, type DbTransaction } from "../../db/db.js";
import type { OrganizationType } from "../../services/organization/types.js";
import {
  getOrganizationById,
  lockOrganization,
  setOrganizationPaddleCustomerId,
} from "../../services/organization/organizationServices.js";
import {
  getSubscriptionByPaddleId,
  getSubscriptionForOrganization,
  recordPaddleEvent,
  upsertSubscription,
} from "../../services/billing/subscriptionServices.js";

export const GRACE_PERIOD_DAYS = 14;

const graceEnd = (from: Date): Date =>
  new Date(from.getTime() + GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000);

const STATUS_MAP: Record<string, subscriptionStatus> = {
  active: subscriptionStatus.Active,
  trialing: subscriptionStatus.Trialing,
  past_due: subscriptionStatus.PastDue,
  paused: subscriptionStatus.Paused,
  canceled: subscriptionStatus.Canceled,
};

const LAPSED_STATUSES = new Set([
  subscriptionStatus.PastDue,
  subscriptionStatus.Paused,
  subscriptionStatus.Canceled,
]);

/** A grace email to send once the transaction has committed. */
type PendingGraceEmail = { organization: OrganizationType; plan: string; graceEndsAt: Date };

/**
 * `custom_data.organizationId` is stamped on the checkout transaction and
 * inherited by the subscription; older events fall back to the stored
 * subscription row. Returns undefined for foreign subscriptions, which are
 * acknowledged and ignored.
 */
const resolveOrganizationId = async (
  data: SubscriptionNotification,
  tx: DbTransaction
): Promise<string | undefined> => {
  const custom = (data.customData as { organizationId?: unknown } | null)?.organizationId;
  if (typeof custom === "string" && custom.length > 0) {
    const organization = await getOrganizationById(custom, tx);
    if (organization) return organization.id;
  }
  const existing = await getSubscriptionByPaddleId(data.id, tx);
  return existing?.organizationId;
};

const syncSubscriptionFromEvent = async (
  data: SubscriptionNotification,
  occurredAt: Date | null,
  tx: DbTransaction
): Promise<PendingGraceEmail | null> => {
  const organizationId = await resolveOrganizationId(data, tx);
  if (!organizationId) {
    logger.warn("paddle webhook: subscription without a resolvable organization", {
      paddleSubscriptionId: data.id,
    });
    return null;
  }

  // Serialise webhook processing per organization before reading `existing`.
  // Both guards below are check-then-act on that read, and Paddle can deliver
  // two events for the same subscription concurrently — without this, a late
  // `past_due` re-arms grace on top of an `active` that just committed.
  await lockOrganization(organizationId, tx);

  const existing = await getSubscriptionForOrganization(organizationId, tx);

  // Paddle does not guarantee delivery order, and a retry can land an old
  // event after a newer one. Applying it would resurrect stale state — e.g. a
  // late `past_due` re-arming grace for a customer who has already paid.
  // Strictly older only: `Date` truncates Paddle's microsecond `occurred_at`
  // to milliseconds, and Paddle emits paired events (created + activated,
  // updated + canceled) that can share a millisecond. `<=` would drop the
  // second half of every such pair.
  if (occurredAt && existing?.lastEventAt && occurredAt < existing.lastEventAt) {
    logger.info("paddle webhook: discarding out-of-order event", {
      organizationId,
      paddleSubscriptionId: data.id,
      occurredAt: occurredAt.toISOString(),
      lastEventAt: existing.lastEventAt.toISOString(),
    });
    return null;
  }

  // An org keeps exactly one subscription row, so an event for a *different*
  // Paddle subscription must not clobber a live one — otherwise cancelling a
  // previously paused subscription wipes the replacement the org just bought.
  const status = STATUS_MAP[data.status];
  if (
    existing?.paddleSubscriptionId &&
    existing.paddleSubscriptionId !== data.id &&
    (existing.status === subscriptionStatus.Active ||
      existing.status === subscriptionStatus.Trialing) &&
    status !== subscriptionStatus.Active &&
    status !== subscriptionStatus.Trialing
  ) {
    logger.warn("paddle webhook: ignoring event for a superseded subscription", {
      organizationId,
      incoming: data.id,
      current: existing.paddleSubscriptionId,
    });
    return null;
  }

  const derived = derivePlanFromItems(
    requirePaddle().paddleConfig.prices,
    data.items.map((item) => ({ priceId: item.price?.id, quantity: item.quantity }))
  );

  const patch: SubscriptionPatch = {
    paddleSubscriptionId: data.id,
    paddleCustomerId: data.customerId,
    ...(status ? { status } : {}),
    ...(derived ?? {}),
    currentPeriodEnd: data.currentBillingPeriod?.endsAt
      ? new Date(data.currentBillingPeriod.endsAt)
      : null,
    cancelAt:
      data.scheduledChange?.action === "cancel" && data.scheduledChange.effectiveAt
        ? new Date(data.scheduledChange.effectiveAt)
        : null,
    ...(occurredAt ? { lastEventAt: occurredAt } : {}),
  };

  let startedGrace: Date | null = null;
  if (status === subscriptionStatus.Active || status === subscriptionStatus.Trialing) {
    patch.graceEndsAt = null;
  } else if (status && LAPSED_STATUSES.has(status) && !existing?.graceEndsAt) {
    startedGrace = graceEnd(new Date());
    patch.graceEndsAt = startedGrace;
  }

  const organization = await getOrganizationById(organizationId, tx);

  // The organization UPDATE runs BEFORE the subscription upsert on purpose.
  // Inserting a subscription takes a FK share lock on the organization row;
  // upgrading that to exclusive afterwards is the classic Postgres lock-upgrade
  // deadlock against a concurrent `lockOrganization` in assertCanCreateGroup.
  if (organization && !organization.paddleCustomerId) {
    await setOrganizationPaddleCustomerId(organizationId, data.customerId, tx);
  }

  await upsertSubscription(organizationId, patch, tx);

  if (startedGrace && organization) {
    return {
      organization,
      plan: derived?.plan ?? existing?.plan ?? "PRO",
      graceEndsAt: startedGrace,
    };
  }
  return null;
};

/** Payment failed on a transaction tied to a subscription: start grace early. */
const handlePaymentFailed = async (
  paddleSubscriptionId: string | null,
  tx: DbTransaction
): Promise<PendingGraceEmail | null> => {
  if (!paddleSubscriptionId) return null;
  const found = await getSubscriptionByPaddleId(paddleSubscriptionId, tx);
  if (!found) return null;

  // Same check-then-act on `graceEndsAt`: two concurrent payment_failed events
  // would otherwise both read null and both send a grace email.
  await lockOrganization(found.organizationId, tx);
  const existing = await getSubscriptionForOrganization(found.organizationId, tx);
  if (!existing || existing.graceEndsAt) return null;

  // Paddle retries a failed delivery, and the payment can succeed before the
  // retry lands. Arming grace off a stale `payment_failed` would email a
  // customer who has already paid — unlike syncSubscriptionFromEvent, this
  // event carries no subscription status of its own to order against.
  if (
    existing.status === subscriptionStatus.Active ||
    existing.status === subscriptionStatus.Trialing
  ) {
    logger.info("paddle webhook: ignoring payment_failed for an active subscription", {
      organizationId: existing.organizationId,
      paddleSubscriptionId,
    });
    return null;
  }

  const endsAt = graceEnd(new Date());
  await upsertSubscription(existing.organizationId, { graceEndsAt: endsAt }, tx);

  const organization = await getOrganizationById(existing.organizationId, tx);
  if (!organization) return null;
  return { organization, plan: existing.plan ?? "PRO", graceEndsAt: endsAt };
};

/**
 * Paddle webhook receiver. MUST be mounted with `express.raw()` and before the
 * global JSON parser — signature verification needs the exact raw bytes.
 * Everything that parses and verifies answers 200, including duplicates and
 * events we ignore: a non-2xx makes Paddle retry a poison event indefinitely.
 */
export const handlePaddleWebhook = async (req: Request, res: Response) => {
  const { paddle, paddleConfig } = requirePaddle();

  const signature = req.headers["paddle-signature"];
  if (typeof signature !== "string" || signature.length === 0) {
    throw new AppError({ message: "Missing Paddle-Signature header", logging: true, code: 400 });
  }

  const rawBody = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : undefined;
  if (!rawBody) {
    throw new AppError({ message: "Missing raw webhook body", logging: true, code: 400 });
  }

  let event;
  try {
    event = await paddle.webhooks.unmarshal(rawBody, paddleConfig.webhookSecret, signature);
  } catch (error) {
    throw new AppError({
      message: "Invalid webhook signature",
      logging: true,
      code: 400,
      cause: error,
    });
  }

  const occurredAt = event.occurredAt ? new Date(event.occurredAt) : null;

  // The idempotency record and the state change share one transaction: if
  // processing throws, the event id rolls back with it and Paddle's retry
  // reprocesses instead of being swallowed as a duplicate.
  const { duplicate, graceEmail } = await db.transaction(async (tx) => {
    const firstDelivery = await recordPaddleEvent(event.eventId, event.eventType, tx);
    if (!firstDelivery) return { duplicate: true, graceEmail: null };

    let pending: PendingGraceEmail | null = null;

    switch (event.eventType) {
      case EventName.SubscriptionCreated:
      case EventName.SubscriptionUpdated:
      case EventName.SubscriptionActivated:
      case EventName.SubscriptionTrialing:
      case EventName.SubscriptionPastDue:
      case EventName.SubscriptionPaused:
      case EventName.SubscriptionResumed:
      case EventName.SubscriptionCanceled:
        pending = await syncSubscriptionFromEvent(event.data, occurredAt, tx);
        break;
      case EventName.TransactionPaymentFailed: {
        const data = event.data as { subscriptionId: string | null };
        pending = await handlePaymentFailed(data.subscriptionId, tx);
        break;
      }
      case EventName.TransactionCompleted:
        // Subscription state arrives via subscription.* events; nothing to do
        // beyond the idempotency record.
        break;
      default:
        logger.info("paddle webhook: ignoring event type", { eventType: event.eventType });
        break;
    }

    return { duplicate: false, graceEmail: pending };
  });

  if (duplicate) {
    return res.status(200).json({ received: true, duplicate: true });
  }

  // Post-commit and best-effort: the notifier logs its own failures, so a mail
  // problem never turns a committed state change into a Paddle retry.
  if (graceEmail) {
    await notifySubscriptionGrace(graceEmail.organization, graceEmail.plan, graceEmail.graceEndsAt);
  }

  return res.status(200).json({ received: true });
};
