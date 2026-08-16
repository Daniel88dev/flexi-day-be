import { Router } from "express";
import { tryCatch } from "../middleware/tryCatch.js";
import { bodyValidationMiddleware } from "../middleware/validationMiddleware.js";
import {
  validateChangePlan,
  validatePatchSlots,
  validatePostCheckout,
} from "../services/billing/types.js";
import { handleGetSubscription } from "../controllers/billing/handleGetSubscription.js";
import { handlePostCheckout } from "../controllers/billing/handlePostCheckout.js";
import { handlePostPortal } from "../controllers/billing/handlePostPortal.js";
import { handlePatchSlots } from "../controllers/billing/handlePatchSlots.js";
import { handlePostChangePlan } from "../controllers/billing/handlePostChangePlan.js";

export const billingRouter = (): Router => {
  const app = Router();

  /**
   * @openapi
   * /api/billing/subscription:
   *   get:
   *     tags:
   *       - Billing
   *     summary: Current subscription, entitlements and usage
   *     description: |
   *       Returns the caller's organization (owner-resolved from the session,
   *       never from the request), its subscription row if any, the resolved
   *       entitlements (plan, group/member limits, writability, grace end) and
   *       usage meters. Callers who own no organization yet get Free
   *       entitlements with empty usage.
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       '200':
   *         description: Subscription state, entitlements, usage counts
   */
  app.get("/subscription", tryCatch(handleGetSubscription));

  /**
   * @openapi
   * /api/billing/checkout:
   *   post:
   *     tags:
   *       - Billing
   *     summary: Create a Paddle checkout transaction
   *     description: |
   *       Creates a Paddle transaction for the requested plan and returns its
   *       id for the Paddle.js overlay. Prices and the organization id are
   *       resolved server-side only. 409 when an active subscription already
   *       exists (use change-plan), 503 when billing is not configured.
   *     security:
   *       - bearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - plan
   *               - billingCycle
   *             properties:
   *               plan:
   *                 type: string
   *                 enum: [PRO, ENTERPRISE]
   *               billingCycle:
   *                 type: string
   *                 enum: [MONTHLY, YEARLY]
   *               extraGroupSlots:
   *                 type: integer
   *                 minimum: 0
   *                 maximum: 20
   *     responses:
   *       '201':
   *         description: The Paddle transaction id to open the overlay with
   *       '409':
   *         description: Organization already has an active subscription
   *       '422':
   *         description: Extra slots exceed the plan's allowance
   *       '503':
   *         description: Billing not configured on this environment
   */
  app.post(
    "/checkout",
    bodyValidationMiddleware(validatePostCheckout),
    tryCatch(handlePostCheckout)
  );

  /**
   * @openapi
   * /api/billing/portal:
   *   post:
   *     tags:
   *       - Billing
   *     summary: Create a Paddle customer portal session
   *     description: |
   *       Returns a customer-portal URL where the owner manages the payment
   *       method, invoices and cancellation. 404 until a first checkout has
   *       created the Paddle customer.
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       '200':
   *         description: The portal URL
   *       '404':
   *         description: No billing account yet
   *       '503':
   *         description: Billing not configured on this environment
   */
  app.post("/portal", tryCatch(handlePostPortal));

  /**
   * @openapi
   * /api/billing/slots:
   *   patch:
   *     tags:
   *       - Billing
   *     summary: Change the extra group slot quantity
   *     description: |
   *       Updates the extra-group-slot line on the existing subscription. The
   *       new quantity applies immediately in both directions; an increase is
   *       charged straight away, a decrease is credited pro rata at the next
   *       billing period. Capped by the plan's `maxExtraSlots`.
   *     security:
   *       - bearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - extraGroupSlots
   *             properties:
   *               extraGroupSlots:
   *                 type: integer
   *                 minimum: 0
   *                 maximum: 20
   *     responses:
   *       '200':
   *         description: The new slot quantity
   *       '409':
   *         description: No active subscription to modify
   *       '422':
   *         description: Requested slots exceed the plan's allowance
   *       '503':
   *         description: Billing not configured on this environment
   */
  app.patch("/slots", bodyValidationMiddleware(validatePatchSlots), tryCatch(handlePatchSlots));

  /**
   * @openapi
   * /api/billing/change-plan:
   *   post:
   *     tags:
   *       - Billing
   *     summary: Switch plan or billing cycle
   *     description: |
   *       Pro ⇄ Enterprise and monthly ⇄ yearly on the existing subscription,
   *       prorated immediately. Extra slots are kept, clamped to the new
   *       plan's allowance.
   *     security:
   *       - bearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - plan
   *               - billingCycle
   *             properties:
   *               plan:
   *                 type: string
   *                 enum: [PRO, ENTERPRISE]
   *               billingCycle:
   *                 type: string
   *                 enum: [MONTHLY, YEARLY]
   *     responses:
   *       '200':
   *         description: The new plan state
   *       '409':
   *         description: No active subscription to modify
   *       '503':
   *         description: Billing not configured on this environment
   */
  app.post(
    "/change-plan",
    bodyValidationMiddleware(validateChangePlan),
    tryCatch(handlePostChangePlan)
  );

  return app;
};
