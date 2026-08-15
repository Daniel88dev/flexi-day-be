import { emailSender } from "../email/index.js";
import { logger } from "../../middleware/logger.js";
import { config } from "../../config.js";
import type { OrganizationType } from "../organization/types.js";

/**
 * Best-effort grace email to the organization's billing address. Swallows and
 * logs its own errors — a mail failure must never fail webhook processing,
 * which would make Paddle retry the event. Transactional billing mail, so it
 * deliberately ignores `user_settings.emailNotifications`.
 */
export const notifySubscriptionGrace = async (
  organization: OrganizationType,
  planName: string,
  graceEndsAt: Date
): Promise<void> => {
  try {
    await emailSender.sendTemplated({
      to: organization.billingEmail,
      template: "subscription-grace",
      data: {
        recipientName: organization.name,
        planName,
        graceEndsDate: graceEndsAt.toLocaleDateString("en-GB", {
          day: "numeric",
          month: "long",
          year: "numeric",
          timeZone: "UTC",
        }),
        billingUrl: `${config.email.appUrl}/billing/`,
      },
    });
  } catch (error) {
    logger.error("subscription grace email failed", {
      organizationId: organization.id,
      error,
    });
  }
};
