import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request } from "express";

const {
  mockUnmarshal,
  mockRecordPaddleEvent,
  mockUpsertSubscription,
  mockGetSubForOrg,
  mockGetSubByPaddleId,
  mockGetOrgById,
  mockSetCustomerId,
  mockNotifyGrace,
} = vi.hoisted(() => ({
  mockUnmarshal: vi.fn(),
  mockRecordPaddleEvent: vi.fn(),
  mockUpsertSubscription: vi.fn(),
  mockGetSubForOrg: vi.fn(),
  mockGetSubByPaddleId: vi.fn(),
  mockGetOrgById: vi.fn(),
  mockSetCustomerId: vi.fn(),
  mockNotifyGrace: vi.fn(),
}));

const PRICES = {
  proMonthly: "pri_pro_m",
  proYearly: "pri_pro_y",
  enterpriseMonthly: "pri_ent_m",
  enterpriseYearly: "pri_ent_y",
  extraGroupMonthly: "pri_slot_m",
  extraGroupYearly: "pri_slot_y",
};

vi.mock("../../../utils/paddle.js", () => ({
  requirePaddle: () => ({
    paddle: { webhooks: { unmarshal: mockUnmarshal } },
    paddleConfig: {
      apiKey: "key",
      webhookSecret: "whsec_test",
      environment: "sandbox",
      prices: PRICES,
    },
  }),
}));

vi.mock("../../../services/DBServices.js", () => ({
  createDBServices: () => ({
    billing: {
      recordPaddleEvent: mockRecordPaddleEvent,
      upsertSubscription: mockUpsertSubscription,
      getSubscriptionForOrganization: mockGetSubForOrg,
      getSubscriptionByPaddleId: mockGetSubByPaddleId,
    },
    organization: {
      getOrganizationById: mockGetOrgById,
      setOrganizationPaddleCustomerId: mockSetCustomerId,
    },
  }),
}));

vi.mock("../../../services/billing/billingNotifier.js", () => ({
  notifySubscriptionGrace: mockNotifyGrace,
}));

// Serialises webhook processing per organization; behaviour is covered by the
// e2e suite against a real database.
vi.mock("../../../services/organization/organizationServices.js", () => ({
  lockOrganization: vi.fn(),
}));

// The handler wraps the idempotency record and the state change in one
// transaction; the callback runs against this stand-in.
vi.mock("../../../db/db.js", () => ({
  db: { transaction: (cb: (tx: unknown) => unknown) => cb({}) },
}));

import { handlePaddleWebhook } from "../handlePaddleWebhook.js";
import { makeReqRes } from "../../../tests/testUtils.js";

const ORG = {
  id: "org-1",
  name: "Dana Holt",
  ownerUserId: "user-1",
  billingEmail: "dana@northwind.co",
  paddleCustomerId: null,
};

const OCCURRED_AT = "2026-08-11T12:00:00.000Z";

const subscriptionData = (overrides: Record<string, unknown> = {}) => ({
  id: "psub-1",
  status: "active",
  customerId: "ctm-1",
  customData: { organizationId: "org-1" },
  items: [
    { price: { id: PRICES.proMonthly }, quantity: 1 },
    { price: { id: PRICES.extraGroupMonthly }, quantity: 2 },
  ],
  currentBillingPeriod: { startsAt: "2026-08-11T00:00:00Z", endsAt: "2026-09-11T00:00:00Z" },
  scheduledChange: null,
  ...overrides,
});

const makeWebhookReq = (signature: string | null = "ts=1;h1=abc") => {
  const { req, res } = makeReqRes({ body: Buffer.from("{}") });
  (req as unknown as { headers: Record<string, unknown> }).headers = signature
    ? { "paddle-signature": signature }
    : {};
  return { req: req as Request, res };
};

