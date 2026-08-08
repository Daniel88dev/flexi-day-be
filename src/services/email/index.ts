import { config } from "../../config.js";
import type { EmailSender } from "./emailSender.js";
import { sesEmailSender } from "./sesEmailSender.js";
import { logEmailSender } from "./logEmailSender.js";
import { suppressUndeliverable } from "./suppressUndeliverable.js";

export type {
  EmailSender,
  EmailTemplateName,
  TemplatedEmail,
  EmailConfirmationData,
  VacationApprovalRequestData,
  VacationApprovedData,
  VacationCancelledData,
  VacationRejectedData,
  VacationCommentData,
  GroupInviteData,
} from "./emailSender.js";

/**
 * The active email sender. Tests use the log-only sender so they never hit
 * AWS; every other environment uses the real SES adapter. Both are wrapped so
 * recipients at reserved domains — the seeded `@dev.local` accounts above all
 * — are dropped rather than bounced off SES.
 */
export const emailSender: EmailSender = suppressUndeliverable(
  config.api.env === "test" ? logEmailSender : sesEmailSender
);
