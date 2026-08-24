import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { requirePaddle } from "../../utils/paddle.js";
import AppError from "../../utils/appError.js";
import { getSubscriptionForOrganization } from "../../services/billing/subscriptionServices.js";
import { getOrganizationForOwner } from "../../services/organization/organizationServices.js";

/** Returns a Paddle customer-portal URL for managing the payment method. */
export const handlePostPortal = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const { paddle } = requirePaddle();

  const organization = await getOrganizationForOwner(auth.userId);
  if (!organization?.paddleCustomerId) {
    throw new AppError({
      message: "No billing account yet — subscribe first",
      logging: true,
      code: 404,
      context: { userId: auth.userId },
    });
  }

  const subscription = await getSubscriptionForOrganization(organization.id);

  const session = await paddle.customerPortalSessions.create(
    organization.paddleCustomerId,
    subscription?.paddleSubscriptionId ? [subscription.paddleSubscriptionId] : []
  );

  return res.status(200).json({ url: session.urls.general.overview });
};