describe("handlePaddleWebhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRecordPaddleEvent.mockResolvedValue(true);
    mockGetSubForOrg.mockResolvedValue(undefined);
    mockGetOrgById.mockResolvedValue(ORG);
    mockUpsertSubscription.mockResolvedValue({ id: "sub-row-1" });
  });

  it("400s without a Paddle-Signature header", async () => {
    const { req, res } = makeWebhookReq(null);
    await expect(handlePaddleWebhook(req, res)).rejects.toMatchObject({ code: 400 });
    expect(mockUnmarshal).not.toHaveBeenCalled();
  });

  it("400s when signature verification fails", async () => {
    mockUnmarshal.mockRejectedValue(new Error("bad signature"));
    const { req, res } = makeWebhookReq();
    await expect(handlePaddleWebhook(req, res)).rejects.toMatchObject({ code: 400 });
    expect(mockRecordPaddleEvent).not.toHaveBeenCalled();
  });

  it("answers 200 and skips processing on a replayed event id", async () => {
    mockUnmarshal.mockResolvedValue({
      eventId: "evt-1",
      occurredAt: OCCURRED_AT,
      eventType: "subscription.updated",
      data: subscriptionData(),
    });
    mockRecordPaddleEvent.mockResolvedValue(false);

    const { req, res } = makeWebhookReq();
    await handlePaddleWebhook(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockUpsertSubscription).not.toHaveBeenCalled();
  });

  it("syncs plan, cycle and slots from the items on subscription.created", async () => {
    mockUnmarshal.mockResolvedValue({
      eventId: "evt-2",
      occurredAt: OCCURRED_AT,
      eventType: "subscription.created",
      data: subscriptionData(),
    });

    const { req, res } = makeWebhookReq();
    await handlePaddleWebhook(req, res);

    expect(mockUpsertSubscription).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({
        paddleSubscriptionId: "psub-1",
        paddleCustomerId: "ctm-1",
        status: "active",
        plan: "PRO",
        billingCycle: "MONTHLY",
        extraGroupSlots: 2,
        graceEndsAt: null,
      }),
      {}
    );
    expect(mockSetCustomerId).toHaveBeenCalledWith("org-1", "ctm-1", {});
    expect(mockNotifyGrace).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("starts grace and emails on subscription.canceled", async () => {
    mockUnmarshal.mockResolvedValue({
      eventId: "evt-3",
      occurredAt: OCCURRED_AT,
      eventType: "subscription.canceled",
      data: subscriptionData({ status: "canceled" }),
    });

    const { req, res } = makeWebhookReq();
    await handlePaddleWebhook(req, res);

    const patch = mockUpsertSubscription.mock.calls[0]?.[1] as { graceEndsAt: Date };
    expect(patch.graceEndsAt).toBeInstanceOf(Date);
    expect(patch.graceEndsAt.getTime()).toBeGreaterThan(Date.now() + 13 * 24 * 60 * 60 * 1000);
    expect(mockNotifyGrace).toHaveBeenCalledWith(ORG, "PRO", patch.graceEndsAt);
  });

  it("does not restart grace when one is already running", async () => {
    mockGetSubForOrg.mockResolvedValue({ graceEndsAt: new Date(), plan: "PRO" });
    mockUnmarshal.mockResolvedValue({
      eventId: "evt-4",
      occurredAt: OCCURRED_AT,
      eventType: "subscription.past_due",
      data: subscriptionData({ status: "past_due" }),
    });

    const { req, res } = makeWebhookReq();
    await handlePaddleWebhook(req, res);

    const patch = mockUpsertSubscription.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(patch.graceEndsAt).toBeUndefined();
    expect(mockNotifyGrace).not.toHaveBeenCalled();
  });

  it("clears grace when the subscription is active again", async () => {
    mockGetSubForOrg.mockResolvedValue({ graceEndsAt: new Date(), plan: "PRO" });
    mockUnmarshal.mockResolvedValue({
      eventId: "evt-5",
      occurredAt: OCCURRED_AT,
      eventType: "subscription.updated",
      data: subscriptionData({ status: "active" }),
    });

    const { req, res } = makeWebhookReq();
    await handlePaddleWebhook(req, res);

    expect(mockUpsertSubscription).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({ graceEndsAt: null }),
      {}
    );
  });

  it("falls back to the stored row when custom data names no organization", async () => {
    mockGetOrgById.mockResolvedValueOnce(undefined);
    mockGetSubByPaddleId.mockResolvedValue({ organizationId: "org-1", graceEndsAt: null });
    mockGetOrgById.mockResolvedValue(ORG);
    mockUnmarshal.mockResolvedValue({
      eventId: "evt-6",
      occurredAt: OCCURRED_AT,
      eventType: "subscription.updated",
      data: subscriptionData({ customData: null }),
    });

    const { req, res } = makeWebhookReq();
    await handlePaddleWebhook(req, res);

    expect(mockGetSubByPaddleId).toHaveBeenCalledWith("psub-1", {});
    expect(mockUpsertSubscription).toHaveBeenCalledWith("org-1", expect.anything(), {});
  });

  it("acknowledges a foreign subscription without writing anything", async () => {
    mockGetOrgById.mockResolvedValue(undefined);
    mockGetSubByPaddleId.mockResolvedValue(undefined);
    mockUnmarshal.mockResolvedValue({
      eventId: "evt-7",
      occurredAt: OCCURRED_AT,
      eventType: "subscription.updated",
      data: subscriptionData({ customData: null }),
    });

    const { req, res } = makeWebhookReq();
    await handlePaddleWebhook(req, res);

    expect(mockUpsertSubscription).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("starts grace on transaction.payment_failed for a known subscription", async () => {
    mockGetSubByPaddleId.mockResolvedValue({
      organizationId: "org-1",
      plan: "PRO",
      graceEndsAt: null,
    });
    // Re-read under the org lock before the check-then-act on graceEndsAt.
    mockGetSubForOrg.mockResolvedValue({
      organizationId: "org-1",
      plan: "PRO",
      graceEndsAt: null,
    });
    mockUnmarshal.mockResolvedValue({
      eventId: "evt-8",
      occurredAt: OCCURRED_AT,
      eventType: "transaction.payment_failed",
      data: { subscriptionId: "psub-1" },
    });

    const { req, res } = makeWebhookReq();
    await handlePaddleWebhook(req, res);

    expect(mockUpsertSubscription).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({ graceEndsAt: expect.any(Date) }),
      {}
    );
    expect(mockNotifyGrace).toHaveBeenCalled();
  });

  it("ignores payment_failed when grace is already running", async () => {
    mockGetSubByPaddleId.mockResolvedValue({
      organizationId: "org-1",
      plan: "PRO",
      graceEndsAt: new Date(),
    });
    mockUnmarshal.mockResolvedValue({
      eventId: "evt-9",
      occurredAt: OCCURRED_AT,
      eventType: "transaction.payment_failed",
      data: { subscriptionId: "psub-1" },
    });

    const { req, res } = makeWebhookReq();
    await handlePaddleWebhook(req, res);

    expect(mockUpsertSubscription).not.toHaveBeenCalled();
    expect(mockNotifyGrace).not.toHaveBeenCalled();
  });

  it("rolls the idempotency record back when processing throws", async () => {
    // The record and the state change share one transaction, so a failure must
    // not leave the event marked as seen — Paddle's retry has to reprocess it.
    mockUnmarshal.mockResolvedValue({
      eventId: "evt-boom",
      occurredAt: OCCURRED_AT,
      eventType: "subscription.canceled",
      data: subscriptionData({ status: "canceled" }),
    });
    mockUpsertSubscription.mockRejectedValue(new Error("deadlock detected"));

    const { req, res } = makeWebhookReq();
    await expect(handlePaddleWebhook(req, res)).rejects.toThrow("deadlock detected");

    // The insert happened inside the same transaction that just rejected.
    expect(mockRecordPaddleEvent).toHaveBeenCalledWith("evt-boom", "subscription.canceled", {});
    expect(mockNotifyGrace).not.toHaveBeenCalled();
  });

  it("discards an event older than the last one applied", async () => {
    mockGetSubForOrg.mockResolvedValue({
      plan: "PRO",
      graceEndsAt: null,
      lastEventAt: new Date("2026-08-11T13:00:00.000Z"),
    });
    mockUnmarshal.mockResolvedValue({
      eventId: "evt-late",
      occurredAt: "2026-08-11T12:00:00.000Z",
      eventType: "subscription.past_due",
      data: subscriptionData({ status: "past_due" }),
    });

    const { req, res } = makeWebhookReq();
    await handlePaddleWebhook(req, res);

    // A late past_due must not re-arm grace for a customer who already paid.
    expect(mockUpsertSubscription).not.toHaveBeenCalled();
    expect(mockNotifyGrace).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("ignores a cancellation for a superseded subscription", async () => {
    mockGetSubForOrg.mockResolvedValue({
      paddleSubscriptionId: "psub-NEW",
      status: "active",
      plan: "PRO",
      graceEndsAt: null,
      lastEventAt: null,
    });
    mockUnmarshal.mockResolvedValue({
      eventId: "evt-old-cancel",
      occurredAt: OCCURRED_AT,
      eventType: "subscription.canceled",
      data: subscriptionData({ id: "psub-OLD", status: "canceled" }),
    });

    const { req, res } = makeWebhookReq();
    await handlePaddleWebhook(req, res);

    // Cancelling the replaced subscription must not wipe the live one.
    expect(mockUpsertSubscription).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("records lastEventAt so ordering can be enforced next time", async () => {
    mockUnmarshal.mockResolvedValue({
      eventId: "evt-order",
      occurredAt: OCCURRED_AT,
      eventType: "subscription.updated",
      data: subscriptionData(),
    });

    const { req, res } = makeWebhookReq();
    await handlePaddleWebhook(req, res);

    expect(mockUpsertSubscription).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({ lastEventAt: new Date(OCCURRED_AT) }),
      {}
    );
  });

  it("answers 200 for event types it does not handle", async () => {
    mockUnmarshal.mockResolvedValue({
      eventId: "evt-10",
      occurredAt: OCCURRED_AT,
      eventType: "product.updated",
      data: {},
    });

    const { req, res } = makeWebhookReq();
    await handlePaddleWebhook(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockUpsertSubscription).not.toHaveBeenCalled();
  });
});
